import crypto from 'node:crypto';

// ─── Money ───────────────────────────────────────────────────────────────────

/**
 * Rounds to 2 decimals using half-up on the integer paise value.
 *
 * Every currency figure the API returns goes through this, so a bill total can
 * never drift by a floating-point hair from the sum of its printed lines.
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * A bill rounded to the whole rupee, half up: ₹451.50 → ₹452, ₹169.05 → ₹169.
 *
 * Only the final bill is rounded — never a line, never the tax — so the GST
 * figures on the paper stay exact. The difference comes back as its own signed
 * figure, which is what lets the receipt print a ROUND OFF line and still add
 * up: subtotal + tax + roundOff is exactly what the guest paid.
 */
export function roundToRupee(exact: number): { total: number; roundOff: number } {
  const precise = round2(exact);
  const total = Math.round(precise);
  return { total, roundOff: round2(total - precise) };
}

/** Line amount before tax. */
export function lineAmount(unitPrice: number, quantity: number): number {
  return round2(unitPrice * quantity);
}

/** Tax on a line, computed from the tax percent snapshotted at order time. */
export function lineTax(unitPrice: number, quantity: number, taxPercent: number): number {
  return round2((unitPrice * quantity * taxPercent) / 100);
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

/** Random idempotency key, used when a client did not supply one. */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

// ─── Time ────────────────────────────────────────────────────────────────────

export function minutesSince(date: Date | string | null | undefined, now = new Date()): number {
  if (!date) return 0;
  const then = date instanceof Date ? date : new Date(date);
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60000));
}

/** `YYYY-MM-DD` in local time, used as the daily counter scope key. */
export function dayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─── Query coercion ──────────────────────────────────────────────────────────

/**
 * Reads a boolean from a query string.
 *
 * express-validator's `.toBoolean()` mutates `req.query` at runtime, but its
 * static type stays `string | ParsedQs | ...`. This handles both, so callers
 * do not have to cast at every read site.
 */
export function queryBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

/** Reads an optional number from a query string. */
export function queryNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Reads an optional boolean from a query string (validators may already have
 * cast it).
 *
 * The same defensive shape as `queryDate` and for the same reason: a chain's
 * `.toBoolean()` cannot be relied on to have written back by the time a
 * controller reads it, so the raw string has to be handled too. Anything that
 * is neither true-ish nor false-ish returns undefined rather than guessing —
 * an unparseable filter must not silently become `false` and hide rows.
 */
export function queryBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (normalised === 'true' || normalised === '1') return true;
    if (normalised === 'false' || normalised === '0') return false;
  }
  return undefined;
}

/** Reads an optional Date from a query string (validators may already have cast it). */
export function queryDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Drops undefined keys so `$set` never blanks a field the caller omitted. */
export function compact<T extends Record<string, unknown>>(source: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
