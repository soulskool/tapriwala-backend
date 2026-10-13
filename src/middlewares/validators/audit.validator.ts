import { query, type ValidationChain } from 'express-validator';

import { AUDIT_ACTION, AUDIT_ENTITY } from '../../config/constants.js';

const AUDIT_ENTITY_VALUES = Object.values(AUDIT_ENTITY);
const AUDIT_ACTION_VALUES = Object.values(AUDIT_ACTION);

/**
 * GET /admin/audit — the trail's filters.
 *
 * Every one of these lands in a Mongo filter, so each is pinned to its real
 * shape here instead of being trusted as a cast in the controller. A bad value
 * is a 400 with the field named, not a CastError or an empty page.
 */
export const listAuditValidation: ValidationChain[] = [
  query('entityType')
    .optional()
    .isIn(AUDIT_ENTITY_VALUES)
    .withMessage(`entityType must be one of: ${AUDIT_ENTITY_VALUES.join(', ')}`),
  query('action').optional().isIn(AUDIT_ACTION_VALUES).withMessage('Unknown audit action'),
  query('entityId').optional().isMongoId().withMessage('entityId must be a valid id'),
  query('sessionId').optional().isMongoId().withMessage('sessionId must be a valid id'),
  query('tableCode')
    .optional()
    .trim()
    // A free-text search box on the audit screen, so generous: anything longer
    // than a table code simply matches nothing, as it always has.
    .isLength({ max: 60 })
    .withMessage('tableCode must be at most 60 characters'),
];
