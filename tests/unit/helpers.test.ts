import { describe, expect, it } from 'vitest';

import {
  compact,
  dayKey,
  generateIdempotencyKey,
  minutesSince,
  queryBool,
  queryDate,
  queryNumber,
} from '../../src/utils/helpers.js';

describe('queryBool', () => {
  it('accepts both a real boolean and the string a query string carries', () => {
    // express-validator's .toBoolean() mutates req.query at runtime, but its
    // static type stays a string — both forms reach the controller.
    expect(queryBool(true)).toBe(true);
    expect(queryBool('true')).toBe(true);
    expect(queryBool('1')).toBe(true);
  });

  it('treats anything else as false rather than truthy', () => {
    expect(queryBool('false')).toBe(false);
    expect(queryBool('yes')).toBe(false);
    expect(queryBool(undefined)).toBe(false);
    expect(queryBool('')).toBe(false);
  });
});

describe('queryNumber', () => {
  it('parses numeric strings and passes numbers through', () => {
    expect(queryNumber('15')).toBe(15);
    expect(queryNumber(15)).toBe(15);
    expect(queryNumber('0')).toBe(0);
  });

  it('returns undefined for anything unparseable, never NaN', () => {
    expect(queryNumber('abc')).toBeUndefined();
    expect(queryNumber('')).toBeUndefined();
    expect(queryNumber(undefined)).toBeUndefined();
    expect(queryNumber(Number.NaN)).toBeUndefined();
  });
});

describe('queryDate', () => {
  it('accepts a Date or an ISO string', () => {
    const now = new Date();
    expect(queryDate(now)).toBe(now);
    expect(queryDate('2026-08-31T10:00:00.000Z')?.toISOString()).toBe('2026-08-31T10:00:00.000Z');
  });

  it('returns undefined for an invalid date instead of Invalid Date', () => {
    expect(queryDate('not-a-date')).toBeUndefined();
    expect(queryDate('')).toBeUndefined();
  });
});

describe('minutesSince', () => {
  it('measures elapsed whole minutes', () => {
    const now = new Date('2026-08-31T12:00:00Z');
    expect(minutesSince(new Date('2026-08-31T11:52:00Z'), now)).toBe(8);
    expect(minutesSince(new Date('2026-08-31T11:59:59Z'), now)).toBe(0);
  });

  it('never returns a negative age for a clock-skewed future date', () => {
    const now = new Date('2026-08-31T12:00:00Z');
    expect(minutesSince(new Date('2026-08-31T12:05:00Z'), now)).toBe(0);
  });

  it('treats a missing date as zero', () => {
    expect(minutesSince(null)).toBe(0);
    expect(minutesSince(undefined)).toBe(0);
  });
});

describe('dayKey', () => {
  it('formats local date as YYYY-MM-DD with zero padding', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('compact', () => {
  it('drops undefined so a PATCH never blanks an omitted field', () => {
    expect(compact({ name: 'Tea', price: undefined, category: 'Beverages' })).toEqual({
      name: 'Tea',
      category: 'Beverages',
    });
  });

  it('keeps null and false — those are deliberate values', () => {
    expect(compact({ isActive: false, note: null })).toEqual({ isActive: false, note: null });
  });
});

describe('token generation', () => {
  it('produces unique idempotency keys', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(500);
  });
});
