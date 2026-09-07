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
/**
 * GET /billing/exports/xlsx — the Excel export's filters.
 *
 * `settled` is the paid/unpaid split the Billed screen offers; `status` is the
 * raw export status. Only one constrains the query — see `listExports`.
 */
export const exportsXlsxValidation: ValidationChain[] = [
  query('status').optional().isIn(EXPORT_STATUS_VALUES).withMessage('Unknown export status'),
  query('settled').optional().isBoolean().withMessage('settled must be true or false').toBoolean(),
  query('tableCode')
    .optional()
    .trim()
    .isLength({ min: 1, max: 12 })
    .withMessage('tableCode must be 1-12 characters'),
];

export const listExportsValidation: ValidationChain[] = [
  query('status').optional().isIn(EXPORT_STATUS_VALUES).withMessage('Unknown export status'),
  // Same paid/unpaid split the Excel export offers, so the screen and the
  // spreadsheet cannot disagree about which bills are outstanding.
  query('settled').optional().isBoolean().withMessage('settled must be true or false').toBoolean(),
  query('sessionId').optional().isMongoId().withMessage('sessionId must be a valid id'),
  query('tableCode')
    .optional()
    .trim()
    .isLength({ min: 1, max: 12 })
    .withMessage('tableCode must be 1-12 characters'),
];
