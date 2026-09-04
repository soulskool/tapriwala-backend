import { body, param, query, type ValidationChain } from 'express-validator';

import { TABLE_ZONE_VALUES } from '../../config/constants.js';

/** POST /tables */
export const createTableValidation: ValidationChain[] = [
  body('code')
    .trim()
    .notEmpty()
    .withMessage('Table code is required')
    .isLength({ max: 12 })
    .withMessage('Table code must be at most 12 characters')
    .matches(/^[A-Za-z0-9 _-]+$/)
    .withMessage('Table code may contain letters, numbers, space, hyphen and underscore only'),

  body('zone').isIn(TABLE_ZONE_VALUES).withMessage(`zone must be one of: ${TABLE_ZONE_VALUES.join(', ')}`),

  body('displayOrder').optional().isInt({ min: 0 }).withMessage('displayOrder must be 0 or greater').toInt(),

  body('seatingCapacity')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('seatingCapacity must be between 1 and 50')
    .toInt(),

  body('notes').optional().trim().isLength({ max: 200 }).withMessage('notes must be at most 200 characters'),
];

/** PATCH /tables/:id */
export const updateTableValidation: ValidationChain[] = [
  body('code')
    .optional()
    .trim()
    .isLength({ min: 1, max: 12 })
    .withMessage('Table code must be 1–12 characters')
    .matches(/^[A-Za-z0-9 _-]+$/)
    .withMessage('Table code may contain letters, numbers, space, hyphen and underscore only'),
  body('zone').optional().isIn(TABLE_ZONE_VALUES).withMessage(`zone must be one of: ${TABLE_ZONE_VALUES.join(', ')}`),
  body('displayOrder').optional().isInt({ min: 0 }).toInt(),
  body('seatingCapacity').optional().isInt({ min: 1, max: 50 }).toInt(),
  body('isActive').optional().isBoolean().toBoolean(),
  body('notes').optional().trim().isLength({ max: 200 }),
];

/** GET /public/tables/:tableCode — the customer entry point. */
export const tableCodeParamValidation: ValidationChain[] = [
  param('tableCode')
    .trim()
    .notEmpty()
    .withMessage('Table code is required')
    .isLength({ max: 12 })
    .withMessage('Table code format is invalid')
    // Mirrors the model's own shape. Anything else was never printed on a
    // sticker, so it is rejected before it reaches a database query.
    .matches(/^[A-Za-z0-9-]+$/)
    .withMessage('Table code format is invalid'),
];

/** GET /tables — optional zone/status filters for the live grid. */
export const listTablesValidation: ValidationChain[] = [
  query('zone').optional().isIn(TABLE_ZONE_VALUES).withMessage('Unknown zone'),
  query('includeInactive').optional().isBoolean().toBoolean(),
];
