import { describe, expect, it } from 'vitest';

import { ITEM_STATUS } from '../../src/config/constants.js';
import { totalsForItems } from '../../src/services/statusDerivation.js';
import { lineAmount, lineTax, round2 } from '../../src/utils/helpers.js';

/**
 * Money. The one area where "close enough" is not acceptable, because the
 * printed bill and the sum of its lines must agree to the paisa.
 */

const item = (overrides: Partial<Parameters<typeof totalsForItems>[0][number]> = {}) => ({
  status: ITEM_STATUS.PENDING,
  quantity: 1,
  unitPrice: 100,
  taxPercent: 5,
  ...overrides,
});

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(10.004)).toBe(10);
    expect(round2(10.005)).toBe(10.01);
    expect(round2(10.006)).toBe(10.01);
  });

  it('kills floating point drift', () => {
    // The classic: 0.1 + 0.2 === 0.30000000000000004
    expect(round2(0.1 + 0.2)).toBe(0.3);
    // 1.005 is not exactly 1.005 in binary, so 1.005*3 is 3.01499…
    expect(round2(1.005 * 3)).toBe(3.01);
  });

  it('leaves whole numbers alone', () => {
    expect(round2(140)).toBe(140);
    expect(round2(0)).toBe(0);
  });
});

describe('line maths', () => {
  it('multiplies price by quantity', () => {
    expect(lineAmount(140, 2)).toBe(280);
    expect(lineAmount(33.33, 3)).toBe(99.99);
  });

  it('applies tax as a percentage of the line', () => {
    expect(lineTax(100, 2, 5)).toBe(10);
    expect(lineTax(140, 1, 18)).toBe(25.2);
    expect(lineTax(100, 1, 0)).toBe(0);
  });
});

describe('totalsForItems', () => {
  it('sums subtotal, tax and total across lines', () => {
    const totals = totalsForItems([
      item({ unitPrice: 30, quantity: 2, taxPercent: 5 }),
      item({ unitPrice: 140, quantity: 1, taxPercent: 5 }),
    ]);

    expect(totals.subtotal).toBe(200);
    expect(totals.taxTotal).toBe(10);
    expect(totals.total).toBe(210);
  });

  it('excludes cancelled items — a cancelled line is never billed', () => {
    const totals = totalsForItems([
      item({ unitPrice: 100, quantity: 1 }),
      item({ unitPrice: 500, quantity: 2, status: ITEM_STATUS.CANCELLED }),
    ]);

    expect(totals.subtotal).toBe(100);
    expect(totals.total).toBe(105);
  });

  it('returns zeroes for an empty or fully cancelled set', () => {
    expect(totalsForItems([])).toEqual({ subtotal: 0, taxTotal: 0, total: 0 });
    expect(totalsForItems([item({ status: ITEM_STATUS.CANCELLED })])).toEqual({
      subtotal: 0,
      taxTotal: 0,
      total: 0,
    });
  });

  it('keeps total equal to subtotal + tax under awkward rates', () => {
    const totals = totalsForItems([
      item({ unitPrice: 33.33, quantity: 3, taxPercent: 12.5 }),
      item({ unitPrice: 7.77, quantity: 7, taxPercent: 5 }),
    ]);

    expect(totals.total).toBe(round2(totals.subtotal + totals.taxTotal));
  });

  it('counts each line by its own tax rate, not a blended one', () => {
    const totals = totalsForItems([
      item({ unitPrice: 100, quantity: 1, taxPercent: 5 }),
      item({ unitPrice: 100, quantity: 1, taxPercent: 18 }),
    ]);

    expect(totals.subtotal).toBe(200);
    expect(totals.taxTotal).toBe(23);
  });
});
