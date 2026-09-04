import winston from 'winston';

import { APP_CONSTANTS } from '../config/constants.js';
import { env } from '../config/env.js';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

/**
 * Human-readable line format used for the console and the log files.
 *
 * Winston types every field as `unknown`, so everything is coerced explicitly
 * rather than relying on implicit string conversion (which would print
 * "[object Object]" for a meta value someone passes in later).
 */
const textFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const extras = Object.keys(meta).filter((key) => key !== 'service');
  const suffix = extras.length > 0 ? ` ${JSON.stringify(pick(meta, extras))}` : '';
  const body = typeof stack === 'string' ? stack : String(message);
  return `${String(ts)} [${String(level)}]: ${body}${suffix}`;
});

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return keys.reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = source[key];
    return acc;
  }, {});
}

export const logger = winston.createLogger({
  level: env.logLevel,
  defaultMeta: { service: APP_CONSTANTS.SERVICE_NAME },
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    // Files get structured JSON so they stay greppable/parsable.
    env.isProduction ? json() : textFormat,
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        textFormat,
      ),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
  exitOnError: false,
});

// Keep the test runner output clean.
if (env.isTest) {
  logger.transports.forEach((transport) => {
    if (transport instanceof winston.transports.File) {
      transport.silent = true;
    }
  });
}

export default logger;
