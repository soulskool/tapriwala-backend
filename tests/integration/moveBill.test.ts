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
 * Two tables, one bill: M2's party says "put it all on M1".
 *
 * The kitchen keeps cooking for M2 as M2; only the bill moves. M1's bill is an
 * ordinary bill with M2's items merged in, and when it is paid M2 closes too.
 */

let h: Harness;
let m1 = '';
let m2 = '';

beforeAll(async () => {
  h = await createHarness();
  m1 = (await customerOrder(h, 'M1', [{ productCode: 'BEV001', quantity: 2 }], 'move-m1-first'))
    .data.sessionId;
  m2 = (await customerOrder(h, 'M2', [{ productCode: 'BEV001', quantity: 1 }], 'move-m2-first'))
    .data.sessionId;
});

afterAll(async () => {
  await h.close();
});

function moveBill(sessionId: string, toTable: string, token = h.tokens.waiter, reason?: string) {
  return h.api('POST', `/sessions/${sessionId}/move-bill`, {
    token,
    body: { toTableId: h.tables[toTable]!._id, ...(reason ? { reason } : {}) },
  });
}

function bill(sessionId: string) {
  return h.api('GET', `/billing/${sessionId}/consolidate`, { token: h.tokens.billing });
}

describe('moving a bill', () => {
  it('refuses a table with no open order', async () => {
    const result = await moveBill(m2, 'R1');
    expect(result.status).toBe(422);
    expect(result.error!.message).toContain('no open order');
  });

  it('refuses the same table', async () => {
    expect((await moveBill(m2, 'M2')).status).toBe(400);
  });

  it('lets a waiter put M2 on M1’s bill, and logs who did it', async () => {
    const result = await moveBill(m2, 'M1', h.tokens.waiter, 'One party');
    expect(result.status).toBe(200);

    const audit = await AuditLog.findOne({ action: 'session.bill_moved' }).lean();
    expect(audit!.actor.name).toBe('Test Waiter');
    expect(audit!.tableCode).toBe('M2');
    expect(audit!.meta).toMatchObject({ toTableCode: 'M1', reason: 'One party' });
  });

  it('bills M1 for both tables as one ordinary bill', async () => {
    const result = await bill(m1);
    expect(result.status).toBe(200);
    expect(result.data.tableCode).toBe('M1');
    const tea = result.data.lines.find(
      (line: { productCode: string }) => line.productCode === 'BEV001',
    );
    expect(tea.quantity).toBe(3);
  });

  it('will not bill M2 on its own', async () => {
    const result = await bill(m2);
    expect(result.status).toBe(422);
    expect(result.error!.message).toContain('M1');
  });

  it('marks both tiles on the floor', async () => {
    expect((await tile(h, 'M2')).billWithTableCode).toBe('M1');
    const payer = await tile(h, 'M1');
    expect(payer.billIncludes).toEqual(['M2']);
    // The paying tile carries both tables' money.
    const own = await TableSession.find({ _id: { $in: [m1, m2] } }).lean();
    expect(payer.runningTotal).toBe(own.reduce((sum, s) => sum + s.runningTotal, 0));
  });

  it('shows the moved table’s rounds and the whole-bill total on the paying table', async () => {
    const detail = (await h.api('GET', `/sessions/${m1}`, { token: h.tokens.waiter })).data;
    expect(detail.billIncludes).toHaveLength(1);
    expect(detail.billIncludes[0].tableCode).toBe('M2');
    expect(detail.billIncludes[0].rounds).toHaveLength(1);
    expect(detail.billTotals.total).toBeCloseTo(
      detail.totals.total + detail.billIncludes[0].totals.total,
      2,
    );
  });

  it('keeps the kitchen ticket on M2, where the food goes', async () => {
    const ticket = await findTicket(h, m2);
    expect(ticket.tableCode).toBe('M2');
  });

  it('puts a later order from M2 on M1’s bill too', async () => {
    await customerOrder(h, 'M2', [{ productCode: 'BEV001', quantity: 1 }], 'move-m2-second');
    const tea = (await bill(m1)).data.lines.find(
      (line: { productCode: string }) => line.productCode === 'BEV001',
    );
    expect(tea.quantity).toBe(4);
  });

  it('can be undone before the bill is generated', async () => {
    const undone = await h.api('POST', `/sessions/${m2}/undo-bill-move`, {
      token: h.tokens.waiter,
    });
    expect(undone.status).toBe(200);
    expect((await bill(m2)).status).toBe(200);
    expect(
      (await AuditLog.findOne({ action: 'session.bill_move_undone' }).lean())!.actor.name,
    ).toBe('Test Waiter');

    expect((await moveBill(m2, 'M1')).status).toBe(200);
  });
});

describe('a chain of moves', () => {
  let r1 = '';

  it('takes M2 along when M1’s bill moves on to R1', async () => {
    r1 = (await customerOrder(h, 'R1', [{ productCode: 'BEV001', quantity: 1 }], 'move-r1-first'))
      .data.sessionId;
    expect((await moveBill(m1, 'R1')).status).toBe(200);

    const tea = (await bill(r1)).data.lines.find(
      (line: { productCode: string }) => line.productCode === 'BEV001',
    );
    expect(tea.quantity).toBe(5);
    expect((await TableSession.findById(m2).lean())!.billMovedTo!.toString()).toBe(r1);
    expect((await tile(h, 'R1')).billIncludes.sort()).toEqual(['M1', 'M2']);
  });

  it('refuses to move a bill onto a table that rides on it', async () => {
    expect((await moveBill(r1, 'M2')).status).toBe(400);
  });
});

describe('closing the paying table', () => {
  let r1 = '';

  beforeAll(async () => {
    r1 = String((await TableSession.findOne({ tableCode: 'R1', isActive: true }).lean())!._id);
  });

  it('is too late to undo once the bill is generated', async () => {
    const exported = await h.api('POST', `/billing/${r1}/export`, {
      token: h.tokens.billing,
      body: {},
    });
    expect(exported.status).toBe(201);

    const undone = await h.api('POST', `/sessions/${m2}/undo-bill-move`, {
      token: h.tokens.waiter,
    });
    expect(undone.status).toBe(422);
  });

  it('closes every table on the bill, without writing anything off', async () => {
    const exportId = (await h.api('GET', `/billing/exports?limit=1`, { token: h.tokens.billing }))
      .data[0]._id;

    const closed = await h.api('POST', `/sessions/${r1}/close`, {
      token: h.tokens.billing,
      body: { billingExportId: exportId, force: true },
    });
    expect(closed.status).toBe(200);

    for (const id of [m1, m2]) {
      const session = await TableSession.findById(id).lean();
      expect(session!.isActive).toBe(false);
    }
    // Paid for on R1's bill: nothing of M2's was cancelled as a write-off.
    const rounds = await OrderRound.find({ sessionId: m2 }).lean();
    expect(rounds.flatMap((r) => r.items).some((i) => i.status === 'cancelled')).toBe(false);
  });
});

describe('freeing the paying table without a bill', () => {
  it('gives the moved table its own bill back instead of closing it', async () => {
    const v1 = (
      await customerOrder(h, 'V1', [{ productCode: 'BEV001', quantity: 1 }], 'move-v1-first')
    ).data.sessionId;
    const l5 = (
      await customerOrder(h, 'L5', [{ productCode: 'BEV001', quantity: 1 }], 'move-l5-first')
    ).data.sessionId;
    expect((await moveBill(l5, 'V1')).status).toBe(200);

    await h.api('POST', `/sessions/${v1}/close`, {
      token: h.tokens.admin,
      body: { force: true, note: 'walked out' },
    });

    const l5Session = await TableSession.findById(l5).lean();
    expect(l5Session!.isActive).toBe(true);
    expect(l5Session!.billMovedTo).toBeNull();
    expect((await bill(l5)).status).toBe(200);

    const audit = await AuditLog.findOne({ action: 'session.bill_move_undone', tableCode: 'L5' })
      .sort({ timestamp: -1 })
      .lean();
    expect(audit!.meta).toMatchObject({ automatic: true });
  });
});

describe('edge cases', () => {
  let r4 = '';
  let m1 = '';

  beforeAll(async () => {
    r4 = (await customerOrder(h, 'R4', [{ productCode: 'BEV001', quantity: 1 }], 'edge-r4-first'))
      .data.sessionId;
    m1 = (await customerOrder(h, 'M1', [{ productCode: 'BEV001', quantity: 1 }], 'edge-m1-first'))
      .data.sessionId;
    expect((await moveBill(r4, 'M1')).status).toBe(200);
  });

  it('treats a repeated move to the same table as done, with one audit row', async () => {
    const again = await moveBill(r4, 'M1');
    expect(again.status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'session.bill_moved', tableCode: 'R4' })).toBe(
      1,
    );
  });

  it('stops a guest at the moved table ordering once the paying table asked for the bill', async () => {
    const asked = await h.api('POST', '/public/tables/M1/service-requests', {
      body: { type: 'bill' },
    });
    expect(asked.status).toBeLessThan(300);

    const order = await customerOrder(
      h,
      'R4',
      [{ productCode: 'BEV001', quantity: 1 }],
      'edge-r4-second',
    );
    expect(order.status).toBe(422);
  });

  it('lists only the paying table in the billing queue, with the moved one named', async () => {
    const queue = await h.api('GET', '/billing/queue', { token: h.tokens.billing });
    const rows = queue.data.sessions as { tableCode: string; billIncludes: string[] }[];
    expect(rows.map((row) => row.tableCode)).toContain('M1');
    expect(rows.map((row) => row.tableCode)).not.toContain('R4');
    expect(rows.find((row) => row.tableCode === 'M1')!.billIncludes).toEqual(['R4']);
  });

  it('will not take a closed table off the bill that carries its orders', async () => {
    await h.api('POST', `/sessions/${r4}/close`, {
      token: h.tokens.admin,
      body: { force: true, note: 'party moved over' },
    });
    const undone = await h.api('POST', `/sessions/${r4}/undo-bill-move`, {
      token: h.tokens.waiter,
    });
    expect(undone.status).toBe(422);

    // R4's served-or-not orders that were not written off are still on M1's bill.
    expect((await TableSession.findById(r4).lean())!.billMovedTo!.toString()).toBe(m1);
  });

  it('marks the paying bill for review when a moved table is held', async () => {
    const l5 = String(
      (await TableSession.findOne({ tableCode: 'L5', isActive: true }).lean())!._id,
    );
    await TableSession.updateOne({ _id: l5 }, { $set: { heldForReview: true } });
    expect((await moveBill(l5, 'M1')).status).toBe(200);

    expect((await bill(m1)).data.requiresReview).toBe(true);
    const closed = await h.api('POST', `/sessions/${m1}/close`, {
      token: h.tokens.billing,
      body: {},
    });
    expect(closed.status).toBe(422);
    expect(closed.error!.message).toContain('L5');
  });
});
