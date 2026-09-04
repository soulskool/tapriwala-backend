import type { ExportMethod, ExportStatus } from '../config/constants.js';
import * as billingService from '../services/billing.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendPaginated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { getPagination } from '../utils/pagination.js';
import { queryDate } from '../utils/helpers.js';

/** GET /billing/queue — tables waiting to be billed, longest first. */
export const queue = asyncHandler(async (_req, res) => {
  const sessions = await billingService.getBillingQueue();
  return sendSuccess(res, { sessions, count: sessions.length });
});

/**
 * GET /billing/:sessionId/consolidate — the counter screen.
 *
 * Read-only: computes the merged bill without writing anything, so staff can
 * open it as often as they like while the table is still ordering.
 */
export const consolidate = asyncHandler(async (req, res) => {
  const bill = await billingService.consolidate(req.params.sessionId as string);
  return sendSuccess(res, bill);
});

/** GET /billing/:sessionId/csv — download the consolidated bill as CSV. */
export const downloadCsv = asyncHandler(async (req, res) => {
  const bill = await billingService.consolidate(req.params.sessionId as string);
  const csv = billingService.toCsv(bill);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="bill-${bill.tableCode}-${bill.sessionNumber}.csv"`,
  );
  return res.send(csv);
});

/** POST /billing/:sessionId/export — freeze the bill and hand it to the POS. */
export const exportBill = asyncHandler(async (req, res) => {
  const { method, note } = req.body as { method?: ExportMethod; note?: string };

  const result = await billingService.exportBill({
    sessionId: req.params.sessionId as string,
    ...(method !== undefined ? { method } : {}),
    ...(note !== undefined ? { note } : {}),
    actor: getActor(req),
    ip: req.ip ?? null,
  });

  // A failed hand-off is reported in the payload, not as an HTTP error: staff
  // must still be able to print and take payment while the POS link is down.
  return sendCreated(
    res,
    result,
    result.export.exportStatus === 'failed'
      ? `Bill ${result.export.billNumber} created, but the POS hand-off failed. Enter manually and confirm.`
      : `Bill ${result.export.billNumber} ready`,
  );
});

/** POST /billing/exports/:id/retry */
export const retryExport = asyncHandler(async (req, res) => {
  const { method } = req.body as { method?: ExportMethod };
  const record = await billingService.retryExport(
    req.params.id as string,
    getActor(req),
    method,
  );
  return sendSuccess(res, record, `Retry ${record.exportStatus}`);
});

/** PATCH /billing/exports/:id — record the POS invoice number / outcome. */
export const confirmExport = asyncHandler(async (req, res) => {
  const { exportStatus, posReferenceId, error, note } = req.body as {
    exportStatus: ExportStatus;
    posReferenceId?: string;
    error?: string;
    note?: string;
  };

  const record = await billingService.confirmExport({
    exportId: req.params.id as string,
    exportStatus,
    ...(posReferenceId !== undefined ? { posReferenceId } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(note !== undefined ? { note } : {}),
    actor: getActor(req),
  });

  return sendSuccess(res, record, `Bill ${record.billNumber} marked ${record.exportStatus}`);
});

/** GET /billing/exports */
export const listExports = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);

  const { items, total } = await billingService.listExports(
    {
      status: req.query.status as ExportStatus | undefined,
      sessionId: req.query.sessionId as string | undefined,
      from: queryDate(req.query.from),
      to: queryDate(req.query.to),
    },
    skip,
    limit,
  );

  return sendPaginated(res, items, page, limit, total);
});

/** GET /billing/exports/:id */
export const getExport = asyncHandler(async (req, res) => {
  return sendSuccess(res, await billingService.getExportOrThrow(req.params.id as string));
});
