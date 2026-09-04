import type { Response } from 'express';

import { HTTP_STATUS, type ErrorCode } from '../config/constants.js';

/** Pagination block returned inside `meta` for list endpoints. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface SuccessEnvelope<T> {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/**
 * Every response the API produces uses one of these two shapes, so the four
 * frontends can share a single fetch wrapper.
 */
export class ApiResponse {
  static success<T>(
    data: T,
    message = 'Success',
    meta?: Record<string, unknown>,
  ): SuccessEnvelope<T> {
    const response: SuccessEnvelope<T> = { success: true, message, data };
    if (meta) response.meta = meta;
    return response;
  }

  static error(message: string, code: ErrorCode, details?: unknown): ErrorEnvelope {
    const response: ErrorEnvelope = { success: false, error: { code, message } };
    if (details !== undefined && details !== null) response.error.details = details;
    return response;
  }

  static paginated<T>(
    data: T[],
    page: number,
    limit: number,
    total: number,
    message = 'Success',
  ): SuccessEnvelope<T[]> {
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
    const pagination: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
    return { success: true, message, data, meta: { pagination } };
  }
}

// ─── Response helpers ────────────────────────────────────────────────────────

export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'Success',
  statusCode: number = HTTP_STATUS.OK,
  meta?: Record<string, unknown>,
): Response {
  return res.status(statusCode).json(ApiResponse.success(data, message, meta));
}

export function sendCreated<T>(res: Response, data: T, message = 'Created successfully'): Response {
  return res.status(HTTP_STATUS.CREATED).json(ApiResponse.success(data, message));
}

export function sendPaginated<T>(
  res: Response,
  data: T[],
  page: number,
  limit: number,
  total: number,
  message = 'Success',
): Response {
  return res.status(HTTP_STATUS.OK).json(ApiResponse.paginated(data, page, limit, total, message));
}

export function sendNoContent(res: Response): Response {
  return res.status(HTTP_STATUS.NO_CONTENT).send();
}

export default ApiResponse;
