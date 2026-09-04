import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import { ERROR_CODES, HTTP_STATUS } from '../config/constants.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { logger } from '../utils/logger.js';

/**
 * Translates a driver/library error into an ApiError.
 * Anything not recognised here is treated as a bug (500, message hidden).
 */
function normalize(err: unknown): ApiError {
  if (ApiError.isApiError(err)) return err;

  // Mongoose: bad ObjectId in a query
  if (err instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for field "${err.path}"`);
  }

  // Mongoose: schema validation
  if (err instanceof mongoose.Error.ValidationError) {
    const fields = Object.values(err.errors).map((detail) => ({
      field: detail.path,
      message: detail.message,
    }));
    return ApiError.badRequest('Validation failed', fields);
  }

  // MongoDB: duplicate key — the shape depends on which unique index tripped.
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
    const field = Object.keys(keyValue)[0] ?? 'field';
    const indexName = (err as { message?: string }).message ?? '';

    // The "one live session per table" partial index deserves a real message.
    if (indexName.includes('uniq_active_session_table')) {
      return ApiError.conflict(
        'This table already has an open session. Add to the running session instead of opening a new one.',
      );
    }
    if (indexName.includes('uniq_idempotency_key')) {
      return ApiError.conflict('This order was already submitted', { field: 'idempotencyKey' });
    }
    return ApiError.conflict(`Duplicate value for "${field}"`, { field, value: keyValue[field] });
  }

  if (err instanceof jwt.TokenExpiredError) return ApiError.unauthorized('Session expired');
  if (err instanceof jwt.JsonWebTokenError) return ApiError.unauthorized('Invalid token');

  // Body parser rejected malformed JSON.
  if (
    err instanceof SyntaxError &&
    'body' in err &&
    (err as { status?: number }).status === HTTP_STATUS.BAD_REQUEST
  ) {
    return ApiError.badRequest('Malformed JSON body');
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  const wrapped = ApiError.internal(message);
  // Preserve the original stack for the log line below.
  if (err instanceof Error) wrapped.stack = err.stack;
  return wrapped;
}

/**
 * Global error handler — the single place that writes an error response.
 * Must be registered last, after all routes and the 404 handler.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const error = normalize(err);
  const isServerError = error.statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR;

  const logPayload = {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode: error.statusCode,
    code: error.code,
    userId: req.user?.id ?? null,
    role: req.user?.role ?? (req.customer ? 'customer' : null),
    stack: error.stack,
  };

  if (isServerError) {
    logger.error(`Unhandled error: ${error.message}`, logPayload);
  } else {
    logger.warn(`Request failed: ${error.message}`, { ...logPayload, stack: undefined });
  }

  // Never leak an internal message or stack to a client in production.
  const clientMessage =
    isServerError && env.isProduction ? 'Something went wrong. Please try again.' : error.message;

  // `details` is passed through untouched — validation errors are an ARRAY of
  // { field, message } and the frontends index into it to mark inputs red.
  // Debug info goes in sibling keys so that shape is never disturbed.
  const payload: Record<string, unknown> = {
    ...ApiResponse.error(clientMessage, error.code, error.details),
    requestId: req.requestId ?? null,
  };

  if (!env.isProduction) payload.stack = error.stack;

  res.status(error.statusCode).json(payload);
};

/** 404 for unmatched routes. Registered after all routers, before errorHandler. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(HTTP_STATUS.NOT_FOUND)
    .json(ApiResponse.error(`Route ${req.method} ${req.originalUrl} not found`, ERROR_CODES.NOT_FOUND));
};

export default errorHandler;
