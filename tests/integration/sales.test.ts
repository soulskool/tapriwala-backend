import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingExport } from '../../src/models/index.js';
import { salesToday, shiftDay } from '../../src/services/billing.service.js';
import { createHarness, customerOrder, type Harness } from '../helpers/harness.js';

/**
 * Rounded bills, and the owner's day-wise sales screen built from them.
 *
 * Money again, so the assertions are exact: a day's total is what the counter
 * actually collected — paid bills only, each rounded to the rupee.
 */

let h: Harness;

/** Saves the table's bill and, unless told otherwise, marks it paid. */
async function bill(sessionId: string, paid = true) {
  const result = await h.api('POST', `/billing/${sessionId}/export`, {
    token: h.tokens.billing,
    body: { method: 'manual_display' },
  });
  const record = result.data.export;
  if (paid) {
    await h.api('PATCH', `/billing/exports/${record._id}`, {
      token: h.tokens.billing,
      body: { exportStatus: 'confirmed' },
    });
  }
  return record;
}

/** A bill as one saved before rounding existed: no `roundOff` key at all. */
async function insertLegacyBill(billNumber: number, generatedAt: Date, total: number) {
  await BillingExport.collection.insertOne({
    sessionId: new Types.ObjectId(),
    tableId: new Types.ObjectId(),
    tableCode: 'M1',
    billNumber,
    generatedAt,
    generatedBy: { role: 'billing', userId: null, name: 'Old counter' },
    lineItems: [],
    subtotal: total,
    tax: 0,
    total,
    exportMethod: 'manual_display',
    exportStatus: 'confirmed',
    attempts: 1,
    note: '',
  });
}

let roundedBillTotal = 0;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('rounded bills', () => {
  it('charges whole rupees and shows the round off', async () => {
    // One tea: 30 + 1.50 tax = 31.50, which the guest pays as 32.
    const order = await customerOrder(
      h,
      'M2',
      [{ productCode: 'BEV001', quantity: 1 }],
      'sales-round-1',
    );
    const consolidated = await h.api('GET', `/billing/${order.data.sessionId}/consolidate`, {
      token: h.tokens.billing,
    });

    expect(consolidated.data.subtotal).toBe(30);
    expect(consolidated.data.tax).toBe(1.5);
    expect(consolidated.data.roundOff).toBe(0.5);
    expect(consolidated.data.total).toBe(32);

    // The saved bill freezes the same figures.
    const record = await bill(order.data.sessionId);
    expect(record.total).toBe(32);
    expect(record.roundOff).toBe(0.5);
    roundedBillTotal = record.total;
  });
});

describe('GET /admin/sales/daily', () => {
  it('counts today’s paid bills and ignores unpaid ones', async () => {
    // A bill saved but never paid — superseded, or a walk-out. Not a sale.
    const unpaid = await customerOrder(
      h,
      'R1',
      [{ productCode: 'SNK001', quantity: 1 }],
      'sales-round-2',
    );
    await bill(unpaid.data.sessionId, false);

    const report = await h.api('GET', '/admin/sales/daily', { token: h.tokens.admin });
    const today = report.data.days[0];

    expect(report.data.to).toBe(salesToday());
    expect(report.data.days).toHaveLength(30);
    expect(today.date).toBe(salesToday());
    expect(today).toMatchObject({ bills: 1, subtotal: 30, tax: 1.5, roundOff: 0.5, total: 32 });
    expect(report.data.totals.total).toBe(roundedBillTotal);
  });

  it('books a bill to the café’s day, not the server’s UTC day', async () => {
    // 2026-09-01 20:00 UTC is 01:30 on the 2nd in IST.
    await insertLegacyBill(900001, new Date('2026-09-01T20:00:00.000Z'), 100);
    // 2026-09-01 18:29 UTC is 23:59 on the 1st in IST.
    await insertLegacyBill(900002, new Date('2026-09-01T18:29:00.000Z'), 40.5);

    const report = await h.api('GET', '/admin/sales/daily?from=2026-09-01&to=2026-09-02', {
      token: h.tokens.admin,
    });

    // Newest first, both days present.
    expect(report.data.days.map((d: { date: string }) => d.date)).toEqual([
      '2026-09-02',
      '2026-09-01',
    ]);
    expect(report.data.days[0]).toMatchObject({ bills: 1, total: 100 });
    // A legacy bill has no roundOff stored, and reads as zero rather than NaN.
    expect(report.data.days[1]).toMatchObject({ bills: 1, total: 40.5, roundOff: 0 });
    expect(report.data.totals).toMatchObject({ bills: 2, total: 140.5 });
  });

  it('fills a day with no bills with zeros instead of skipping it', async () => {
    const report = await h.api('GET', '/admin/sales/daily?from=2026-08-01&to=2026-08-03', {
      token: h.tokens.admin,
    });
    expect(report.data.days).toHaveLength(3);
    expect(report.data.days.every((d: { bills: number }) => d.bills === 0)).toBe(true);
  });

  it('rejects a backwards range, a too-long range and a timestamp', async () => {
    const backwards = await h.api('GET', '/admin/sales/daily?from=2026-09-05&to=2026-09-01', {
      token: h.tokens.admin,
    });
    expect(backwards.status).toBe(400);
    expect(Array.isArray(backwards.error?.details)).toBe(true);

    const to = salesToday();
    const tooLong = await h.api('GET', `/admin/sales/daily?from=${shiftDay(to, -366)}&to=${to}`, {
      token: h.tokens.admin,
    });
    expect(tooLong.status).toBe(400);

    const stamp = await h.api('GET', '/admin/sales/daily?from=2026-09-01T00:00:00Z', {
      token: h.tokens.admin,
    });
    expect(stamp.status).toBe(400);
  });

  it('is the owner’s screen only', async () => {
    for (const token of [h.tokens.billing, h.tokens.waiter, h.tokens.kitchen]) {
      const result = await h.api('GET', '/admin/sales/daily', { token });
      expect(result.status).toBe(403);
    }
  });
});
