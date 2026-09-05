import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  customerOrder,
  findTicket,
  setItemStatus,
  waiterOrder,
  type Harness,
} from '../helpers/harness.js';

/** The KDS: ticket rendering, item-level progress and status transition rules. */

let h: Harness;
let sessionId = '';
let roundId = '';
let teaItemId = '';
let sandwichItemId = '';

beforeAll(async () => {
  h = await createHarness();

  const order = await customerOrder(
    h,
    'M2',
    [
      { productCode: 'BEV001', quantity: 2 },
      { productCode: 'SNK001', quantity: 1, specialInstructions: 'No onion please' },
    ],
    'kitchen-round-1',
  );
  sessionId = order.data.sessionId;

  const ticket = await findTicket(h, sessionId);
  roundId = ticket.roundId;
  teaItemId = ticket.items.find((i: any) => i.productCode === 'BEV001').itemId;
  sandwichItemId = ticket.items.find((i: any) => i.productCode === 'SNK001').itemId;
});

afterAll(async () => {
  await h.close();
});

describe('ticket rendering', () => {
  it('carries the table, KOT, elapsed time and instructions', async () => {
    const ticket = await findTicket(h, sessionId);

    expect(ticket.tableCode).toBe('M2');
    expect(ticket.kotId).toMatch(/^\d+$/);
    expect(ticket.elapsedMinutes).toBeTypeOf('number');
    expect(ticket.isAddOn).toBe(false);
    // Special instructions must never be silently dropped.
    expect(ticket.items.some((i: any) => i.specialInstructions === 'No onion please')).toBe(true);
  });

  it('is readable without a second request — no ids to resolve', async () => {
    const ticket = await findTicket(h, sessionId);
    expect(ticket.items.every((i: any) => typeof i.displayName === 'string')).toBe(true);
    expect(ticket.items.every((i: any) => typeof i.quantity === 'number')).toBe(true);
  });
});

describe('item-level progress', () => {
  it('lets the kitchen finish one item while another is still cooking', async () => {
    await setItemStatus(h, roundId, teaItemId, 'ready');
    await setItemStatus(h, roundId, sandwichItemId, 'preparing');

    const detail = await h.api('GET', `/sessions/${sessionId}`, { token: h.tokens.waiter });
    const round = detail.data.rounds[0];

    // The round is only as far along as its slowest live item.
    expect(round.items.find((i: any) => i.productCode === 'BEV001').status).toBe('ready');
    expect(round.status).toBe('preparing');
    expect(detail.data.session.status).toBe('preparing');
  });

  it('is idempotent — a double-tap on the KDS is not an error', async () => {
    const again = await setItemStatus(h, roundId, teaItemId, 'ready');
    expect(again.status).toBe(200);
  });

  it('allows a forward skip: a fast drink goes straight to ready', async () => {
    const order = await waiterOrder(
      h,
      sessionId,
      [{ productCode: 'BEV002', quantity: 1 }],
      'kitchen-skip-1',
    );
    const result = await setItemStatus(h, order.data._id, order.data.items[0]._id, 'ready');

    expect(result.status).toBe(200);
    expect(result.data.item.status).toBe('ready');
  });

  it('allows a backward move for mistake recovery', async () => {
    const result = await setItemStatus(h, roundId, teaItemId, 'preparing');
    expect(result.status).toBe(200);
    await setItemStatus(h, roundId, teaItemId, 'ready');
  });

  it('blocks an incoherent move', async () => {
    // Un-readying an item back to "nobody has looked at this" is nonsense.
    const result = await setItemStatus(h, roundId, teaItemId, 'pending');
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('INVALID_STATE');
  });

  it('moves a whole ticket at once', async () => {
    const order = await waiterOrder(
      h,
      sessionId,
      [
        { productCode: 'BEV001', quantity: 1 },
        { productCode: 'BEV002', quantity: 1 },
      ],
      'kitchen-bulk-1',
    );

    const result = await h.api('PATCH', `/rounds/${order.data._id}/status`, {
      token: h.tokens.kitchen,
      body: { status: 'ready' },
    });

    expect(result.data.status).toBe('ready');
    expect(result.data.items.every((i: any) => i.status === 'ready')).toBe(true);
  });
});

describe('who may do what', () => {
  it('does not let the kitchen cancel an item', async () => {
    const result = await setItemStatus(
      h,
      roundId,
      sandwichItemId,
      'cancelled',
      h.tokens.kitchen,
      'no',
    );
    expect(result.status).toBe(403);
  });

  it('requires a reason for every cancellation', async () => {
    const result = await setItemStatus(h, roundId, sandwichItemId, 'cancelled', h.tokens.waiter);
    expect(result.status).toBe(400);
  });

  it('lets a waiter cancel with a reason, and keeps it in history', async () => {
    const result = await setItemStatus(
      h,
      roundId,
      sandwichItemId,
      'cancelled',
      h.tokens.waiter,
      'guest changed their mind',
    );

    expect(result.status).toBe(200);
    expect(result.data.item.status).toBe('cancelled');
    expect(result.data.item.cancelReason).toBe('guest changed their mind');
    // Not deleted — still on the round, just excluded from billing.
    expect(result.data.round.items).toHaveLength(2);
  });
});

describe('queue behaviour', () => {
  it('is a full re-fetch, which is what makes a reconnect safe', async () => {
    const queue = await h.api('GET', '/kitchen/queue', { token: h.tokens.kitchen });

    // A tablet that dropped off the Wi-Fi calls this and is instantly correct,
    // rather than trusting it caught every socket event while away.
    expect(queue.data.tickets.length).toBeGreaterThan(0);
    expect(queue.data.generatedAt).toBeTruthy();
  });

  it('filters by station without changing stored data', async () => {
    const beverages = await h.api('GET', '/kitchen/queue?station=Beverage', {
      token: h.tokens.kitchen,
    });

    // Phase 3 splits the KDS by station — it is a view filter, not a migration.
    const stations = beverages.data.tickets.flatMap((t: any) =>
      t.items.map((i: any) => i.kitchenStation),
    );
    expect(stations.every((station: string) => station === 'Beverage')).toBe(true);
  });

  it('lists rounds that have been sitting ready too long', async () => {
    const ready = await h.api('GET', '/kitchen/ready?thresholdMinutes=0', {
      token: h.tokens.waiter,
    });
    expect(ready.data.rounds.length).toBeGreaterThan(0);
    expect(ready.data.rounds[0].waitingMinutes).toBeTypeOf('number');
  });
});

/**
 * Ghost tickets.
 *
 * The bug these cover: closing a session does not rewrite the statuses of its
 * items, so a table settled (or freed) while the kitchen still had work left
 * kept its ticket on the board forever -- on a table the floor screen was
 * already showing as empty. The cook had no way to clear it.
 */
describe('a closed table leaves nothing on the board', () => {
  it('drops the ticket when a session is billed out with items still ready', async () => {
    const order = await customerOrder(
      h,
      'L5',
      [{ productCode: 'BEV001', quantity: 5 }],
      'ghost-round-1',
    );
    const closingSession = order.data.sessionId;

    const ticket = await findTicket(h, closingSession);
    expect(ticket).toBeTruthy();

    // Ready but never served: this passes the close guard, which only blocks
    // pending/accepted/preparing. It is exactly how the ghosts got there.
    for (const item of ticket.items) {
      await setItemStatus(h, ticket.roundId, item.itemId, 'ready');
    }

    const closed = await h.api('POST', `/sessions/${closingSession}/close`, {
      token: h.tokens.billing,
    });
    expect(closed.status).toBe(200);

    expect(await findTicket(h, closingSession)).toBeUndefined();
  });

  it('drops the ticket, and writes the work off, when a table is freed unbilled', async () => {
    const order = await customerOrder(
      h,
      'V1',
      [{ productCode: 'BEV001', quantity: 2 }],
      'ghost-round-2',
    );
    const freedSession = order.data.sessionId;

    expect(await findTicket(h, freedSession)).toBeTruthy();

    const freed = await h.api('POST', `/sessions/${freedSession}/close`, {
      token: h.tokens.billing,
      body: { force: true, note: 'Freed without billing — fake order' },
    });
    expect(freed.status).toBe(200);

    expect(await findTicket(h, freedSession)).toBeUndefined();

    // Nothing is deleted: the round is still there, with the items cancelled
    // and a reason on them, so the write-off is visible in history.
    const rounds = await h.api('GET', `/sessions/${freedSession}/rounds`, {
      token: h.tokens.admin,
    });
    const items = rounds.data.flatMap((round: any) => round.items);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item: any) => item.status === 'cancelled')).toBe(true);
    expect(items[0].cancelReason).toBe('Table freed without billing');
  });

  it('stops nagging the floor about a freed table that was sitting ready', async () => {
    const order = await customerOrder(
      h,
      'R4',
      [{ productCode: 'BEV001', quantity: 1 }],
      'ghost-round-3',
    );
    const nagSession = order.data.sessionId;

    const ticket = await findTicket(h, nagSession);
    await setItemStatus(h, ticket.roundId, ticket.items[0].itemId, 'ready');

    await h.api('POST', `/sessions/${nagSession}/close`, {
      token: h.tokens.billing,
      body: { force: true, note: 'Freed without billing' },
    });

    const ready = await h.api('GET', '/kitchen/ready?thresholdMinutes=0', {
      token: h.tokens.waiter,
    });
    expect(ready.data.rounds.some((round: any) => round.sessionId === nagSession)).toBe(false);
  });
});
