import { body, query, type ValidationChain } from 'express-validator';

import {
  SERVICE_REQUEST_STATUS,
  SERVICE_REQUEST_STATUS_VALUES,
  SERVICE_REQUEST_TYPE_VALUES,
} from '../../config/constants.js';

/** POST /service-requests (staff) and /public/tables/:tableCode/service-requests (customer). */
export const raiseServiceRequestValidation: ValidationChain[] = [
  body('type')
    .isIn(SERVICE_REQUEST_TYPE_VALUES)
    .withMessage(`type must be one of: ${SERVICE_REQUEST_TYPE_VALUES.join(', ')}`),
  body('note').optional().trim().isLength({ max: 300 }),
];

/** Staff-raised requests must name the table; customer ones come from the QR token. */
export const raiseServiceRequestForTableValidation: ValidationChain[] = [
  body('tableId').isMongoId().withMessage('tableId must be a valid id'),
  ...raiseServiceRequestValidation,
];

/** PATCH /service-requests/:id — acknowledge / resolve / cancel. */
export const updateServiceRequestValidation: ValidationChain[] = [
  body('status')
    .isIn(SERVICE_REQUEST_STATUS_VALUES)
    .withMessage(`status must be one of: ${SERVICE_REQUEST_STATUS_VALUES.join(', ')}`),
  body('note')
    .if(body('status').equals(SERVICE_REQUEST_STATUS.CANCELLED))
    .trim()
    .notEmpty()
    .withMessage('A note is required when dismissing a request')
    .isLength({ max: 300 }),
];

/** GET /service-requests */
export const listServiceRequestsValidation: ValidationChain[] = [
  query('status').optional().isIn(SERVICE_REQUEST_STATUS_VALUES).withMessage('Unknown status'),
  query('type').optional().isIn(SERVICE_REQUEST_TYPE_VALUES).withMessage('Unknown type'),
  query('tableId').optional().isMongoId().withMessage('tableId must be a valid id'),
  query('openOnly').optional().isBoolean().toBoolean(),
];
