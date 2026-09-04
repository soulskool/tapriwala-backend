import { param, query, type ValidationChain } from 'express-validator';

import { APP_CONSTANTS } from '../../config/constants.js';

/** Reusable ObjectId route param check — keeps CastErrors out of the DB layer. */
export const objectIdParam = (name: string, label = name): ValidationChain =>
  param(name).isMongoId().withMessage(`${label} must be a valid id`);

/** Standard `?page` / `?limit` pair for list endpoints. */
export const paginationQuery: ValidationChain[] = [
  query('page').optional().isInt({ min: 1 }).withMessage('page must be 1 or greater').toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: APP_CONSTANTS.MAX_PAGE_SIZE })
    .withMessage(`limit must be between 1 and ${APP_CONSTANTS.MAX_PAGE_SIZE}`)
    .toInt(),
];

/** `?from` / `?to` ISO date range used by history and report endpoints. */
export const dateRangeQuery: ValidationChain[] = [
  query('from').optional().isISO8601().withMessage('from must be an ISO date').toDate(),
  query('to').optional().isISO8601().withMessage('to must be an ISO date').toDate(),
];
