import { describe, expect, it } from 'vitest';

import { ERROR_CODES, HTTP_STATUS } from '../../src/config/constants.js';
import { ApiError } from '../../src/utils/ApiError.js';
import { ApiResponse } from '../../src/utils/ApiResponse.js';

describe('ApiError factories', () => {
  it('maps each factory to the right status and code', () => {
    expect(ApiError.badRequest('x').statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(ApiError.unauthorized().statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(ApiError.forbidden().statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(ApiError.notFound().statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(ApiError.conflict('x').statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(ApiError.invalidState('x').statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY);
    expect(ApiError.tooManyRequests().statusCode).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(ApiError.internal().statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR);
    expect(ApiError.serviceUnavailable('x').statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
  });

  it('distinguishes "wrong request" from "wrong state"', () => {
    // 400 = the request is malformed. 422 = the request is fine but the entity
    // cannot do that right now (closing an already-closed session).
    expect(ApiError.badRequest('x').code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(ApiError.invalidState('x').code).toBe(ERROR_CODES.INVALID_STATE);
  });

  it('carries details through for field-level errors', () => {
    const details = [{ field: 'pin', message: 'PIN must be 4 digits' }];
    expect(ApiError.badRequest('Validation failed', details).details).toEqual(details);
  });

  it('marks itself operational so the handler does not hide the message', () => {
    expect(ApiError.notFound().isOperational).toBe(true);
    expect(ApiError.isApiError(ApiError.notFound())).toBe(true);
    expect(ApiError.isApiError(new Error('boom'))).toBe(false);
  });

  it('is a real Error with a stack', () => {
    const error = ApiError.conflict('Table busy');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Table busy');
    expect(error.stack).toBeTruthy();
  });
});

describe('ApiResponse envelopes', () => {
  it('wraps success with data and message', () => {
    expect(ApiResponse.success({ id: 1 }, 'Done')).toEqual({
      success: true,
      message: 'Done',
      data: { id: 1 },
    });
  });

  it('omits meta unless given', () => {
    expect(ApiResponse.success(null)).not.toHaveProperty('meta');
    expect(ApiResponse.success(null, 'ok', { page: 1 }).meta).toEqual({ page: 1 });
  });

  it('omits details unless given, so clients can rely on its presence', () => {
    expect(ApiResponse.error('Nope', ERROR_CODES.NOT_FOUND).error).not.toHaveProperty('details');
  });

  it('computes pagination flags', () => {
    const page2 = ApiResponse.paginated([1, 2], 2, 2, 6);
    expect(page2.meta?.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 6,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });

  it('handles an empty result set without dividing by zero', () => {
    const empty = ApiResponse.paginated([], 1, 20, 0);
    expect(empty.meta?.pagination).toMatchObject({
      totalPages: 0,
      hasNextPage: false,
      hasPrevPage: false,
    });
  });
});
