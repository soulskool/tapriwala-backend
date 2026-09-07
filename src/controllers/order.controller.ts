import { HTTP_STATUS, ORDER_SOURCE, type ItemStatus, type OrderType } from '../config/constants.js';
import * as orderService from '../services/order.service.js';
import type { OrderItemInput } from '../types/common.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';

interface PlaceOrderBody {
  items: OrderItemInput[];
  /** Dining or parcel. Absent means dining — see ORDER_TYPE. */
  orderType?: OrderType;
  idempotencyKey?: string;
}

/**
 * POST /sessions/:id/rounds — waiter places an order round.
 *
 * A repeated submission with the same idempotencyKey returns 200 with the
 * original round, so a retry after a dropped connection is safe.
 */
export const placeRound = asyncHandler(async (req, res) => {
  const { items, orderType, idempotencyKey } = req.body as PlaceOrderBody;

  const { round, created } = await orderService.placeRound({
    sessionId: req.params.id as string,
    items,
    actor: getActor(req),
    source: ORDER_SOURCE.WAITER,
    ...(orderType !== undefined ? { orderType } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ip: req.ip ?? null,
  });

  if (!created) {
    return sendSuccess(res, round, `Order already placed (KOT ${round.kotId})`, HTTP_STATUS.OK);
  }
  return sendCreated(res, round, `KOT ${round.kotId} sent to the kitchen`);
});

/** GET /rounds/:roundId */
export const getRound = asyncHandler(async (req, res) => {
  return sendSuccess(res, await orderService.getRoundOrThrow(req.params.roundId as string));
});

/**
 * PATCH /rounds/:roundId/items/:itemId — move one item.
 * Kitchen uses accepted/preparing/ready; waiter marks served; staff cancel.
 */
export const updateItemStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body as { status: ItemStatus; reason?: string };

  const { round, item } = await orderService.updateItemStatus({
    roundId: req.params.roundId as string,
    itemId: req.params.itemId as string,
    status,
    ...(reason !== undefined ? { reason } : {}),
    actor: getActor(req),
    ip: req.ip ?? null,
  });

  return sendSuccess(res, { round, item }, `${item.displayName} marked ${item.status}`);
});

/** PATCH /rounds/:roundId/status — apply one status to the whole ticket. */
export const updateRoundStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body as { status: ItemStatus; reason?: string };

  const round = await orderService.updateRoundStatus({
    roundId: req.params.roundId as string,
    status,
    ...(reason !== undefined ? { reason } : {}),
    actor: getActor(req),
    ip: req.ip ?? null,
  });

  return sendSuccess(res, round, `KOT ${round.kotId} marked ${round.status}`);
});
