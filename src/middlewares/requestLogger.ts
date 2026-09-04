import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

import { logger } from '../utils/logger.js';

/** Endpoints whose success lines would flood the log with no information value. */
const QUIET_PATHS = ['/health', '/healthz', '/favicon.ico'];

/**
 * Assigns a request id, logs the request/response pair with a duration, and
 * echoes the id back on the `x-request-id` header. The same id appears on error
 * envelopes, so a staff screenshot maps straight to a log line.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && incoming ? incoming : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  if (QUIET_PATHS.some((path) => req.originalUrl.startsWith(path))) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level](
      `${req.method} ${req.originalUrl} ${res.statusCode} - ${durationMs.toFixed(1)}ms`,
      {
        requestId,
        ip: req.ip,
        actor: req.user ? `${req.user.role}:${req.user.name}` : req.customer ? 'customer' : 'anon',
      },
    );
  });

  next();
};

export default requestLogger;
