import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog, OrderRound, TableSession } from '../../src/models/index.js';
import {
  createHarness,
  customerOrder,
  findTicket,
  tile,
  type Harness,
} from '../helpers/harness.js';

/**
 * "M1's orders go to L1": the table the guests left is free straight away.
 *
 * Onto an empty table the whole session moves; onto an open one the orders
 * join that table's order and the old session closes. Either way the kitchen
 * keeps cooking, the bill is one ordinary bill, and the floor shows where the
 * orders came from.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

function transfer(sessionId: string, toTable: string, token = h.tokens.waiter, reason?: string) {
  return h.api('POST', `/sessions/${sessionId}/transfer`, {
    token,
    body: { toTableId: h.tables[toTable]!._id, ...(reason ? { reason } : {}) },
  });
}

describe('transferring to an empty table', () => {
  let sessionId = '';

  beforeAll(async () => {
    sessionId = (
      await customerOrder(h, 'M1', [{ productCode: 'BEV001', quantity: 2 }], 'empty-move-m1')
    ).data.sessionId;
  });

  it('refuses the same table', async () => {
    expect((await transfer(sessionId, 'M1')).status).toBe(400);
  });

  it('lets a waiter move the session without a reason, and frees the old table', async () => {
    const result = await transfer(sessionId, 'L5');

    expect(result.status).toBe(200);
    expect(result.data.tableCode).toBe('L5');
    expect(String(result.data._id)).toBe(sessionId);
    expect((await tile(h, 'M1')).status).toBe('empty');
    expect((await tile(h, 'L5')).sessionId).toBe(sessionId);
  });

  it('renames the kitchen ticket and keeps it cooking', async () => {
    const ticket = await findTicket(h, sessionId);
    expect(ticket.tableCode).toBe('L5');
    expect(ticket.items.every((item: any) => item.status === 'pending')).toBe(true);
  });

  it('shows "from M1" on the floor', async () => {
    expect((await tile(h, 'L5')).transferredFrom).toEqual(['M1']);
  });

  it('gives the next guest at M1 a fresh order', async () => {
    const next = await customerOrder(
      h,
      'M1',
      [{ productCode: 'BEV002', quantity: 1 }],
      'm1-next-guest',
    );
    expect(next.data.sessionId).not.toBe(sessionId);
    expect((await tile(h, 'M1')).transferredFrom).toEqual([]);
  });
});

describe('transferring to a table that already has an order', () => {
  let from = '';
  let into = '';

  beforeAll(async () => {
    // The same idempotency key on both phones: the merge must not collide.
    from = (await customerOrder(h, 'M2', [{ productCode: 'BEV001', quantity: 1 }], 'same-key')).data
      .sessionId;
    await customerOrder(h, 'M2', [{ productCode: 'BEV002', quantity: 1 }], 'm2-second');
    into = (await customerOrder(h, 'R1', [{ productCode: 'BEV001', quantity: 2 }], 'same-key')).data
      .sessionId;
  });

  it('adds the orders to the open table and frees the old one at once', async () => {
    const before = (await tile(h, 'M2')).runningTotal + (await tile(h, 'R1')).runningTotal;

    const result = await transfer(from, 'R1', h.tokens.waiter, 'Party moved inside');
    expect(result.status).toBe(200);
    expect(String(result.data._id)).toBe(into);
    expect(result.message).toContain('M2 is free');

    expect((await tile(h, 'M2')).status).toBe('empty');
    const r1 = await tile(h, 'R1');
    expect(r1.sessionId).toBe(into);
    expect(r1.runningTotal).toBe(before);
    expect(r1.roundCount).toBe(3);
    expect(r1.transferredFrom).toEqual(['M2']);
  });

  it('numbers the moved rounds after the table’s own, and cancels nothing', async () => {
    const rounds = await OrderRound.find({ sessionId: into }).sort({ roundNumber: 1 }).lean();
    expect(rounds.map((round) => round.roundNumber)).toEqual([1, 2, 3]);
    expect(rounds.every((round) => round.tableCode === 'R1')).toBe(true);
    expect(rounds.flatMap((r) => r.items).some((i) => i.status === 'cancelled')).toBe(false);
    expect(await OrderRound.countDocuments({ sessionId: from })).toBe(0);
  });

  it('closes the old session and logs who moved what', async () => {
    const old = await TableSession.findById(from).lean();
    expect(old!.isActive).toBe(false);

    const audit = await AuditLog.findOne({ action: 'session.transferred', sessionId: from }).lean();
    expect(audit!.actor.name).toBe('Test Waiter');
    expect(audit!.meta).toMatchObject({
      fromTableCode: 'M2',
      toTableCode: 'R1',
      merged: true,
      reason: 'Party moved inside',
    });
  });

  it('puts everything on one ordinary bill, with no mention of the old table', async () => {
    const bill = await h.api('GET', `/billing/${into}/consolidate`, { token: h.tokens.billing });
    expect(bill.status).toBe(200);
    expect(bill.data.tableCode).toBe('R1');
    const tea = bill.data.lines.find((line: any) => line.productCode === 'BEV001');
    expect(tea.quantity).toBe(3);
    expect(JSON.stringify(bill.data.lines)).not.toContain('M2');
  });

  it('keeps numbering the next order after the moved rounds', async () => {
    const next = await customerOrder(h, 'R1', [{ productCode: 'BEV002', quantity: 1 }], 'r1-after');
    expect(next.status).toBe(201);
    expect(next.data.roundNumber).toBe(4);
  });

  it('refuses once the destination’s bill has been generated', async () => {
    const v1 = (
      await customerOrder(h, 'V1', [{ productCode: 'BEV001', quantity: 1 }], 'v1-late-order')
    ).data.sessionId;
    const exported = await h.api('POST', `/billing/${into}/export`, {
      token: h.tokens.billing,
      body: {},
    });
    expect(exported.status).toBe(201);

    const result = await transfer(v1, 'R1');
    expect(result.status).toBe(422);
    expect((await tile(h, 'V1')).sessionId).toBe(v1);
  });
});
