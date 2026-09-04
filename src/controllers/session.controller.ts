import { ORDER_SOURCE, type SessionStatus } from '../config/constants.js';
import * as orderService from '../services/order.service.js';
import * as sessionService from '../services/session.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendPaginated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { getPagination } from '../utils/pagination.js';
import { queryBool, queryDate } from '../utils/helpers.js';

/** POST /sessions — waiter opens (or re-enters) a table. */
export const open = asyncHandler(async (req, res) => {
  const { tableId, guestCount } = req.body as { tableId: string; guestCount?: number };

  const { session, created } = await sessionService.open({
    tableId,
    actor: getActor(req),
    source: ORDER_SOURCE.WAITER,
    ...(guestCount !== undefined ? { guestCount } : {}),
    ip: req.ip ?? null,
  });

  // Tapping an already-occupied table is normal — return the running session
  // rather than an error, so the waiter lands straight in "add to order".
  if (!created) {
    return sendSuccess(res, session, `Table ${session.tableCode} already has a running order`);
  }
  return sendCreated(res, session, `Table ${session.tableCode} opened`);
});

/** GET /sessions — history / filtered list. */
export const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);

  const { items, total } = await sessionService.list(
    {
      status: req.query.status as SessionStatus | undefined,
      tableId: req.query.tableId as string | undefined,
      activeOnly: queryBool(req.query.activeOnly),
      from: queryDate(req.query.from),
      to: queryDate(req.query.to),
    },
    skip,
    limit,
  );

  return sendPaginated(res, items, page, limit, total);
});

/** GET /sessions/:id — full detail: rounds, items, requests, totals. */
export const getDetail = asyncHandler(async (req, res) => {
  return sendSuccess(res, await sessionService.getDetail(req.params.id as string));
});

/** GET /sessions/:id/rounds */
export const getRounds = asyncHandler(async (req, res) => {
  const rounds = await orderService.getRoundsForSession(req.params.id as string);
  return sendSuccess(res, rounds);
});

/** POST /sessions/:id/close — billing only. */
export const close = asyncHandler(async (req, res) => {
  const { billingExportId, note, force } = req.body as {
    billingExportId?: string;
    note?: string;
    force?: boolean;
  };

  const session = await sessionService.close({
    sessionId: req.params.id as string,
    actor: getActor(req),
    ...(billingExportId !== undefined ? { billingExportId } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(force !== undefined ? { force } : {}),
    ip: req.ip ?? null,
  });

  return sendSuccess(res, session, `Table ${session.tableCode} is now free`);
});

/** POST /sessions/:id/transfer — admin/billing move a session to another table. */
export const transfer = asyncHandler(async (req, res) => {
  const { toTableId, reason } = req.body as { toTableId: string; reason: string };

  const session = await sessionService.transfer({
    sessionId: req.params.id as string,
    toTableId,
    reason,
    actor: getActor(req),
    ip: req.ip ?? null,
  });

  return sendSuccess(res, session, `Session moved to ${session.tableCode}`);
});

/** PATCH /sessions/:id/review — hold/release for manager review. */
export const setReview = asyncHandler(async (req, res) => {
  const { heldForReview, note } = req.body as { heldForReview: boolean; note?: string };

  const session = await sessionService.setReviewHold({
    sessionId: req.params.id as string,
    heldForReview,
    ...(note !== undefined ? { note } : {}),
    actor: getActor(req),
  });

  return sendSuccess(
    res,
    session,
    heldForReview ? 'Session held for manager review' : 'Review hold cleared',
  );
});
