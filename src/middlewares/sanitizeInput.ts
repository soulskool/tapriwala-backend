import type { RequestHandler } from 'express';

/**
 * Strips MongoDB operator keys from a JSON body before any handler sees it.
 *
 * Validators already pin every field this API reads to a string, number,
 * boolean or array, so this is defence in depth: if a future handler ever
 * forwards a body object into a filter without a validator in front, a
 * `{ "phone": { "$ne": null } }` payload arrives as `{ "phone": {} }` and
 * matches nothing instead of everything.
 *
 * Only keys starting with `$` are removed. No legitimate request in this API
 * sends one, so nothing a real screen does is affected. The query string needs
 * no equivalent: Express 5's default `simple` parser never builds nested
 * objects, so `?status[$ne]=x` is just a key with an odd name.
 */
function strip(value: unknown, depth: number): void {
  if (depth > 20 || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const entry of value) strip(entry, depth + 1);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith('$')) {
      delete record[key];
      continue;
    }
    strip(record[key], depth + 1);
  }
}

export const stripMongoOperators: RequestHandler = (req, _res, next) => {
  strip(req.body, 0);
  next();
};

export default stripMongoOperators;
