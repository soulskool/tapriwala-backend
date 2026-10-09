import type { Request } from 'express';
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';

import { ERROR_CODES, HTTP_STATUS } from '../config/constants.js';
import { env } from '../config/env.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { verifyToken } from '../utils/jwt.js';
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

/**
 * IP fallback for the key generators below.
 *
 * `ipKeyGenerator` normalises IPv6 to a /64 subnet — without it a single IPv6
 * client can walk through addresses and bypass the limit entirely.
 */
const ipKey = (req: { ip?: string | undefined }): string =>
  req.ip ? ipKeyGenerator(req.ip) : 'unknown';

/**
 * The signed-in staff member behind a request, from the token alone.
 *
 * Every limiter runs before `authenticate`, so `req.user` is not set yet. Only
 * the signature is checked here, never the database — a deactivated account
 * still gets a staff bucket, and `authenticate` still turns it away.
 */
function staffId(req: Request): string | null {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ')
    ? header.slice(7).trim()
    : (req.cookies as Record<string, string> | undefined)?.[env.cookieName];
  if (!token) return null;
  try {
    return verifyToken(token).sub;
  } catch {
    return null;
  }
}

/**
 * Broad limiter for the whole API.
 *
 * Staff are counted per person, guests per IP. Every tablet, phone and KDS
 * screen in the café leaves through one Wi-Fi IP, so a per-IP limit is one
 * bucket for the whole shift — a busy evening emptied it and the kitchen board
 * started refusing taps.
 */
export const apiLimiter = rateLimit({
  ...base,
  windowMs: env.rateLimitWindowMs,
  limit: (req) => (staffId(req) ? env.rateLimitStaffMax : env.rateLimitMax),
  keyGenerator: (req) => {
    const id = staffId(req);
    return id ? `staff:${id}` : ipKey(req);
  },
});

/**
 * PIN login is the one endpoint worth brute-force protecting.
 *
 * Keyed by phone as well as IP: every staff phone shares the café IP, so an
 * IP-only key let one waiter's wrong PINs lock the whole floor out. Only
 * failures count, and 20 per number per 10 minutes is nowhere near enough to
 * walk 10,000 PINs.
 */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const phone = (req.body as { phone?: unknown } | undefined)?.phone;
    return `${ipKey(req)}:${typeof phone === 'string' ? phone : ''}`;
  },
});

/**
 * Customer-facing QR endpoints, keyed by table rather than IP — every phone on
 * the café Wi-Fi shares one NAT address, so an IP-keyed limit would punish the
 * whole room for one enthusiastic tapper.
 */
export const customerLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 600,
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
  limit: (req) => (staffId(req) ? 1000 : 120),
  keyGenerator: (req) => req.customer?.tableId ?? req.user?.id ?? ipKey(req),
});

export default apiLimiter;
