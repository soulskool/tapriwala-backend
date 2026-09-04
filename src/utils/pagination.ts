import type { Request } from 'express';

import { APP_CONSTANTS } from '../config/constants.js';

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Reads `?page` / `?limit` from a request and clamps them, so a client can
 * never ask the database for 100k rows.
 */
export function getPagination(req: Request): PaginationParams {
  const rawPage = Number(req.query.page);
  const rawLimit = Number(req.query.limit);

  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : APP_CONSTANTS.DEFAULT_PAGE;

  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), APP_CONSTANTS.MAX_PAGE_SIZE)
      : APP_CONSTANTS.DEFAULT_PAGE_SIZE;

  return { page, limit, skip: (page - 1) * limit };
}

export default getPagination;
