import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  customerOrder,
  tile,
  waiterOrder,
  type Harness,
} from '../helpers/harness.js';

/**
 * The customer QR ordering flow and add-on rounds — §4.1 and §4.5 of the plan.
 */

let h: Harness;
let sessionId = '';
let kot1 = '';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('QR resolution', () => {
  it('resolves a table code to its table, with no session before the first order', async () => {
    const result = await h.api('GET', `/public/tables/${h.tables.M2!.code}`);

    expect(result.data.table.code).toBe('M2');
    expect(result.data.session).toBeNull();
  });

  it('accepts the code in the case the guest happened to type', async () => {
    const result = await h.api('GET', '/public/tables/m2');
    expect(result.data.table.code).toBe('M2');
  });

  it('rejects a well-formed code that is not one of ours', async () => {
    expect((await h.api('GET', '/public/tables/ZZ9')).status).toBe(401);
  });

  it('rejects a malformed code before it reaches a query', async () => {
    // Long enough that it was never a code we printed, so it is a validation
    // failure rather than a wrong-table failure. Guards the database from
    // arbitrary strings now that the URL segment is user-typeable.
    expect((await h.api('GET', '/public/tables/thisisnotarealtokenatall12345')).status).toBe(400);
  });

  it('hides internal POS names from a customer phone', async () => {
    const menu = await h.api('GET', `/public/tables/${h.tables.M2!.code}/menu`);

    expect(menu.data.categories.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(menu.data)).not.toContain('posName');
  });
});

describe('placing the first order', () => {
  it('opens a session, numbers the round and issues a KOT', async () => {
    const result = await customerOrder(
      h,
      'M2',
      [
        { productCode: 'BEV001', quantity: 2 },
        { productCode: 'SNK001', quantity: 1, specialInstructions: 'No onion please' },
      ],
      'test-round-1',
    );

    expect(result.success).toBe(true);
    expect(result.data.roundNumber).toBe(1);
    expect(result.data.kotId).toMatch(/^\d+$/);

    sessionId = result.data.sessionId;
    kot1 = result.data.kotId;
  });

  it('does not occupy the table until an order is actually placed', async () => {
    // M1 has only been browsed, never ordered on.
    expect((await tile(h, 'M1')).status).toBe('empty');
    expect((await tile(h, 'M2')).status).not.toBe('empty');
  });

  it('treats a replayed submission as the same order, not a second ticket', async () => {
    const retry = await customerOrder(
      h,
      'M2',
      [{ productCode: 'BEV001', quantity: 2 }],
      'test-round-1',
    );

    expect(retry.status).toBe(200);
    expect(retry.data.kotId).toBe(kot1);
  });

  it('scopes the idempotency key to the session, so tables cannot collide', async () => {
    // Same key, different table: must create a genuinely new order.
    const other = await customerOrder(
      h,
      'R1',
      [{ productCode: 'BEV001', quantity: 1 }],
      'test-round-1',
    );

    expect(other.status).toBe(201);
    expect(other.data.sessionId).not.toBe(sessionId);
    expect(other.data.kotId).not.toBe(kot1);
  });
});

describe('order validation', () => {
  it('refuses an unknown product code', async () => {
    const result = await customerOrder(h, 'M2', [{ productCode: 'NOPE', quantity: 1 }]);
    expect(result.status).toBe(400);
  });

  it('refuses an absurd quantity', async () => {
    const result = await customerOrder(h, 'M2', [{ productCode: 'BEV001', quantity: 500 }]);
    expect(result.status).toBe(400);
  });

  it('refuses an empty cart', async () => {
    const result = await customerOrder(h, 'M2', []);
    expect(result.status).toBe(400);
  });

  it('prices from the server, ignoring anything the client sends', async () => {
    // On R4, not M2 — this places a real round, and M2's round numbering is
    // asserted below.
    const result = await h.api('POST', `/public/tables/${h.tables.R4!.code}/orders`, {
      body: {
        items: [{ productCode: 'SNK001', quantity: 1, unitPrice: 1, price: 1 }],
        idempotencyKey: 'tamper-attempt-1',
      },
    });

    // The sandwich is 140 regardless of what the request claimed.
    expect(result.data.total).toBe(147);
  });

  it('merges identical lines but keeps different instructions apart', async () => {
    const result = await customerOrder(
      h,
      'V1',
      [
        { productCode: 'BEV001', quantity: 1 },
        { productCode: 'BEV001', quantity: 1 },
        { productCode: 'BEV001', quantity: 1, specialInstructions: 'no sugar' },
      ],
      'merge-check-1',
    );

    expect(result.data.items).toHaveLength(2);
    expect(result.data.items.find((i: any) => i.quantity === 2)).toBeDefined();
  });
});

describe('add-on rounds', () => {
  it('attaches a later customer order to the same session', async () => {
    const round2 = await customerOrder(
      h,
      'M2',
      [{ productCode: 'BEV003', quantity: 1 }],
      'test-round-2',
    );

    expect(round2.data.sessionId).toBe(sessionId);
    expect(round2.data.roundNumber).toBe(2);
  });

  it('accepts a waiter round on the same session, tagged by source', async () => {
    const round3 = await waiterOrder(
      h,
      sessionId,
      [{ productCode: 'SNK001', quantity: 1 }],
      'test-round-3',
    );

    expect(round3.data.roundNumber).toBe(3);
    expect(round3.data.source).toBe('waiter');
  });

  it('keeps one running total across every round', async () => {
    const detail = await h.api('GET', `/sessions/${sessionId}`, { token: h.tokens.waiter });

    expect(detail.data.rounds).toHaveLength(3);
    // 2 tea @30 + 1 sandwich @140 + 1 cold coffee @120 + 1 sandwich @140
    expect(detail.data.totals.subtotal).toBe(460);
  });
});

describe('order status for the customer', () => {
  it('reports live status without exposing staff-only fields', async () => {
    const status = await h.api('GET', `/public/tables/${h.tables.M2!.code}/order-status`);

    expect(status.data.rounds).toHaveLength(3);
    expect(status.data.rounds[0].items[0]).toHaveProperty('status');
    expect(JSON.stringify(status.data)).not.toContain('posName');
    expect(JSON.stringify(status.data)).not.toContain('unitPrice');
  });

  it('says so plainly when a table has no order', async () => {
    const status = await h.api('GET', `/public/tables/${h.tables.M1!.code}/order-status`);
    expect(status.data.session).toBeNull();
    expect(status.data.rounds).toEqual([]);
  });
});
