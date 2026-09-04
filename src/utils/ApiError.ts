import { ERROR_CODES, HTTP_STATUS, type ErrorCode } from '../config/constants.js';

/**
 * Operational (expected) application error.
 *
 * Throw these from services/controllers; the global error handler turns them
 * into the standard error envelope. Anything that is *not* an ApiError is
 * treated as a bug and its message is hidden from clients in production.
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details: unknown;
  public readonly isOperational = true;

  constructor(
    statusCode: number,
    message: string,
    code: ErrorCode = ERROR_CODES.INTERNAL_ERROR,
    details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }

  /** 400 — malformed or semantically invalid request. */
  static badRequest(message: string, details: unknown = null): ApiError {
    return new ApiError(HTTP_STATUS.BAD_REQUEST, message, ERROR_CODES.VALIDATION_ERROR, details);
  }

  /** 401 — missing/expired credentials. */
  static unauthorized(message = 'Unauthorized access'): ApiError {
    return new ApiError(HTTP_STATUS.UNAUTHORIZED, message, ERROR_CODES.UNAUTHORIZED);
  }

  /** 403 — authenticated, but the role is not allowed to do this. */
  static forbidden(message = 'Access forbidden'): ApiError {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message, ERROR_CODES.FORBIDDEN);
  }

  /** 404 — entity does not exist (or is not visible to this caller). */
  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message, ERROR_CODES.NOT_FOUND);
  }

  /** 409 — uniqueness/concurrency clash, e.g. a second live session on a table. */
  static conflict(message: string, details: unknown = null): ApiError {
    return new ApiError(HTTP_STATUS.CONFLICT, message, ERROR_CODES.CONFLICT, details);
  }

  /**
   * 422 — the request is well-formed but the entity is in the wrong state for
   * it (closing an already-closed session, serving a cancelled item, ...).
   */
  static invalidState(message: string, details: unknown = null): ApiError {
    return new ApiError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      message,
      ERROR_CODES.INVALID_STATE,
      details,
    );
  }

  /** 429 — rate limited. */
  static tooManyRequests(message = 'Too many requests'): ApiError {
    return new ApiError(HTTP_STATUS.TOO_MANY_REQUESTS, message, ERROR_CODES.RATE_LIMIT_EXCEEDED);
  }

  /** 500 — unexpected server failure. */
  static internal(message = 'Internal server error', details: unknown = null): ApiError {
    return new ApiError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      message,
      ERROR_CODES.INTERNAL_ERROR,
      details,
    );
  }

  /** 503 — a downstream dependency (POS bridge, printer, ...) is unavailable. */
  static serviceUnavailable(message: string, details: unknown = null): ApiError {
    return new ApiError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      message,
      ERROR_CODES.INTEGRATION_ERROR,
      details,
    );
  }

  static isApiError(error: unknown): error is ApiError {
    return error instanceof ApiError;
  }
}

export default ApiError;
