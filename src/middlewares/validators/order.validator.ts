import { body, query, type ValidationChain } from 'express-validator';

import {
  APP_CONSTANTS,
  ITEM_STATUS,
  ITEM_STATUS_VALUES,
  KITCHEN_STATION_VALUES,
  ORDER_TYPE_VALUES,
} from '../../config/constants.js';

/**
 * POST /sessions/:id/rounds — place an order round.
 *
 * Note what is NOT accepted here: price, tax, posName. Those are read from
 * ProductMaster server-side, so a tampered client cannot order a 500 rupee
 * item for 5. The client sends codes and quantities only.
 */
export const placeOrderValidation: ValidationChain[] = [
  body('items')
    .isArray({ min: 1, max: APP_CONSTANTS.MAX_ITEMS_PER_ROUND })
    .withMessage(`An order must have 1–${APP_CONSTANTS.MAX_ITEMS_PER_ROUND} item lines`),

  body('items.*.productCode')
    .trim()
    .notEmpty()
    .withMessage('Each item needs a productCode')
    .isLength({ max: 32 }),

  body('items.*.quantity')
    .isInt({ min: 1, max: APP_CONSTANTS.MAX_QUANTITY_PER_ITEM })
    .withMessage(`Quantity must be between 1 and ${APP_CONSTANTS.MAX_QUANTITY_PER_ITEM}`)
    .toInt(),

  body('items.*.specialInstructions')
    .optional()
    .trim()
    .isLength({ max: APP_CONSTANTS.MAX_SPECIAL_INSTRUCTIONS_LENGTH })
    .withMessage(
      `Special instructions must be at most ${APP_CONSTANTS.MAX_SPECIAL_INSTRUCTIONS_LENGTH} characters`,
    ),

  // Absent means dining. Only the staff route reads it — the public QR
  // controller ignores the body field entirely, so a guest cannot send one.
  body('orderType')
    .optional()
    .isIn(ORDER_TYPE_VALUES)
    .withMessage(`orderType must be one of: ${ORDER_TYPE_VALUES.join(', ')}`),

  // Client-generated key; the server falls back to a UUID when it is absent.
  body('idempotencyKey')
    .optional()
    .trim()
    .isLength({ min: 8, max: 64 })
    .withMessage('idempotencyKey must be 8–64 characters'),
];

/** PATCH /rounds/:roundId/items/:itemId — kitchen/waiter status move. */
export const updateItemStatusValidation: ValidationChain[] = [
  body('status')
    .isIn(ITEM_STATUS_VALUES)
    .withMessage(`status must be one of: ${ITEM_STATUS_VALUES.join(', ')}`),

  // A cancellation always needs a reason — this is the audit trail for disputes.
  body('reason')
    .if(body('status').equals(ITEM_STATUS.CANCELLED))
    .trim()
    .notEmpty()
    .withMessage('A reason is required when cancelling an item')
    .isLength({ max: 300 }),
];

/** PATCH /rounds/:roundId/status — bulk move every live item in a ticket. */
export const updateRoundStatusValidation: ValidationChain[] = [
  body('status')
    .isIn(ITEM_STATUS_VALUES)
    .withMessage(`status must be one of: ${ITEM_STATUS_VALUES.join(', ')}`),
  body('reason').optional().trim().isLength({ max: 300 }),
];

/** GET /kitchen/queue */
export const kitchenQueueValidation: ValidationChain[] = [
  query('station')
    .optional()
    .isIn(KITCHEN_STATION_VALUES)
    .withMessage(`station must be one of: ${KITCHEN_STATION_VALUES.join(', ')}`),
  query('includeServed').optional().isBoolean().toBoolean(),
  query('sinceMinutes').optional().isInt({ min: 1, max: 1440 }).toInt(),
];
