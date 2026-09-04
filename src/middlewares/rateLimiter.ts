import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';

import { ERROR_CODES, HTTP_STATUS } from '../config/constants.js';
import { env } from '../config/env.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { logger } from '../utils/logger.js';

/** Shared 429 body so a rate-limited client sees the same envelope as any error. */
const handler: Options['handler'] = (req, res) => {
  logger.warn(`Rate limit hit: ${req.ip} ${req.method} ${req.originalUrl}`, {
    requestId: req.requestId,
  });
  res
    .status(HTTP_STATUS.TOO_MANY_REQUESTS)
    .json(
      ApiResponse.error(
        'Too many requests. Please wait a moment and try again.',
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
      ),
    );
};

const base = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
  handler,
};

/** Broad limiter for the whole API. Generous — a busy café is legitimately chatty. */
export const apiLimiter = rateLimit({
  ...base,
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitMax,
});

/** PIN login is the one endpoint worth brute-force protecting. */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
});

/**
 * IP fallback for the custom key generators below.
 *
 * `ipKeyGenerator` normalises IPv6 to a /64 subnet — without it a single IPv6
 * client can walk through addresses and bypass the limit entirely.
 */
const ipKey = (req: { ip?: string | undefined }): string =>
  req.ip ? ipKeyGenerator(req.ip) : 'unknown';

/**
 * Customer-facing QR endpoints, keyed by table rather than IP — every phone on
 * the café Wi-Fi shares one NAT address, so an IP-keyed limit would punish the
 * whole room for one enthusiastic tapper.
 */
export const customerLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) =>
    req.customer?.tableId ??
    (req.params.tableCode as string | undefined) ??
    (req.headers['x-table-code'] as string | undefined) ??
    ipKey(req),
});

/** Order placement — tight enough to blunt a stuck retry loop. */
export const orderLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.customer?.tableId ?? req.user?.id ?? ipKey(req),
});

export default apiLimiter;
