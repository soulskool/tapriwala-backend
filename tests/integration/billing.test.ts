import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  customerOrder,
  findTicket,
  serveEverything,
  setItemStatus,
  waiterOrder,
  type Harness,
} from '../helpers/harness.js';

/**
 * The counter screen — §4.4 and the worked example in §4.5.
 *
 * The whole point: zero retyping. Everything below is computed from the same
 * item rows the kitchen cooked from.
 */

let h: Harness;
let sessionId = '';
let exportId = '';

beforeAll(async () => {
  h = await createHarness();

  // M2 orders in three rounds, exactly like the plan's worked example.
  const round1 = await customerOrder(
    h,
    'M2',
    [
      { productCode: 'BEV001', quantity: 2 },
      { productCode: 'SNK001', quantity: 1 },
    ],
    'bill-round-1',
  );
  sessionId = round1.data.sessionId;

  await customerOrder(h, 'M2', [{ productCode: 'BEV003', quantity: 1 }], 'bill-round-2');
  await waiterOrder(h, sessionId, [{ productCode: 'SNK001', quantity: 1 }], 'bill-round-3');
});

afterAll(async () => {
  await h.close();
});

describe('consolidation', () => {
  it('merges the same product across rounds, unlike the KDS', async () => {
    const bill = await h.api('GET', `/billing/${sessionId}/consolidate`, {
      token: h.tokens.billing,
    });
    const sandwich = bill.data.lines.find((l: any) => l.productCode === 'SNK001');

    // Ordered in round 1 and again in round 3 — one bill line, quantity 2.
    expect(sandwich.quantity).toBe(2);
    expect(sandwich.rounds).toEqual([1, 3]);
    expect(bill.data.roundCount).toBe(3);
  });

  it('computes money from the item snapshots', async () => {
    const bill = await h.api('GET', `/billing/${sessionId}/consolidate`, {
      token: h.tokens.billing,
    });

    // 2 tea @30 + 2 sandwich @140 + 1 cold coffee @120
    const expected = 2 * 30 + 2 * 140 + 120;
    expect(bill.data.subtotal).toBe(expected);
    expect(bill.data.tax).toBeCloseTo(expected * 0.05, 2);
    expect(bill.data.total).toBeCloseTo(bill.data.subtotal + bill.data.tax, 2);
  });

  it('gives the counter the exact POS codes and names to type', async () => {
    const bill = await h.api('GET', `/billing/${sessionId}/consolidate`, {
      token: h.tokens.billing,
    });

    // This is what removes "search by name" from the counter's job.
    expect(bill.data.lines.every((l: any) => l.productCode && l.posName)).toBe(true);
  });

  it('is read-only and safe to poll while the table is still ordering', async () => {
    const first = await h.api('GET', `/billing/${sessionId}/consolidate`, {
      token: h.tokens.billing,
    });
    const second = await h.api('GET', `/billing/${sessionId}/consolidate`, {
      token: h.tokens.billing,
    });
    expect(first.data.total).toBe(second.data.total);
  });

  it('excludes cancelled items but still lists them for scrutiny', async () => {
    const extra = await waiterOrder(
      h,
      sessionId,
      [{ productCode: 'BEV002', quantity: 1 }],
      'bill-round-4',
    );
    await setItemStatus(
      h,
      extra.data._id,
      extra.data.items[0]._id,
      'cancelled',
      h.tokens.waiter,
      'ordered by mistake',
    );

    const bill = await h.api('GET', `/billing/${sessionId}/consolidate`, {
      token: h.tokens.billing,
    });

    expect(bill.data.lines.some((l: any) => l.productCode === 'BEV002')).toBe(false);
    expect(bill.data.cancelledLines.some((l: any) => l.productCode === 'BEV002')).toBe(true);
  });

  it('exports the same figures as CSV', async () => {
    const response = await fetch(`${h.ctx.baseUrl}/billing/${sessionId}/csv`, {
      headers: { Authorization: `Bearer ${h.tokens.billing}` },
    });
    const csv = await response.text();

    expect(csv.startsWith('ProductCode,PosName')).toBe(true);
    // The order type sits between the name and the quantity — a POS importer
    // reading by column position needs the header, which is asserted above.
    expect(csv).toContain('SNK001,VEG SANDWICH,dining,2');
  });
});

describe('POS hand-off', () => {
  it('freezes the bill into an immutable export', async () => {
    const result = await h.api('POST', `/billing/${sessionId}/export`, {
      token: h.tokens.billing,
      body: { method: 'manual_display' },
    });

    expect(result.success).toBe(true);
    expect(result.data.export.billNumber).toBeGreaterThan(0);
    expect(result.data.export.lineItems.length).toBeGreaterThan(0);
    expect(result.data.export.exportStatus).toBe('sent');

    exportId = result.data.export._id;
  });

  it('keeps the frozen lines even if the menu changes afterwards', async () => {
    const products = await h.api('GET', '/products?search=Masala', { token: h.tokens.admin });
    await h.api('PATCH', `/products/${products.data[0]._id}`, {
      token: h.tokens.admin,
      body: { price: 500 },
    });

    const record = await h.api('GET', `/billing/exports/${exportId}`, { token: h.tokens.billing });
    const tea = record.data.lineItems.find((l: any) => l.productCode === 'BEV001');
    expect(tea.unitPrice).toBe(30);

    await h.api('PATCH', `/products/${products.data[0]._id}`, {
      token: h.tokens.admin,
      body: { price: 30 },
    });
  });

  it('fails loudly when the POS API is unconfigured, without blocking the bill', async () => {
    const result = await h.api('POST', `/billing/${sessionId}/export`, {
      token: h.tokens.billing,
      body: { method: 'api' },
    });

    // 201: the bill exists and can be printed. Only the hand-off failed.
    expect(result.status).toBe(201);
    expect(result.data.export.exportStatus).toBe('failed');
    expect(result.data.export.lastError).toContain('not configured');
  });

  it('can retry a failed export', async () => {
    const failed = await h.api('GET', '/billing/exports?status=failed', {
      token: h.tokens.billing,
    });
    const result = await h.api('POST', `/billing/exports/${failed.data[0]._id}/retry`, {
      token: h.tokens.billing,
      body: { method: 'csv' },
    });

    expect(result.data.exportStatus).toBe('sent');
    expect(result.data.attempts).toBe(2);
  });

  it('records the invoice number the legacy POS printed', async () => {
    await h.api('PATCH', `/billing/exports/${exportId}`, {
      token: h.tokens.billing,
      body: { exportStatus: 'confirmed', posReferenceId: 'INV-4471' },
    });

    const record = await h.api('GET', `/billing/exports/${exportId}`, { token: h.tokens.billing });
    // This is what makes our session and their bill reconcilable months later.
    expect(record.data.posReferenceId).toBe('INV-4471');
    expect(record.data.confirmedAt).toBeTruthy();
  });

  it('refuses to generate a bill for a table that ordered nothing', async () => {
    await h.api('POST', '/sessions', {
      token: h.tokens.waiter,
      body: { tableId: h.tables.L5!._id },
    });
    const empty = await h.api('GET', '/tables', { token: h.tokens.billing });
    const l5 = empty.data.tables.find((t: any) => t.code === 'L5');

    const result = await h.api('POST', `/billing/${l5.sessionId}/export`, {
      token: h.tokens.billing,
      body: {},
    });
    expect(result.status).toBe(422);
  });
});

describe('closing out', () => {
  it('closes once the kitchen is done and frees the table', async () => {
    const ticket = await findTicket(h, sessionId);
    if (ticket) await serveEverything(h, sessionId);

    const closed = await h.api('POST', `/sessions/${sessionId}/close`, {
      token: h.tokens.billing,
      body: { billingExportId: exportId },
    });

    expect(closed.data.status).toBe('closed');
    expect(closed.data.closedBy.role).toBe('billing');
  });

  it('does not write anything off when the close came with a bill', async () => {
    // The free-without-billing path cancels whatever the kitchen had not
    // finished, so the ticket leaves the board. That must NOT happen here: the
    // guest paid for these items, and marking them cancelled would make our
    // history disagree with the invoice they are holding.
    const rounds = await h.api('GET', `/sessions/${sessionId}/rounds`, {
      token: h.tokens.billing,
    });
    const items = rounds.data.flatMap((round: any) => round.items);
    const written = items.filter(
      (item: any) => item.cancelReason === 'Table freed without billing',
    );

    expect(written).toHaveLength(0);
  });

  it('keeps the bill queryable after the table has turned over', async () => {
    const record = await h.api('GET', `/billing/exports/${exportId}`, { token: h.tokens.billing });
    expect(record.data.billNumber).toBeGreaterThan(0);

    const detail = await h.api('GET', `/sessions/${sessionId}`, { token: h.tokens.billing });
    expect(detail.data.rounds.length).toBe(4);
  });

  it('keeps billing routes away from the kitchen', async () => {
    expect((await h.api('GET', '/billing/queue', { token: h.tokens.kitchen })).status).toBe(403);
  });
});
