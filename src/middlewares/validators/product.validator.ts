import { body, query, type ValidationChain } from 'express-validator';

import { KITCHEN_STATION_VALUES } from '../../config/constants.js';

/** POST /products */
export const createProductValidation: ValidationChain[] = [
  body('productCode')
    .trim()
    .notEmpty()
    .withMessage('productCode is required')
    .isLength({ max: 32 })
    .withMessage('productCode must be at most 32 characters')
    .matches(/^[A-Za-z0-9._-]+$/)
    .withMessage('productCode may contain letters, numbers, dot, hyphen and underscore only'),

  body('posName')
    .trim()
    .notEmpty()
    .withMessage('posName is required (must match the billing software exactly)')
    .isLength({ max: 120 })
    .withMessage('posName must be at most 120 characters'),

  body('displayName')
    .trim()
    .notEmpty()
    .withMessage('displayName is required')
    .isLength({ max: 120 })
    .withMessage('displayName must be at most 120 characters'),

  body('category').trim().notEmpty().withMessage('category is required').isLength({ max: 60 }),

  body('price').isFloat({ min: 0 }).withMessage('price must be 0 or greater').toFloat(),

  body('taxPercent')
    .optional()
    .isFloat({ min: 0, max: 100 })
    .withMessage('taxPercent must be between 0 and 100')
    .toFloat(),

  body('kitchenStation')
    .optional()
    .isIn(KITCHEN_STATION_VALUES)
    .withMessage(`kitchenStation must be one of: ${KITCHEN_STATION_VALUES.join(', ')}`),

  body('description').optional().trim().isLength({ max: 300 }),
  body('imageUrl').optional({ values: 'falsy' }).trim().isURL().withMessage('imageUrl must be a valid URL'),
  body('displayOrder').optional().isInt({ min: 0 }).toInt(),
  body('isAvailable').optional().isBoolean().toBoolean(),
  body('isActive').optional().isBoolean().toBoolean(),
];

/** PATCH /products/:id */
export const updateProductValidation: ValidationChain[] = [
  body('productCode')
    .optional()
    .trim()
    .isLength({ min: 1, max: 32 })
    .matches(/^[A-Za-z0-9._-]+$/)
    .withMessage('productCode may contain letters, numbers, dot, hyphen and underscore only'),
  body('posName').optional().trim().isLength({ min: 1, max: 120 }),
  body('displayName').optional().trim().isLength({ min: 1, max: 120 }),
  body('category').optional().trim().isLength({ min: 1, max: 60 }),
  body('price').optional().isFloat({ min: 0 }).toFloat(),
  body('taxPercent').optional().isFloat({ min: 0, max: 100 }).toFloat(),
  body('kitchenStation').optional().isIn(KITCHEN_STATION_VALUES),
  body('description').optional().trim().isLength({ max: 300 }),
  body('imageUrl').optional({ values: 'falsy' }).trim().isURL().withMessage('imageUrl must be a valid URL'),
  body('displayOrder').optional().isInt({ min: 0 }).toInt(),
  body('isAvailable').optional().isBoolean().toBoolean(),
  body('isActive').optional().isBoolean().toBoolean(),
];

/** PATCH /products/:id/availability — the 86 toggle. */
export const toggleAvailabilityValidation: ValidationChain[] = [
  body('isAvailable').isBoolean().withMessage('isAvailable must be a boolean').toBoolean(),
  body('reason').optional().trim().isLength({ max: 200 }),
];

/** POST /products/bulk — Excel import path. */
export const bulkUpsertProductsValidation: ValidationChain[] = [
  body('products')
    .isArray({ min: 1, max: 1000 })
    .withMessage('products must be an array of 1–1000 rows'),
  body('products.*.productCode').trim().notEmpty().withMessage('Every row needs a productCode'),
  body('products.*.posName').trim().notEmpty().withMessage('Every row needs a posName'),
  body('products.*.displayName').trim().notEmpty().withMessage('Every row needs a displayName'),
  body('products.*.category').trim().notEmpty().withMessage('Every row needs a category'),
  body('products.*.price').isFloat({ min: 0 }).withMessage('Every row needs a price of 0 or greater').toFloat(),
  body('products.*.taxPercent').optional().isFloat({ min: 0, max: 100 }).toFloat(),
  body('products.*.kitchenStation').optional().isIn(KITCHEN_STATION_VALUES),
];

/** GET /products */
export const listProductsValidation: ValidationChain[] = [
  query('category').optional().trim().isLength({ max: 60 }),
  query('station').optional().isIn(KITCHEN_STATION_VALUES),
  query('search').optional().trim().isLength({ max: 60 }),
  query('availableOnly').optional().isBoolean().toBoolean(),
  query('includeInactive').optional().isBoolean().toBoolean(),
];
