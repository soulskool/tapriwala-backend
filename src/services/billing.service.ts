import { Types } from 'mongoose';

import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
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
  type IBillingExportLine,
} from '../models/index.js';
import type { ConsolidatedBill, ConsolidatedLine } from '../types/common.js';
import { ApiError } from '../utils/ApiError.js';
import { minutesSince, round2 } from '../utils/helpers.js';
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
    total: round2(subtotal + tax),
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
}

export async function listExports(
  filter: ListExportsFilter,
  skip: number,
  limit: number,
): Promise<{ items: unknown[]; total: number }> {
  const query: Record<string, unknown> = {};
  if (filter.status) query.exportStatus = filter.status;
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
