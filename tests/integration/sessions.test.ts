import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  customerOrder,
  findTicket,
  setItemStatus,
  tile,
  type Harness,
} from '../helpers/harness.js';

/**
 * Session lifecycle and the concurrency guarantees around it: one live session
 * per table, transfers, and the manager-review hold.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('the live table grid', () => {
  it('returns every table with a status and its zones', async () => {
    const grid = await h.api('GET', '/tables', { token: h.tokens.waiter });

    expect(grid.data.tables).toHaveLength(6);
    expect(grid.data.zones).toEqual(expect.arrayContaining(['Middle', 'Right', 'Left', 'Veranda']));
    expect(grid.data.tables.find((t: any) => t.code === 'M2').status).toBe('empty');
  });

  it('carries the counts a tile needs to render without another request', async () => {
    await customerOrder(h, 'M1', [{ productCode: 'BEV001', quantity: 2 }], 'grid-1-order');
    const m1 = await tile(h, 'M1');

    expect(m1.status).toBe('order_pending');
    expect(m1.runningTotal).toBeGreaterThan(0);
    expect(m1.pendingItemCount).toBe(1);
    expect(m1.minutesOpen).toBeTypeOf('number');
    expect(m1).toHaveProperty('needsAttention');
  });
});

describe('one live session per table', () => {
  it('routes a waiter into the running session instead of opening a second', async () => {
    const result = await h.api('POST', '/sessions', {
      token: h.tokens.waiter,
      body: { tableId: h.tables.M1!._id },
    });

    // Tapping an occupied table is normal, not an error — land in "add items".
    expect(result.status).toBe(200);
    expect(result.message).toContain('already');
  });

  it('survives five simultaneous opens on an empty table', async () => {
    // The guarantee under test is a unique partial index, not an `if`.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.api('POST', '/sessions', {
          token: h.tokens.waiter,
          body: { tableId: h.tables.R4!._id },
        }),
      ),
    );

    const distinct = new Set(results.map((r) => String(r.data?._id)));
    expect(distinct.size).toBe(1);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
  });

  it('survives simultaneous first orders from two phones on one table', async () => {
    const [a, b] = await Promise.all([
      customerOrder(h, 'V1', [{ productCode: 'BEV001', quantity: 1 }], 'race-a-order'),
      customerOrder(h, 'V1', [{ productCode: 'BEV002', quantity: 1 }], 'race-b-order'),
    ]);

    // Two people at the same table, both ordering: one session, two rounds.
    expect(a.data.sessionId).toBe(b.data.sessionId);
    expect(new Set([a.data.roundNumber, b.data.roundNumber]).size).toBe(2);
  });
});

describe('transferring a session', () => {
  it('requires a reason', async () => {
    const r4 = await tile(h, 'R4');
    const result = await h.api('POST', `/sessions/${r4.sessionId}/transfer`, {
      token: h.tokens.billing,
      body: { toTableId: h.tables.L5!._id },
    });
    expect(result.status).toBe(400);
  });

  it('moves the session and frees the original table', async () => {
    const r4 = await tile(h, 'R4');
    const result = await h.api('POST', `/sessions/${r4.sessionId}/transfer`, {
      token: h.tokens.billing,
      body: { toTableId: h.tables.L5!._id, reason: 'wrong table opened' },
    });

    expect(result.data.tableCode).toBe('L5');
    expect((await tile(h, 'R4')).status).toBe('empty');
    expect((await tile(h, 'L5')).status).not.toBe('empty');
  });

  it('renames the KDS tickets so a cook sees the right table', async () => {
    const l5 = await tile(h, 'L5');
    const rounds = await h.api('GET', `/sessions/${l5.sessionId}/rounds`, {
      token: h.tokens.waiter,
    });
    expect(rounds.data.every((round: any) => round.tableCode === 'L5')).toBe(true);
  });

  it('refuses to move onto an occupied table', async () => {
    const m1 = await tile(h, 'M1');
    const result = await h.api('POST', `/sessions/${m1.sessionId}/transfer`, {
      token: h.tokens.billing,
      body: { toTableId: h.tables.L5!._id, reason: 'should fail' },
    });

    expect(result.status).toBe(409);
  });
});

describe('manager review hold', () => {
  let sessionId = '';

  it('is raised automatically when an item is cancelled after being prepared', async () => {
    const order = await customerOrder(h, 'R1', [{ productCode: 'SNK001', quantity: 1 }], 'review-1');
    sessionId = order.data.sessionId;

    const ticket = await findTicket(h, sessionId);
    await setItemStatus(h, ticket.roundId, ticket.items[0].itemId, 'ready');
    await setItemStatus(
      h,
      ticket.roundId,
      ticket.items[0].itemId,
      'cancelled',
      h.tokens.waiter,
      'guest changed their mind after it was cooked',
    );

    const detail = await h.api('GET', `/sessions/${sessionId}`, { token: h.tokens.billing });
    expect(detail.data.session.heldForReview).toBe(true);
    expect(detail.data.session.reviewNote).toContain('cancelled after');
  });

  it('blocks a silent close while held', async () => {
    const result = await h.api('POST', `/sessions/${sessionId}/close`, {
      token: h.tokens.billing,
      body: {},
    });

    expect(result.status).toBe(422);
    expect(result.error?.details?.heldForReview).toBe(true);
  });

  it('can be cleared by a manager, after which the session closes', async () => {
    await h.api('PATCH', `/sessions/${sessionId}/review`, {
      token: h.tokens.billing,
      body: { heldForReview: false },
    });

    const closed = await h.api('POST', `/sessions/${sessionId}/close`, {
      token: h.tokens.billing,
      body: { force: true },
    });
    expect(closed.data.status).toBe('closed');
  });
});

describe('closing', () => {
  it('will not close while the kitchen is still cooking', async () => {
    const m1 = await tile(h, 'M1');
    const result = await h.api('POST', `/sessions/${m1.sessionId}/close`, {
      token: h.tokens.billing,
      body: {},
    });

    expect(result.status).toBe(422);
    expect(result.error?.message).toContain('not finished');
  });

  it('will not let a waiter close a session', async () => {
    const m1 = await tile(h, 'M1');
    const result = await h.api('POST', `/sessions/${m1.sessionId}/close`, {
      token: h.tokens.waiter,
      body: { force: true },
    });
    expect(result.status).toBe(403);
  });

  it('frees the table and keeps the history', async () => {
    const m1 = await tile(h, 'M1');
    const sessionId = m1.sessionId;

    await h.api('POST', `/sessions/${sessionId}/close`, {
      token: h.tokens.billing,
      body: { force: true },
    });

    expect((await tile(h, 'M1')).status).toBe('empty');

    // Closing flips a flag; it never deletes.
    const detail = await h.api('GET', `/sessions/${sessionId}`, { token: h.tokens.billing });
    expect(detail.data.session.status).toBe('closed');
    expect(detail.data.rounds.length).toBeGreaterThan(0);
  });

  it('refuses to close twice', async () => {
    const sessions = await h.api('GET', '/sessions?status=closed', { token: h.tokens.billing });
    const result = await h.api('POST', `/sessions/${sessions.data[0]._id}/close`, {
      token: h.tokens.billing,
      body: { force: true },
    });
    expect(result.status).toBe(422);
  });

  it('gives the next customer a brand-new session on the same table', async () => {
    const fresh = await customerOrder(h, 'M1', [{ productCode: 'BEV001', quantity: 1 }], 'reuse-1-order');

    expect(fresh.data.roundNumber).toBe(1);
    expect((await tile(h, 'M1')).status).toBe('order_pending');
  });
});
