import ExcelJS from 'exceljs';
import { Types } from 'mongoose';

import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  BUSINESS_TIMEZONE,
  BUSINESS_UTC_OFFSET,
  EXPORT_METHOD,
  EXPORT_STATUS,
  ITEM_STATUS,
  ORDER_TYPE,
  ORDER_TYPE_VALUES,
  SESSION_STATUS,
  type ExportMethod,
  type ExportStatus,
  type OrderType,
} from '../config/constants.js';
import {
  BillingExport,
  OrderRound,
  TableSession,
  type BillingExportDocument,
  type IBillingExport,
  type IBillingExportLine,
} from '../models/index.js';
import type { ConsolidatedBill, ConsolidatedLine } from '../types/common.js';
import { ApiError } from '../utils/ApiError.js';
import { minutesSince, round2, roundToRupee } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { actorSnapshot, type Actor } from '../utils/actor.js';
import * as auditService from './audit.service.js';
import * as sessionService from './session.service.js';
import { nextBillNumber } from './counter.service.js';

/**
 * Billing consolidation and POS hand-off.
 *
 * The counter never retypes an order. Everything below is computed from
 * `OrderRound.items` — the same data the kitchen cooked from — so the bill and
 * the tickets can never disagree.
 */

// ─── Consolidation ───────────────────────────────────────────────────────────

/**
 * Rolls every round of a session into one bill, grouped by productCode.
 *
 * The KDS deliberately does NOT merge repeat orders (two teas an hour apart are
 * two separate cooking jobs), but the bill absolutely must: the guest pays for
 * "4 Tea", not for four separate tea lines. Same data, two views.
 *
 * Grouping is by code *and* price, so a round placed before a price change
 * bills at its own snapshotted rate instead of being silently repriced.
 *
 * It is also by order type. A session that drank three teas here and carried a
 * fourth out is two lines, not one — merging them would print a single "4 TEA"
 * under a heading that is wrong about a quarter of it. A session of one type
 * (almost all of them) groups exactly as it did before this existed.
 */
export async function consolidate(sessionId: string): Promise<ConsolidatedBill> {
  const session = await sessionService.getByIdOrThrow(sessionId);
  const rounds = await OrderRound.find({ sessionId: session._id }).sort({ roundNumber: 1 }).lean();

  const billable = new Map<string, ConsolidatedLine>();
  const cancelled = new Map<string, ConsolidatedLine>();
  let itemCount = 0;
  let requiresReview = session.heldForReview;

  for (const round of rounds) {
    // `.lean()` skips the schema default, and rounds older than this field have
    // nothing stored — both mean dining, which is what they were.
    const orderType: OrderType = round.orderType ?? ORDER_TYPE.DINING;

    for (const item of round.items) {
      const isCancelled = item.status === ITEM_STATUS.CANCELLED;
      const bucket = isCancelled ? cancelled : billable;
      const key = `${item.productCode}::${item.unitPrice}::${item.taxPercent}::${orderType}`;

      if (isCancelled && item.cancelledAfterPrep) requiresReview = true;
      if (!isCancelled) itemCount += item.quantity;

      const existing = bucket.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.amount = round2(existing.unitPrice * existing.quantity);
        existing.taxAmount = round2((existing.amount * existing.taxPercent) / 100);
        if (!existing.rounds.includes(round.roundNumber)) existing.rounds.push(round.roundNumber);
        continue;
      }

      const amount = round2(item.unitPrice * item.quantity);
      bucket.set(key, {
        productCode: item.productCode,
        posName: item.posName,
        displayName: item.displayName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxPercent: item.taxPercent,
        amount,
        taxAmount: round2((amount * item.taxPercent) / 100),
        kitchenStation: item.kitchenStation,
        orderType,
        rounds: [round.roundNumber],
      });
    }
  }

  // Dining block first, then parcel, each sorted by code. On a single-type
  // bill this is the old ordering exactly; on a mixed one it keeps the two
  // kinds from interleaving, which is what makes the paper readable.
  const lines = Array.from(billable.values()).sort(
    (a, b) =>
      ORDER_TYPE_VALUES.indexOf(a.orderType) - ORDER_TYPE_VALUES.indexOf(b.orderType) ||
      a.productCode.localeCompare(b.productCode),
  );

  // Only the types actually billed, in ORDER_TYPE_VALUES order. Cancelled lines
  // are excluded deliberately — a parcel that was cancelled must not make the
  // heading claim the guest is carrying something out.
  const billedTypes = new Set(lines.map((line) => line.orderType));
  const orderTypes = ORDER_TYPE_VALUES.filter((type) => billedTypes.has(type));

  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const tax = round2(lines.reduce((sum, line) => sum + line.taxAmount, 0));

  // The owner's rule: the guest pays whole rupees. Rounded here, once, so the
  // counter screen, the paper, the saved bill and the day's sales all carry
  // the same figure instead of each rounding for itself.
  const { total, roundOff } = roundToRupee(subtotal + tax);

  return {
    sessionId: String(session._id),
    tableCode: session.tableCode,
    sessionNumber: session.sessionNumber,
    openedAt: session.openedAt,
    status: session.status,
    lines,
    cancelledLines: Array.from(cancelled.values()),
    subtotal,
    tax,
    total,
    roundOff,
    roundCount: rounds.length,
    itemCount,
    orderTypes,
    requiresReview,
  };
}

/** Sessions waiting at the counter, longest-waiting first. */
export async function getBillingQueue(): Promise<Record<string, unknown>[]> {
  const sessions = await TableSession.find({
    isActive: true,
    status: SESSION_STATUS.BILL_REQUESTED,
  })
    .sort({ billRequestedAt: 1 })
    .lean();

  return sessions.map((session) => ({
    sessionId: String(session._id),
    tableId: String(session.tableId),
    tableCode: session.tableCode,
    sessionNumber: session.sessionNumber,
    openedAt: session.openedAt,
    billRequestedAt: session.billRequestedAt,
    waitingMinutes: minutesSince(session.billRequestedAt),
    runningTotal: session.runningTotal,
    totalRounds: session.totalRounds,
    heldForReview: session.heldForReview,
    reviewNote: session.reviewNote,
  }));
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Phase 1 ships `manual_display`: the counter reads exact product codes and
 * quantities off one screen and types them into the legacy POS — no searching
 * by name, which was the actual pain point.
 *
 * Phase 2 swaps in `api` or `csv` once the POS vendor's capabilities are
 * confirmed. Only `dispatch` below changes; nothing else in the app moves.
 */
// Async by contract: the Phase 2 `api` branch will await a real HTTP call to
// the POS vendor, and every caller already awaits this.
// eslint-disable-next-line @typescript-eslint/require-await
async function dispatch(
  method: ExportMethod,
  bill: ConsolidatedBill,
): Promise<{ status: ExportStatus; error: string | null; payload?: unknown }> {
  switch (method) {
    case EXPORT_METHOD.MANUAL_DISPLAY:
      // Nothing to send — the screen is the integration.
      return { status: EXPORT_STATUS.SENT, error: null };

    case EXPORT_METHOD.CSV:
      return { status: EXPORT_STATUS.SENT, error: null, payload: toCsv(bill) };

    case EXPORT_METHOD.API:
      // Intentionally unimplemented until the vendor's API is confirmed.
      // Failing loudly here is better than pretending a bill was delivered.
      return {
        status: EXPORT_STATUS.FAILED,
        error:
          'Direct POS API integration is not configured yet. Use manual entry or CSV, then confirm the bill.',
      };

    default:
      return { status: EXPORT_STATUS.FAILED, error: `Unknown export method: ${String(method)}` };
  }
}

/** CSV in the shape most legacy POS importers expect: code, name, qty, rate, tax, amount. */
export function toCsv(bill: ConsolidatedBill): string {
  const escape = (value: string | number): string => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const header = [
    'ProductCode',
    'PosName',
    'OrderType',
    'Quantity',
    'UnitPrice',
    'TaxPercent',
    'Amount',
  ];
  const rows = bill.lines.map((line) =>
    [
      line.productCode,
      line.posName,
      line.orderType,
      line.quantity,
      line.unitPrice,
      line.taxPercent,
      line.amount,
    ]
      .map(escape)
      .join(','),
  );

  return [header.join(','), ...rows].join('\n');
}

export interface ExportInput {
  sessionId: string;
  method?: ExportMethod;
  note?: string;
  actor: Actor;
  ip?: string | null;
}

/**
 * Freezes the consolidated bill into a BillingExport and attempts delivery.
 *
 * A failed delivery is recorded, not thrown: billing staff must always be able
 * to print and take payment, and retry the integration afterwards. Blocking a
 * paying customer on POS uptime is never the right trade.
 */
export async function exportBill(input: ExportInput): Promise<{
  export: BillingExportDocument;
  bill: ConsolidatedBill;
  payload?: unknown;
}> {
  const session = await sessionService.getByIdOrThrow(input.sessionId);

  if (session.status === SESSION_STATUS.CLOSED) {
    throw ApiError.invalidState('This session is already closed');
  }

  const bill = await consolidate(input.sessionId);
  if (bill.lines.length === 0) {
    throw ApiError.invalidState(
      'This table has no billable items. Dismiss the bill request instead of generating an empty bill.',
    );
  }

  const method = input.method ?? EXPORT_METHOD.MANUAL_DISPLAY;
  const billNumber = await nextBillNumber();

  const lineItems: IBillingExportLine[] = bill.lines.map((line) => ({
    productCode: line.productCode,
    posName: line.posName,
    // Frozen with the rest of the line. A reprint months later has to say
    // which of these went out of the door, and the rounds it came from may
    // well have been closed and archived by then.
    orderType: line.orderType,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxPercent: line.taxPercent,
    amount: line.amount,
    taxAmount: line.taxAmount,
  }));

  const result = await dispatch(method, bill);

  const record = await BillingExport.create({
    sessionId: session._id,
    tableId: session.tableId,
    tableCode: session.tableCode,
    billNumber,
    generatedAt: new Date(),
    generatedBy: actorSnapshot(input.actor),
    lineItems,
    subtotal: bill.subtotal,
    tax: bill.tax,
    roundOff: bill.roundOff,
    total: bill.total,
    exportMethod: method,
    exportStatus: result.status,
    attempts: 1,
    lastAttemptAt: new Date(),
    lastError: result.error,
    note: input.note ?? '',
  });

  await auditService.record({
    entityType: AUDIT_ENTITY.BILLING_EXPORT,
    entityId: record._id,
    action: AUDIT_ACTION.BILL_EXPORTED,
    actor: input.actor,
    sessionId: session._id,
    tableCode: session.tableCode,
    after: {
      billNumber,
      method,
      status: result.status,
      total: bill.total,
      lineCount: lineItems.length,
    },
    meta: { error: result.error },
    ip: input.ip ?? null,
  });

  if (result.status === EXPORT_STATUS.FAILED) {
    logger.warn(`Bill ${billNumber} for ${session.tableCode} failed to export: ${result.error}`);
  } else {
    logger.info(`Bill ${billNumber} exported for ${session.tableCode} (${method})`, {
      total: bill.total,
    });
  }

  return {
    export: record,
    bill,
    ...(result.payload !== undefined ? { payload: result.payload } : {}),
  };
}

/** Retries a previously failed export without re-freezing the line items. */
export async function retryExport(
  exportId: string,
  actor: Actor,
  method?: ExportMethod,
): Promise<BillingExportDocument> {
  const record = await BillingExport.findById(exportId);
  if (!record) throw ApiError.notFound('Billing export not found');
  if (record.exportStatus === EXPORT_STATUS.CONFIRMED) {
    throw ApiError.invalidState('This bill is already confirmed by the POS');
  }

  const bill = await consolidate(String(record.sessionId));
  const result = await dispatch(method ?? record.exportMethod, bill);

  record.exportMethod = method ?? record.exportMethod;
  record.exportStatus = result.status;
  record.attempts += 1;
  record.lastAttemptAt = new Date();
  record.lastError = result.error;
  await record.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.BILLING_EXPORT,
    entityId: record._id,
    action: AUDIT_ACTION.BILL_EXPORT_RETRIED,
    actor,
    sessionId: record.sessionId,
    tableCode: record.tableCode,
    after: { status: record.exportStatus, attempts: record.attempts },
    meta: { error: result.error },
  });

  return record;
}

/**
 * Records the outcome the counter observed — typically the invoice number the
 * legacy POS printed. That number is what makes our session and their bill
 * reconcilable months later.
 */
export async function confirmExport(input: {
  exportId: string;
  exportStatus: ExportStatus;
  posReferenceId?: string;
  error?: string;
  note?: string;
  actor: Actor;
}): Promise<BillingExportDocument> {
  const record = await BillingExport.findById(input.exportId);
  if (!record) throw ApiError.notFound('Billing export not found');

  const before = { exportStatus: record.exportStatus, posReferenceId: record.posReferenceId };

  record.exportStatus = input.exportStatus;
  if (input.posReferenceId) record.posReferenceId = input.posReferenceId;
  if (input.error) record.lastError = input.error;
  if (input.note) record.note = input.note;
  if (input.exportStatus === EXPORT_STATUS.CONFIRMED) record.confirmedAt = new Date();
  await record.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.BILLING_EXPORT,
    entityId: record._id,
    action: AUDIT_ACTION.BILL_EXPORT_CONFIRMED,
    actor: input.actor,
    sessionId: record.sessionId,
    tableCode: record.tableCode,
    before,
    after: { exportStatus: record.exportStatus, posReferenceId: record.posReferenceId },
  });

  return record;
}

export interface ListExportsFilter {
  status?: ExportStatus;
  sessionId?: string;
  /** "Show me every bill for M2" — the question a waiter actually asks. */
  tableCode?: string;
  from?: Date;
  to?: Date;
  /**
   * Paid or not, as one flag.
   *
   * Deliberately not the same axis as `status`. "Settled" means the counter
   * took the money — `exportStatus === 'confirmed'`. "Unsettled" is every
   * other status at once (sent, pending, failed), which no single `status`
   * value can express, and it is the question an owner actually asks at the
   * end of a shift: what did we bill and never collect?
   */
  settled?: boolean;
}

export async function listExports(
  filter: ListExportsFilter,
  skip: number,
  limit: number,
): Promise<{ items: unknown[]; total: number }> {
  const query: Record<string, unknown> = {};

  // `status` and `settled` both constrain exportStatus, so only one may apply.
  // An explicit status is the more specific request and wins; without one,
  // `settled` splits confirmed from everything else.
  if (filter.status) {
    query.exportStatus = filter.status;
  } else if (filter.settled !== undefined) {
    query.exportStatus = filter.settled
      ? EXPORT_STATUS.CONFIRMED
      : { $ne: EXPORT_STATUS.CONFIRMED };
  }

  if (filter.sessionId) query.sessionId = new Types.ObjectId(filter.sessionId);
  // Stored uppercase by the schema, so match uppercase regardless of input.
  if (filter.tableCode) query.tableCode = filter.tableCode.trim().toUpperCase();
  if (filter.from || filter.to) {
    query.generatedAt = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lte: filter.to } : {}),
    };
  }

  const [items, total] = await Promise.all([
    BillingExport.find(query).sort({ generatedAt: -1 }).skip(skip).limit(limit).lean(),
    BillingExport.countDocuments(query),
  ]);

  return { items, total };
}

export async function getExportOrThrow(exportId: string): Promise<BillingExportDocument> {
  const record = await BillingExport.findById(exportId);
  if (!record) throw ApiError.notFound('Billing export not found');
  return record;
}

// ─── Excel export ────────────────────────────────────────────────────────────

/**
 * Every bill in a range, as a real .xlsx workbook.
 *
 * Two sheets, because the two questions an owner asks need different shapes:
 * "Bills" is one row per bill and answers what was taken and what is still
 * owed; "Line items" is one row per product line and is what you point a pivot
 * table at to find out what actually sells.
 *
 * Unpaginated on purpose. A paginated export would silently hand over the
 * first 25 rows of a month and look complete, which is the one failure mode a
 * financial export must not have. `EXPORT_ROW_CAP` bounds it instead, and the
 * caller is told when the cap was hit rather than being left to guess.
 */
export const EXPORT_ROW_CAP = 5000;

/** Reads as a date in Excel, not as text — sorting and filtering depend on it. */
function excelDate(value: Date | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** What the counter sees on screen, so paper, screen and sheet agree. */
function settlementLabel(status: ExportStatus): string {
  if (status === EXPORT_STATUS.CONFIRMED) return 'Paid';
  if (status === EXPORT_STATUS.FAILED) return 'Failed';
  return 'Not settled';
}

export interface BillsWorkbook {
  buffer: Buffer;
  /** Bills written to the sheet. */
  rowCount: number;
  /** True when more bills matched than the cap allowed — narrow the range. */
  truncated: boolean;
}

export async function buildExportsWorkbook(filter: ListExportsFilter): Promise<BillsWorkbook> {
  const { items, total } = await listExports(filter, 0, EXPORT_ROW_CAP);
  const bills = items as unknown as IBillingExport[];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tapriwala by Treatmeets';
  // Fixed, not `new Date()`: a deterministic workbook means two exports of the
  // same range are byte-identical and diffable.
  workbook.created = filter.to ?? filter.from ?? new Date(0);

  const money = '#,##0.00';
  const stamp = 'dd-mmm-yyyy hh:mm';

  const summary = workbook.addWorksheet('Bills');
  summary.columns = [
    { header: 'Bill No', key: 'billNumber', width: 10 },
    { header: 'Generated', key: 'generatedAt', width: 20, style: { numFmt: stamp } },
    { header: 'Table', key: 'tableCode', width: 8 },
    { header: 'Order type', key: 'orderType', width: 16 },
    { header: 'Items', key: 'itemCount', width: 8 },
    { header: 'Subtotal', key: 'subtotal', width: 12, style: { numFmt: money } },
    { header: 'Tax', key: 'tax', width: 10, style: { numFmt: money } },
    { header: 'Round off', key: 'roundOff', width: 10, style: { numFmt: money } },
    { header: 'Total', key: 'total', width: 12, style: { numFmt: money } },
    { header: 'Settlement', key: 'settlement', width: 13 },
    { header: 'Paid at', key: 'confirmedAt', width: 20, style: { numFmt: stamp } },
    { header: 'Billed by', key: 'generatedBy', width: 18 },
    { header: 'Note', key: 'note', width: 30 },
  ];

  const lines = workbook.addWorksheet('Line items');
  lines.columns = [
    { header: 'Bill No', key: 'billNumber', width: 10 },
    { header: 'Generated', key: 'generatedAt', width: 20, style: { numFmt: stamp } },
    { header: 'Table', key: 'tableCode', width: 8 },
    { header: 'Code', key: 'productCode', width: 12 },
    { header: 'Item', key: 'posName', width: 28 },
    { header: 'Order type', key: 'orderType', width: 12 },
    { header: 'Qty', key: 'quantity', width: 7 },
    { header: 'Rate', key: 'unitPrice', width: 10, style: { numFmt: money } },
    { header: 'Tax %', key: 'taxPercent', width: 8 },
    { header: 'Amount', key: 'amount', width: 12, style: { numFmt: money } },
    { header: 'Tax amount', key: 'taxAmount', width: 12, style: { numFmt: money } },
    { header: 'Settlement', key: 'settlement', width: 13 },
  ];

  for (const sheet of [summary, lines]) {
    sheet.getRow(1).font = { bold: true };
    // The header stays put while an owner scrolls a month of bills.
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };
  }

  for (const bill of bills) {
    const settlement = settlementLabel(bill.exportStatus);
    const lineItems = bill.lineItems ?? [];

    // Distinct types on this bill, dining first — the same summary the receipt
    // prints, rebuilt here because a stored bill has no `orderTypes` field.
    const types = ORDER_TYPE_VALUES.filter((type) =>
      lineItems.some((line) => (line.orderType ?? ORDER_TYPE.DINING) === type),
    );

    summary.addRow({
      billNumber: bill.billNumber,
      generatedAt: excelDate(bill.generatedAt),
      tableCode: bill.tableCode,
      orderType: types.join(' + ') || ORDER_TYPE.DINING,
      itemCount: lineItems.reduce((sum, line) => sum + line.quantity, 0),
      subtotal: bill.subtotal,
      tax: bill.tax,
      // Absent on bills saved before rounding, which had none.
      roundOff: bill.roundOff ?? 0,
      total: bill.total,
      settlement,
      confirmedAt: excelDate(bill.confirmedAt),
      generatedBy: bill.generatedBy?.name ?? '',
      note: bill.note ?? '',
    });

    for (const line of lineItems) {
      lines.addRow({
        billNumber: bill.billNumber,
        generatedAt: excelDate(bill.generatedAt),
        tableCode: bill.tableCode,
        productCode: line.productCode,
        posName: line.posName,
        orderType: line.orderType ?? ORDER_TYPE.DINING,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxPercent: line.taxPercent,
        amount: line.amount,
        taxAmount: line.taxAmount,
        settlement,
      });
    }
  }

  // Totals row, so the number an owner needs is on the sheet rather than
  // something they have to select a column to find.
  if (bills.length > 0) {
    const totalRow = summary.addRow({
      tableCode: 'TOTAL',
      itemCount: bills.reduce(
        (n, b) => n + (b.lineItems ?? []).reduce((m, l) => m + l.quantity, 0),
        0,
      ),
      subtotal: round2(bills.reduce((n, b) => n + b.subtotal, 0)),
      tax: round2(bills.reduce((n, b) => n + b.tax, 0)),
      roundOff: round2(bills.reduce((n, b) => n + (b.roundOff ?? 0), 0)),
      total: round2(bills.reduce((n, b) => n + b.total, 0)),
    });
    totalRow.font = { bold: true };
  }

  /*
   * A capped export says so on the sheet itself.
   *
   * Not in a response header: the frontend is a different origin, so a custom
   * header needs `Access-Control-Expose-Headers` to survive, and a warning
   * that can be dropped in transit is worse than no warning at all. On the
   * sheet it travels with the file — including when it is forwarded to an
   * accountant who never saw the screen it came from.
   */
  if (total > bills.length) {
    const warning = summary.addRow({
      billNumber: 'INCOMPLETE',
      tableCode: `Showing ${bills.length} of ${total} bills. Narrow the date range and export again.`,
    });
    warning.font = { bold: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();

  return {
    buffer: Buffer.from(buffer),
    rowCount: bills.length,
    truncated: total > bills.length,
  };
}

// ─── Day-wise sales ──────────────────────────────────────────────────────────

/** A calendar day in the café's timezone, `YYYY-MM-DD`. */
export type SalesDay = string;

export interface DailySalesRow {
  date: SalesDay;
  bills: number;
  subtotal: number;
  tax: number;
  roundOff: number;
  total: number;
}

export interface DailySalesReport {
  from: SalesDay;
  to: SalesDay;
  timezone: string;
  /** Newest first, one row per day in the range — a day with no bills reads zero. */
  days: DailySalesRow[];
  totals: Omit<DailySalesRow, 'date'>;
}

/** Longest range one request may ask for. A year of rows is still one screen. */
export const SALES_MAX_DAYS = 366;

/** Default range when none is given: the last 30 days, today included. */
const SALES_DEFAULT_DAYS = 30;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today, as the café's calendar has it — not the server's. */
export function salesToday(now = new Date()): SalesDay {
  return dayFormatter.format(now);
}

/**
 * Calendar arithmetic on a `YYYY-MM-DD`. Done at UTC midnight purely as a
 * counting device — no timezone is involved in "the day after the 7th".
 */
export function shiftDay(day: SalesDay, by: number): SalesDay {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/** The instant a café day begins. */
function dayStart(day: SalesDay): Date {
  return new Date(`${day}T00:00:00.000${BUSINESS_UTC_OFFSET}`);
}

/**
 * What the café took, day by day — the owner's end-of-day screen.
 *
 * **Only paid bills count.** A session can leave more than one bill behind:
 * "Update bill" after a late order supersedes the first one, which stays in
 * Billed unpaid (nothing is ever deleted), and a table freed without charging
 * may have had a bill printed for it. Counting every saved bill would book
 * the same table twice and book walk-outs as revenue. `confirmed` is the one
 * status that means the counter took the money.
 *
 * A bill belongs to the day it was **generated**, which is the axis the Billed
 * list and the Excel export already filter on — so this screen and the
 * spreadsheet for the same day always show the same figure. For a café that
 * prints and takes payment in one go the two moments are seconds apart.
 */
export async function dailySales(range: {
  from?: SalesDay;
  to?: SalesDay;
}): Promise<DailySalesReport> {
  const to = range.to ?? salesToday();
  const from = range.from ?? shiftDay(to, -(SALES_DEFAULT_DAYS - 1));

  // Checked here, not in the validator, because the defaults are filled here:
  // `from` alone is legal and means "from then until today".
  if (from > to) {
    throw ApiError.badRequest('The start date is after the end date', [
      { field: 'from', message: 'from must be on or before to' },
    ]);
  }
  if (shiftDay(from, SALES_MAX_DAYS) <= to) {
    throw ApiError.badRequest(`Pick a range of ${SALES_MAX_DAYS} days or fewer`, [
      { field: 'from', message: `The range may span at most ${SALES_MAX_DAYS} days` },
    ]);
  }

  const grouped = await BillingExport.aggregate<DailySalesRow & { _id: SalesDay }>([
    {
      $match: {
        exportStatus: EXPORT_STATUS.CONFIRMED,
        generatedAt: { $gte: dayStart(from), $lt: dayStart(shiftDay(to, 1)) },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$generatedAt', timezone: BUSINESS_TIMEZONE },
        },
        bills: { $sum: 1 },
        subtotal: { $sum: '$subtotal' },
        tax: { $sum: '$tax' },
        // Bills saved before rounding have no field at all.
        roundOff: { $sum: { $ifNull: ['$roundOff', 0] } },
        total: { $sum: '$total' },
      },
    },
  ]);

  const byDay = new Map(grouped.map((row) => [row._id, row]));

  const days: DailySalesRow[] = [];
  for (let day = to; day >= from; day = shiftDay(day, -1)) {
    const row = byDay.get(day);
    days.push({
      date: day,
      bills: row?.bills ?? 0,
      // Summed in Mongo as doubles, so re-rounded here like every other figure.
      subtotal: round2(row?.subtotal ?? 0),
      tax: round2(row?.tax ?? 0),
      roundOff: round2(row?.roundOff ?? 0),
      total: round2(row?.total ?? 0),
    });
  }

  const sum = (pick: (row: DailySalesRow) => number): number =>
    round2(days.reduce((acc, row) => acc + pick(row), 0));

  return {
    from,
    to,
    timezone: BUSINESS_TIMEZONE,
    days,
    totals: {
      bills: days.reduce((acc, row) => acc + row.bills, 0),
      subtotal: sum((row) => row.subtotal),
      tax: sum((row) => row.tax),
      roundOff: sum((row) => row.roundOff),
      total: sum((row) => row.total),
    },
  };
}
