import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';

import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * The realtime layer.
 *
 * Two properties matter: staff screens learn about changes without polling,
 * and a customer phone can never see another table's traffic.
 */

let h: Harness;
const sockets: Socket[] = [];

/** Resolves with the first matching event, or null if it never arrives. */
function waitFor<T = any>(socket: Socket, event: string, ms = 6000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connect(auth: Record<string, string>, opts: Record<string, unknown> = {}): Socket {
  const socket = io(h.ctx.wsUrl, { auth, transports: ['websocket'], ...opts });
  sockets.push(socket);
  return socket;
}

/** Connects and waits until the server confirms which rooms it joined. */
async function connected(auth: Record<string, string>): Promise<Socket> {
  const socket = connect(auth);
  await waitFor(socket, 'app:joined');
  return socket;
}

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  sockets.forEach((socket) => socket.close());
  await h.close();
});

describe('handshake', () => {
  it('accepts a staff JWT and joins the role room', async () => {
    const socket = connect({ token: h.tokens.kitchen });
    expect((await waitFor(socket, 'app:joined'))?.role).toBe('kitchen');
  });

  it('accepts a table code and pins the socket to that table', async () => {
    const socket = connect({ tableCode: h.tables.R1!.code });
    const joined = await waitFor(socket, 'app:joined');

    expect(joined?.role).toBe('customer');
    expect(joined?.tableCode).toBe('R1');
  });

  it('rejects a socket with no credentials', async () => {
    const socket = connect({}, { reconnection: false });
    const error = await new Promise<string | null>((resolve) => {
      socket.on('connect_error', (err: Error) => resolve(err.message));
      setTimeout(() => resolve(null), 4000);
    });
    expect(error).toBeTypeOf('string');
  });

  it('rejects an unknown table code', async () => {
    const socket = connect({ tableCode: 'NOPE' }, { reconnection: false });
    const error = await new Promise<string | null>((resolve) => {
      socket.on('connect_error', (err: Error) => resolve(err.message));
      setTimeout(() => resolve(null), 4000);
    });
    expect(error).toBeTypeOf('string');
  });
});

describe('order broadcasts', () => {
  let sessionId = '';
  let roundId = '';
  let itemId = '';
  let leaked = false;

  it('pushes a new order to the kitchen and to the ordering table', async () => {
    const kds = await connected({ token: h.tokens.kitchen });
    const phone = await connected({ tableCode: h.tables.R1!.code });

    // A phone on a different table must stay silent for the whole suite.
    const otherPhone = await connected({ tableCode: h.tables.M2!.code });
    otherPhone.on('round:new', () => (leaked = true));
    otherPhone.on('round:itemStatus', () => (leaked = true));

    const kdsEvent = waitFor(kds, 'round:new');
    const phoneEvent = waitFor(phone, 'round:new');

    const opened = await h.api('POST', '/sessions', {
      token: h.tokens.waiter,
      body: { tableId: h.tables.R1!._id },
    });
    sessionId = opened.data._id;

    const placed = await h.api('POST', `/sessions/${sessionId}/rounds`, {
      token: h.tokens.waiter,
      body: { items: [{ productCode: 'BEV002', quantity: 2 }], idempotencyKey: 'socket-round-1' },
    });
    roundId = placed.data._id;
    itemId = placed.data.items[0]._id;

    const received = await kdsEvent;
    expect(received?.round?.kotId).toBe(placed.data.kotId);
    // The payload is a ready-to-render KDS card, not a raw document.
    expect(received?.round?.items[0].displayName).toBe('Filter Coffee');

    expect((await phoneEvent)?.tableCode).toBe('R1');
  });

  it('pushes item and session status changes to the right screens', async () => {
    const kds = await connected({ token: h.tokens.kitchen });
    const phone = await connected({ tableCode: h.tables.R1!.code });

    const itemEvent = waitFor(kds, 'round:itemStatus');
    const sessionEvent = waitFor(phone, 'session:statusChange');

    await h.api('PATCH', `/rounds/${roundId}/items/${itemId}`, {
      token: h.tokens.kitchen,
      body: { status: 'preparing' },
    });

    expect((await itemEvent)?.status).toBe('preparing');
    expect((await sessionEvent)?.status).toBe('preparing');
  });

  it('announces when a table is closed out', async () => {
    const waiterSocket = await connected({ token: h.tokens.waiter });
    const closedEvent = waitFor(waiterSocket, 'session:closed');

    await h.api('POST', `/sessions/${sessionId}/close`, {
      token: h.tokens.billing,
      body: { force: true },
    });

    expect((await closedEvent)?.tableCode).toBe('R1');
  });

  it('never leaks one table’s traffic to another table’s phone', () => {
    expect(leaked).toBe(false);
  });
});

describe('menu and floor broadcasts', () => {
  it('pushes an 86 toggle to customer phones, not just staff', async () => {
    const phone = await connected({ tableCode: h.tables.R1!.code });
    const availability = waitFor(phone, 'product:availability');

    const products = await h.api('GET', '/products?search=Brownie', { token: h.tokens.admin });
    await h.api('PATCH', `/products/${products.data[0]._id}/availability`, {
      token: h.tokens.kitchen,
      body: { isAvailable: false, reason: 'sold out' },
    });

    // Customer phones sit in table rooms, not role rooms — a staff-only
    // broadcast would silently miss every one of them.
    const event = await availability;
    expect(event?.productCode).toBe('DST001');
    expect(event?.isAvailable).toBe(false);
  });

  it('sends floor calls to waiters, not to the kitchen', async () => {
    const kds = await connected({ token: h.tokens.kitchen });
    const waiterSocket = await connected({ token: h.tokens.waiter });

    const kitchenShouldNotHear = waitFor(kds, 'serviceRequest:new', 2500);
    const waiterShouldHear = waitFor(waiterSocket, 'serviceRequest:new');

    await h.api('POST', '/service-requests', {
      token: h.tokens.waiter,
      body: { tableId: h.tables.R1!._id, type: 'call_staff' },
    });

    const event = await waiterShouldHear;
    expect(event?.type).toBe('call_staff');
    expect(event?.tableCode).toBe('R1');

    // A cook does not need to know a guest waved at someone.
    expect(await kitchenShouldNotHear).toBeNull();
  });

  it('gives admin sight of everything', async () => {
    const adminSocket = await connected({ token: h.tokens.admin });
    const event = waitFor(adminSocket, 'serviceRequest:new');

    await h.api('POST', '/service-requests', {
      token: h.tokens.waiter,
      body: { tableId: h.tables.V1!._id, type: 'water' },
    });

    expect((await event)?.type).toBe('water');
  });
});
