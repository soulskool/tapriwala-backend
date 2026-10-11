import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingExport } from '../../src/models/index.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * GET /admin/sales/items — the item-wise, category-wise and per-period report.
 *
 * Bills are inserted directly on fixed 2025 dates, so the arithmetic is exact
 * and nothing another test bills today can leak into the range.
 */

let h: Harness;

interface Line {
  productCode: string;
  posName: string;
  quantity: number;
  unitPrice: number;
  orderType?: 'dining' | 'parcel';
}

async function insertBill(
  billNumber: number,
  generatedAt: string,
  lines: Line[],
  exportStatus = 'confirmed',
) {
  const lineItems = lines.map((line) => {
    const amount = line.unitPrice * line.quantity;
    return {
      ...line,
      orderType: line.orderType ?? 'dining',
      taxPercent: 5,
      amount,
      taxAmount: amount * 0.05,
    };
  });
  const subtotal = lineItems.reduce((sum, line) => sum + line.amount, 0);
  const tax = lineItems.reduce((sum, line) => sum + line.taxAmount, 0);
  await BillingExport.collection.insertOne({
    sessionId: new Types.ObjectId(),
    tableId: new Types.ObjectId(),
    tableCode: 'M1',
    billNumber,
    generatedAt: new Date(generatedAt),
    generatedBy: { role: 'billing', userId: null, name: 'Counter' },
    lineItems,
    subtotal,
    tax,
    roundOff: 0,
    total: subtotal + tax,
    exportMethod: 'manual_display',
    exportStatus,
    attempts: 1,
    note: '',
  });
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

beforeAll(async () => {
  h = await createHarness();

  // 1 March 2025, IST.
  await insertBill(800001, '2025-03-01T06:00:00.000Z', [
    { productCode: 'BEV001', posName: 'TEA', quantity: 2, unitPrice: 30 },
    { productCode: 'SNK001', posName: 'VEG SANDWICH', quantity: 1, unitPrice: 140 },
  ]);
  // 2 March: a parcel tea at a different price, and a code since deleted.
  await insertBill(800002, '2025-03-02T06:00:00.000Z', [
    { productCode: 'BEV001', posName: 'TEA', quantity: 1, unitPrice: 30 },
    { productCode: 'BEV001', posName: 'TEA', quantity: 1, unitPrice: 35, orderType: 'parcel' },
    { productCode: 'OLD001', posName: 'RETIRED ITEM', quantity: 1, unitPrice: 100 },
  ]);
  // 2 March 01:30 IST, which is still 1 March in UTC — booked to the 2nd.
  await insertBill(800003, '2025-03-01T20:00:00.000Z', [
    { productCode: 'SNK001', posName: 'VEG SANDWICH', quantity: 1, unitPrice: 140 },
  ]);
  // Unpaid: never a sale.
  await insertBill(
    800004,
    '2025-03-02T07:00:00.000Z',
    [{ productCode: 'BEV001', posName: 'TEA', quantity: 5, unitPrice: 30 }],
    'pending',
  );
  // April, for the month view.
  await insertBill(800005, '2025-04-10T06:00:00.000Z', [
    { productCode: 'SNK001', posName: 'VEG SANDWICH', quantity: 2, unitPrice: 140 },
  ]);
});

afterAll(async () => {
  await h.close();
});

describe('GET /admin/sales/items', () => {
  it('adds up each item across bills and prices, paid bills only', async () => {
    const report = await h.api('GET', '/admin/sales/items?from=2025-03-01&to=2025-03-02', {
      token: h.tokens.admin,
    });
    expect(report.status).toBe(200);

    const { items, totals, periods } = report.data;
    expect(periods).toEqual(['2025-03-01', '2025-03-02']);
    expect(totals).toMatchObject({ bills: 3, quantity: 7, amount: 505, tax: 25.25 });

    const tea = items.find((item: { productCode: string }) => item.productCode === 'BEV001');
    expect(tea).toMatchObject({
      name: 'TEA',
      category: 'Beverages',
      quantity: 4,
      amount: 125,
      tax: 6.25,
      total: 131.25,
    });
    // Two prices: dining at 30 (most sold, first) and parcel at 35.
    expect(tea.prices).toEqual([
      { unitPrice: 30, orderType: 'dining', quantity: 3, amount: 90, tax: 4.5 },
      { unitPrice: 35, orderType: 'parcel', quantity: 1, amount: 35, tax: 1.75 },
    ]);
    expect(tea.byPeriod).toEqual({
      '2025-03-01': { quantity: 2, amount: 60 },
      '2025-03-02': { quantity: 2, amount: 65 },
    });

    // The late-night bill lands on the café's 2nd, not UTC's 1st.
    const sandwich = items.find((item: { productCode: string }) => item.productCode === 'SNK001');
    expect(sandwich.byPeriod).toEqual({
      '2025-03-01': { quantity: 1, amount: 140 },
      '2025-03-02': { quantity: 1, amount: 140 },
    });

    // Highest takings first.
    expect(items.map((item: { productCode: string }) => item.productCode)).toEqual([
      'SNK001',
      'BEV001',
      'OLD001',
    ]);
  });

  it('groups by today’s menu category, and keeps deleted codes visible', async () => {
    const report = await h.api('GET', '/admin/sales/items?from=2025-03-01&to=2025-03-02', {
      token: h.tokens.admin,
    });
    const retired = report.data.items.find(
      (item: { productCode: string }) => item.productCode === 'OLD001',
    );
    expect(retired.category).toBe('Uncategorised');

    expect(report.data.categories).toEqual([
      { category: 'Snacks', itemCount: 1, quantity: 2, amount: 280, tax: 14, total: 294 },
      { category: 'Beverages', itemCount: 1, quantity: 4, amount: 125, tax: 6.25, total: 131.25 },
      { category: 'Uncategorised', itemCount: 1, quantity: 1, amount: 100, tax: 5, total: 105 },
    ]);
  });

  it('buckets by calendar month, listing every month in the range', async () => {
    const report = await h.api(
      'GET',
      '/admin/sales/items?from=2025-02-15&to=2025-05-01&period=month',
      { token: h.tokens.admin },
    );
    expect(report.data.period).toBe('month');
    expect(report.data.periods).toEqual(['2025-02', '2025-03', '2025-04', '2025-05']);

    const sandwich = report.data.items.find(
      (item: { productCode: string }) => item.productCode === 'SNK001',
    );
    expect(sandwich.byPeriod).toEqual({
      '2025-03': { quantity: 2, amount: 280 },
      '2025-04': { quantity: 2, amount: 280 },
    });
    expect(sandwich.quantity).toBe(4);
  });

  it('returns an empty report for a range with no sales', async () => {
    const report = await h.api('GET', '/admin/sales/items?from=2025-01-01&to=2025-01-03', {
      token: h.tokens.admin,
    });
    expect(report.data.items).toEqual([]);
    expect(report.data.categories).toEqual([]);
    expect(report.data.totals).toEqual({ bills: 0, quantity: 0, amount: 0, tax: 0, total: 0 });
  });

  it('rejects an unknown period and a backwards range', async () => {
    const week = await h.api('GET', '/admin/sales/items?period=week', { token: h.tokens.admin });
    expect(week.status).toBe(400);
    expect(Array.isArray(week.error?.details)).toBe(true);

    const backwards = await h.api('GET', '/admin/sales/items?from=2025-03-05&to=2025-03-01', {
      token: h.tokens.admin,
    });
    expect(backwards.status).toBe(400);
  });

  it('is the owner’s screen only', async () => {
    for (const token of [h.tokens.billing, h.tokens.waiter, h.tokens.kitchen]) {
      const result = await h.api('GET', '/admin/sales/items', { token });
      expect(result.status).toBe(403);
    }
  });
});

describe('GET /admin/sales/items/xlsx', () => {
  it('downloads the report as a workbook', async () => {
    const response = await fetch(
      `${h.ctx.baseUrl}/admin/sales/items/xlsx?from=2025-03-01&to=2025-03-02`,
      { headers: { Authorization: `Bearer ${h.tokens.admin}` } },
    );
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('spreadsheetml');
    expect(response.headers.get('content-disposition')).toContain(
      'item-sales-2025-03-01-to-2025-03-02.xlsx',
    );
    expect(body.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('is the owner’s download only', async () => {
    const response = await fetch(`${h.ctx.baseUrl}/admin/sales/items/xlsx`, {
      headers: { Authorization: `Bearer ${h.tokens.billing}` },
    });
    expect(response.status).toBe(403);
  });
});
