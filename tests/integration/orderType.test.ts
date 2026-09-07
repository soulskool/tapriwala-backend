import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  customerOrder,
  findTicket,
  waiterOrder,
  type Harness,
} from '../helpers/harness.js';

/**
 * Dining vs parcel.
 *
 * The type lives on the round rather than the session, so the two facts worth
 * pinning down are that one session can hold both, and that billing merges by
 * type as well as by product — a single "4 TEA" line printed under one heading
 * would be wrong about whichever teas went the other way.
 */

let h: Harness;

/** M1 holds the parcel round the KDS assertions read back. */
let parcelSessionId = '';
/** V1 holds the one session that is deliberately mixed. */
let mixedSessionId = '';

async function openOn(tableCode: string): Promise<string> {
  const session = await h.api('POST', '/sessions', {
    token: h.tokens.waiter,
    body: { tableId: h.tables[tableCode]!._id },
  });
  return session.data._id as string;
}

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('placing a round with a type', () => {
  it('defaults to dining when the client sends no type at all', async () => {
    const placed = await customerOrder(
      h,
      'M2',
      [{ productCode: 'BEV001', quantity: 1 }],
      'ot-default-dining',
    );

    const rounds = await h.api('GET', `/sessions/${placed.data.sessionId}/rounds`, {
      token: h.tokens.waiter,
    });
    expect(rounds.data[0].orderType).toBe('dining');
  });

  it('records a parcel round placed by a waiter', async () => {
    parcelSessionId = await openOn('M1');

    const placed = await waiterOrder(
      h,
      parcelSessionId,
      [{ productCode: 'BEV001', quantity: 2 }],
      'ot-parcel',
      'parcel',
    );
    expect(placed.success).toBe(true);

    const rounds = await h.api('GET', `/sessions/${parcelSessionId}/rounds`, {
      token: h.tokens.waiter,
    });
    expect(rounds.data[0].orderType).toBe('parcel');
  });

  it('rejects a type that is not one of ours', async () => {
    const sessionId = await openOn('R1');

    const result = await h.api('POST', `/sessions/${sessionId}/rounds`, {
      token: h.tokens.waiter,
      body: {
        items: [{ productCode: 'BEV001', quantity: 1 }],
        orderType: 'takeaway',
        idempotencyKey: 'ot-bogus',
      },
    });

    expect(result.status).toBe(400);
    expect(Array.isArray(result.error?.details)).toBe(true);
  });

  /**
   * The reason the public controller does not read this field off the body at
   * all. A guest able to mark their own order a parcel could walk out with
   * food the floor still believes is coming to a table.
   */
  it('ignores a type a customer QR order tries to claim', async () => {
    const placed = await h.api('POST', `/public/tables/${h.tables.R4!.code}/orders`, {
      body: {
        items: [{ productCode: 'BEV001', quantity: 1 }],
        orderType: 'parcel',
        idempotencyKey: 'ot-guest-claims-parcel',
      },
    });
    expect(placed.success).toBe(true);

    const rounds = await h.api('GET', `/sessions/${placed.data.sessionId}/rounds`, {
      token: h.tokens.waiter,
    });
    expect(rounds.data[0].orderType).toBe('dining');
  });
});

describe('the kitchen ticket', () => {
  it('carries the type and the name of whoever sent it', async () => {
    const ticket = await findTicket(h, parcelSessionId);

    expect(ticket.orderType).toBe('parcel');
    // The KOT prints this as the server name. An empty string would print a
    // blank line rather than crash, but it should not be empty.
    expect(ticket.placedByName.length).toBeGreaterThan(0);
  });
});

describe('consolidating a bill', () => {
  it('keeps one line when every round is the same type', async () => {
    const sessionId = await openOn('L5');
    await waiterOrder(h, sessionId, [{ productCode: 'BEV001', quantity: 2 }], 'ot-same-1');
    await waiterOrder(h, sessionId, [{ productCode: 'BEV001', quantity: 1 }], 'ot-same-2');

    const bill = await h.api('GET', `/billing/${sessionId}/consolidate`, {
      token: h.tokens.billing,
    });

    const tea = bill.data.lines.filter((line: any) => line.productCode === 'BEV001');
    expect(tea).toHaveLength(1);
    expect(tea[0].quantity).toBe(3);
    expect(bill.data.orderTypes).toEqual(['dining']);
  });

  it('splits the same product into two lines when one round was a parcel', async () => {
    mixedSessionId = await openOn('V1');
    await waiterOrder(
      h,
      mixedSessionId,
      [{ productCode: 'BEV001', quantity: 3 }],
      'ot-mixed-dining',
      'dining',
    );
    await waiterOrder(
      h,
      mixedSessionId,
      [{ productCode: 'BEV001', quantity: 1 }],
      'ot-mixed-parcel',
      'parcel',
    );

    const bill = await h.api('GET', `/billing/${mixedSessionId}/consolidate`, {
      token: h.tokens.billing,
    });

    const tea = bill.data.lines.filter((line: any) => line.productCode === 'BEV001');
    expect(tea).toHaveLength(2);
    expect(tea.find((line: any) => line.orderType === 'dining').quantity).toBe(3);
    expect(tea.find((line: any) => line.orderType === 'parcel').quantity).toBe(1);

    // Dining block first, so the paper does not interleave the two kinds.
    expect(tea[0].orderType).toBe('dining');
    expect(bill.data.orderTypes).toEqual(['dining', 'parcel']);

    // Splitting the line changes nothing about the money — four teas either way.
    expect(bill.data.itemCount).toBe(4);
  });

  it('freezes the type onto the saved bill, so a reprint still knows', async () => {
    const exported = await h.api('POST', `/billing/${mixedSessionId}/export`, {
      token: h.tokens.billing,
      body: { method: 'manual_display' },
    });
    expect(exported.success).toBe(true);

    const types = exported.data.export.lineItems.map((line: any) => line.orderType);
    expect(types).toContain('dining');
    expect(types).toContain('parcel');
  });
});
