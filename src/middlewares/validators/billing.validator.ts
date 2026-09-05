import { body, query, type ValidationChain } from 'express-validator';

import { EXPORT_METHOD_VALUES, EXPORT_STATUS_VALUES } from '../../config/constants.js';

/** POST /billing/:sessionId/export — hand the consolidated bill to the POS. */
export const exportBillValidation: ValidationChain[] = [
  body('method')
    .optional()
    .isIn(EXPORT_METHOD_VALUES)
    .withMessage(`method must be one of: ${EXPORT_METHOD_VALUES.join(', ')}`),
  body('note').optional().trim().isLength({ max: 300 }),
];

/**
 * PATCH /billing/exports/:id — record what the legacy POS said.
 * `posReferenceId` is the invoice number staff read off the POS screen; storing
 * it is what makes our session and their bill reconcilable later.
 */
export const confirmExportValidation: ValidationChain[] = [
  body('exportStatus')
    .isIn(EXPORT_STATUS_VALUES)
    .withMessage(`exportStatus must be one of: ${EXPORT_STATUS_VALUES.join(', ')}`),
  body('posReferenceId').optional().trim().isLength({ max: 60 }),
  body('error').optional().trim().isLength({ max: 500 }),
  body('note').optional().trim().isLength({ max: 300 }),
];

/** GET /billing/exports */
export const listExportsValidation: ValidationChain[] = [
  query('status').optional().isIn(EXPORT_STATUS_VALUES).withMessage('Unknown export status'),
  query('sessionId').optional().isMongoId().withMessage('sessionId must be a valid id'),
  query('tableCode')
    .optional()
    .trim()
    .isLength({ min: 1, max: 12 })
    .withMessage('tableCode must be 1-12 characters'),
];
