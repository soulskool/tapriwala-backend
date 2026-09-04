import { describe, expect, it } from 'vitest';

import { toCsv } from '../../src/services/billing.service.js';
import type { ConsolidatedBill, ConsolidatedLine } from '../../src/types/common.js';

/**
 * CSV export. Pure string work, but the one place a stray comma in a POS name
 * silently shifts every column of an imported bill.
 */

const line = (overrides: Partial<ConsolidatedLine> = {}): ConsolidatedLine => ({
  productCode: 'BEV001',
  posName: 'TEA',
  displayName: 'Masala Tea',
  quantity: 2,
  unitPrice: 30,
  taxPercent: 5,
  amount: 60,
  taxAmount: 3,
  kitchenStation: 'Beverage',
  rounds: [1],
  ...overrides,
});

const bill = (lines: ConsolidatedLine[]): ConsolidatedBill => ({
  sessionId: 's1',
  tableCode: 'M2',
  sessionNumber: 1,
  openedAt: new Date(),
  status: 'bill_requested',
  lines,
  cancelledLines: [],
  subtotal: 0,
  tax: 0,
  total: 0,
  roundCount: 1,
  itemCount: 1,
  requiresReview: false,
});

describe('toCsv', () => {
  it('writes the header the POS importer expects', () => {
    const csv = toCsv(bill([line()]));
    expect(csv.split('\n')[0]).toBe('ProductCode,PosName,Quantity,UnitPrice,TaxPercent,Amount');
  });

  it('writes one row per consolidated line', () => {
    const csv = toCsv(bill([line(), line({ productCode: 'SNK001', posName: 'VEG SANDWICH' })]));
    expect(csv.split('\n')).toHaveLength(3);
    expect(csv).toContain('BEV001,TEA,2,30,5,60');
  });

  it('quotes a POS name containing a comma so columns do not shift', () => {
    const csv = toCsv(bill([line({ posName: 'TEA, MASALA' })]));
    expect(csv).toContain('"TEA, MASALA"');
  });

  it('escapes embedded quotes by doubling them', () => {
    const csv = toCsv(bill([line({ posName: 'TEA "SPECIAL"' })]));
    expect(csv).toContain('"TEA ""SPECIAL"""');
  });

  it('quotes a name containing a newline', () => {
    const csv = toCsv(bill([line({ posName: 'TEA\nHOT' })]));
    expect(csv).toContain('"TEA\nHOT"');
  });

  it('emits a header-only file for a bill with no lines', () => {
    expect(toCsv(bill([]))).toBe('ProductCode,PosName,Quantity,UnitPrice,TaxPercent,Amount');
  });
});
