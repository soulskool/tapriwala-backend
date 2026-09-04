import { body, query, type ValidationChain } from 'express-validator';

import { SESSION_STATUS_VALUES } from '../../config/constants.js';

/** POST /sessions — waiter opens a table. */
export const openSessionValidation: ValidationChain[] = [
  body('tableId').isMongoId().withMessage('tableId must be a valid id'),
  body('guestCount')
    .optional()
    .isInt({ min: 0, max: 100 })
    .withMessage('guestCount must be between 0 and 100')
    .toInt(),
];

/** POST /sessions/:id/close — billing closes the session. */
export const closeSessionValidation: ValidationChain[] = [
  body('billingExportId').optional().isMongoId().withMessage('billingExportId must be a valid id'),
  body('note').optional().trim().isLength({ max: 300 }),
  body('force')
    .optional()
    .isBoolean()
    .withMessage('force must be a boolean')
    .toBoolean(),
];

/** POST /sessions/:id/transfer — move a running session to another table. */
export const transferSessionValidation: ValidationChain[] = [
  body('toTableId').isMongoId().withMessage('toTableId must be a valid id'),
  body('reason')
    .trim()
    .notEmpty()
    .withMessage('A reason is required for a table transfer')
    .isLength({ max: 200 }),
];

/** PATCH /sessions/:id/review — flag/clear a session for manager review. */
export const reviewSessionValidation: ValidationChain[] = [
  body('heldForReview').isBoolean().withMessage('heldForReview must be a boolean').toBoolean(),
  body('note').optional().trim().isLength({ max: 500 }),
];

/** GET /sessions */
export const listSessionsValidation: ValidationChain[] = [
  query('status').optional().isIn(SESSION_STATUS_VALUES).withMessage('Unknown session status'),
  query('tableId').optional().isMongoId().withMessage('tableId must be a valid id'),
  query('activeOnly').optional().isBoolean().toBoolean(),
];
