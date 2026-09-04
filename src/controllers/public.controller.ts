import { HTTP_STATUS, ORDER_SOURCE, type ServiceRequestType } from '../config/constants.js';
import * as orderService from '../services/order.service.js';
import * as productService from '../services/product.service.js';
import * as serviceRequestService from '../services/serviceRequest.service.js';
import * as sessionService from '../services/session.service.js';
import * as tableService from '../services/table.service.js';
import type { OrderItemInput } from '../types/common.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { minutesSince } from '../utils/helpers.js';

/**
 * Customer QR flow — no login anywhere in this file.
 *
 * `resolveTableCode` middleware has already bound the request to exactly one
 * table before any handler here runs, so a customer at M2 can only ever read
 * and write M2. The code is not a secret — see the TableMaster model — but it
 * is still the only thing that decides which table a request touches.
 */

/** GET /public/tables/:tableCode — landing screen: table, live session, warnings. */
export const resolveTable = asyncHandler(async (req, res) => {
  const result = await tableService.resolveQr(req.customer!.tableCode);
  return sendSuccess(res, result);
});

/** GET /public/tables/:tableCode/menu — available items only, grouped by category. */
export const menu = asyncHandler(async (_req, res) => {
  const categories = await productService.getMenu({ forCustomer: true });
  return sendSuccess(res, { categories });
});

/**
 * POST /public/tables/:tableCode/orders — place an order round.
 *
 * Opens the session on the first order rather than on the scan, so a guest
 * browsing the menu without ordering never occupies a table on the floor grid.
 */
export const placeOrder = asyncHandler(async (req, res) => {
  const { items, idempotencyKey } = req.body as {
    items: OrderItemInput[];
    idempotencyKey?: string;
  };

  const actor = getActor(req);
  const session = await sessionService.ensureForTable(
    req.customer!.tableId,
    actor,
    ORDER_SOURCE.CUSTOMER_QR,
    req.ip ?? null,
  );

  const { round, created } = await orderService.placeRound({
    sessionId: String(session._id),
    items,
    actor,
    source: ORDER_SOURCE.CUSTOMER_QR,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ip: req.ip ?? null,
  });

  const payload = {
    sessionId: String(session._id),
    roundId: String(round._id),
    roundNumber: round.roundNumber,
    kotId: round.kotId,
    status: round.status,
    placedAt: round.placedAt,
    items: round.items.map((item) => ({
      itemId: String(item._id),
      displayName: item.displayName,
      quantity: item.quantity,
      status: item.status,
    })),
    total: round.total,
  };

  if (!created) {
    return sendSuccess(res, payload, 'Your order was already placed', HTTP_STATUS.OK);
  }
  return sendCreated(res, payload, 'Order placed — the kitchen has it');
});

/**
 * GET /public/tables/:tableCode/order-status — live status of this table's order.
 * Sockets push changes; this is the fallback and the on-load fetch.
 */
export const orderStatus = asyncHandler(async (req, res) => {
  const sessionId = req.customer!.sessionId;
  if (!sessionId) {
    return sendSuccess(res, { session: null, rounds: [], totals: null }, 'No active order');
  }

  const detail = await sessionService.getDetail(sessionId);
  const session = detail.session as Record<string, unknown>;
  const rounds = detail.rounds as Record<string, unknown>[];

  // Trimmed to what a customer phone should see — no POS names, no staff notes.
  return sendSuccess(res, {
    session: {
      id: sessionId,
      status: session.status,
      openedAt: session.openedAt,
      billRequestedAt: session.billRequestedAt,
    },
    rounds: rounds.map((round) => ({
      roundNumber: round.roundNumber,
      kotId: round.kotId,
      status: round.status,
      placedAt: round.placedAt,
      elapsedMinutes: round.elapsedMinutes,
      items: (round.items as Record<string, unknown>[]).map((item) => ({
        displayName: item.displayName,
        quantity: item.quantity,
        status: item.status,
        specialInstructions: item.specialInstructions,
      })),
    })),
    totals: detail.totals,
  });
});

/**
 * POST /public/tables/:tableCode/service-requests — water / call staff / bill.
 * Repeat taps bump the existing request instead of spamming the waiter list.
 */
export const raiseServiceRequest = asyncHandler(async (req, res) => {
  const { type, note } = req.body as { type: ServiceRequestType; note?: string };
  const actor = getActor(req);

  let sessionId = req.customer!.sessionId;

  // Asking for the bill with no session at all is a mis-tap, not a bill.
  if (type === 'bill' && !sessionId) {
    throw ApiError.invalidState('There is no running order on this table yet');
  }

  // "Water" before ordering is perfectly normal — open the table for it.
  if (!sessionId) {
    const session = await sessionService.ensureForTable(
      req.customer!.tableId,
      actor,
      ORDER_SOURCE.CUSTOMER_QR,
      req.ip ?? null,
    );
    sessionId = String(session._id);
  }

  const { request, created } = await serviceRequestService.raise({
    tableId: req.customer!.tableId,
    sessionId,
    type,
    ...(note !== undefined ? { note } : {}),
    actor,
    ip: req.ip ?? null,
  });

  const payload = {
    requestId: String(request._id),
    type: request.type,
    status: request.status,
    raisedAt: request.raisedAt,
    repeatCount: request.repeatCount,
    waitingMinutes: minutesSince(request.raisedAt),
  };

  const message =
    request.type === 'bill'
      ? 'Bill requested — a staff member will be with you shortly'
      : created
        ? 'Staff have been notified'
        : 'Staff have been reminded';

  return created ? sendCreated(res, payload, message) : sendSuccess(res, payload, message);
});
