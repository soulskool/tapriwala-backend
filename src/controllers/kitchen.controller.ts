import type { KitchenStation } from '../config/constants.js';
import * as orderService from '../services/order.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { queryBool, queryNumber } from '../utils/helpers.js';

/**
 * GET /kitchen/queue — the full live KDS.
 *
 * A tablet calls this on load AND on every socket reconnect. That is the
 * contract that makes a dropped Wi-Fi connection harmless: sockets deliver
 * changes, this endpoint delivers truth.
 */
export const getQueue = asyncHandler(async (req, res) => {
  const sinceMinutes = queryNumber(req.query.sinceMinutes);

  const tickets = await orderService.getKitchenQueue({
    station: req.query.station as KitchenStation | undefined,
    includeServed: queryBool(req.query.includeServed),
    ...(sinceMinutes !== undefined ? { sinceMinutes } : {}),
  });

  // Oldest first; the frontend shows elapsedMinutes large so a delayed ticket
  // is obvious without anyone asking the kitchen about it.
  return sendSuccess(res, {
    tickets,
    count: tickets.length,
    generatedAt: new Date(),
  });
});

/** GET /kitchen/ready — rounds sitting ready too long, for the waiter nudge. */
export const getUnservedReady = asyncHandler(async (req, res) => {
  const thresholdMinutes = queryNumber(req.query.thresholdMinutes);

  const rounds = await orderService.getUnservedReadyRounds(thresholdMinutes);
  return sendSuccess(res, { rounds, count: rounds.length });
});
