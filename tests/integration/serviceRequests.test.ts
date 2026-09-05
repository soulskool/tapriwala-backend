import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, customerOrder, tile, type Harness } from '../helpers/harness.js';

/**
 * Water / call-staff / bill requests — the veranda-and-lawn problem: a guest
 * out of eyeshot must be able to summon someone, with the wait time visible.
 */

let h: Harness;
let waterRequestId = '';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('raising a request', () => {
  it('lets a guest ask for water before ordering anything', async () => {
    const result = await h.api('POST', `/public/tables/${h.tables.V1!.code}/service-requests`, {
      body: { type: 'water' },
    });

    expect(result.success).toBe(true);
    expect(result.data.type).toBe('water');
    waterRequestId = result.data.requestId;
  });

  it('collapses repeat taps into one row with a counter', async () => {
    await h.api('POST', `/public/tables/${h.tables.V1!.code}/service-requests`, {
      body: { type: 'water' },
    });
    const third = await h.api('POST', `/public/tables/${h.tables.V1!.code}/service-requests`, {
      body: { type: 'water' },
    });

    // An impatient guest is one increasingly loud line, not three rows to dismiss.
    expect(third.data.requestId).toBe(waterRequestId);
    expect(third.data.repeatCount).toBe(3);
  });

  it('keeps the original raisedAt so the true wait time never resets', async () => {
    const queue = await h.api('GET', '/service-requests/queue', { token: h.tokens.waiter });
    const water = queue.data.requests.find((r: any) => r._id === waterRequestId);

    expect(new Date(water.raisedAt).getTime()).toBeLessThanOrEqual(
      new Date(water.lastRaisedAt).getTime(),
    );
  });

  it('keeps different request types apart', async () => {
    const staff = await h.api('POST', `/public/tables/${h.tables.V1!.code}/service-requests`, {
      body: { type: 'call_staff' },
    });
    expect(staff.data.requestId).not.toBe(waterRequestId);
  });

  it('lets staff raise a request on a guest’s behalf', async () => {
    const result = await h.api('POST', '/service-requests', {
      token: h.tokens.waiter,
      body: { tableId: h.tables.R1!._id, type: 'water' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown request type', async () => {
    const result = await h.api('POST', `/public/tables/${h.tables.V1!.code}/service-requests`, {
      body: { type: 'champagne' },
    });
    expect(result.status).toBe(400);
  });
});

describe('the waiter dashboard', () => {
  it('lists live requests oldest first with a wait time', async () => {
    const queue = await h.api('GET', '/service-requests/queue', { token: h.tokens.waiter });

    expect(queue.data.requests.length).toBeGreaterThan(0);
    expect(queue.data.requests[0].waitingMinutes).toBeTypeOf('number');
    expect(queue.data.requests[0]).toHaveProperty('isEscalated');

    const times = queue.data.requests.map((r: any) => new Date(r.raisedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('surfaces the table on the grid so nobody has to watch two screens', async () => {
    const v1 = await tile(h, 'V1');
    expect(v1.openServiceRequests).toBeGreaterThan(0);
    expect(v1.oldestRequestMinutes).toBeTypeOf('number');
    // needsAttention is the red flash — it is time-based on purpose. A request
    // raised seconds ago shows as a badge, not an alarm; it escalates after
    // SERVICE_REQUEST_ESCALATION_MINUTES.
    expect(v1.needsAttention).toBe(false);
  });

  it('acknowledges, then resolves, and drops out of the queue', async () => {
    const ack = await h.api('PATCH', `/service-requests/${waterRequestId}`, {
      token: h.tokens.waiter,
      body: { status: 'acknowledged' },
    });
    expect(ack.data.status).toBe('acknowledged');
    expect(ack.data.acknowledgedAt).toBeTruthy();

    await h.api('PATCH', `/service-requests/${waterRequestId}`, {
      token: h.tokens.waiter,
      body: { status: 'resolved' },
    });

    const queue = await h.api('GET', '/service-requests/queue', { token: h.tokens.waiter });
    expect(queue.data.requests.some((r: any) => r._id === waterRequestId)).toBe(false);
  });

  it('refuses to re-resolve a finished request', async () => {
    const result = await h.api('PATCH', `/service-requests/${waterRequestId}`, {
      token: h.tokens.waiter,
      body: { status: 'resolved' },
    });
    expect(result.status).toBe(422);
  });

  it('requires a note when dismissing a request as a mis-tap', async () => {
    const raised = await h.api('POST', `/public/tables/${h.tables.M2!.code}/service-requests`, {
      body: { type: 'call_staff' },
    });

    const noNote = await h.api('PATCH', `/service-requests/${raised.data.requestId}`, {
      token: h.tokens.waiter,
      body: { status: 'cancelled' },
    });
    expect(noNote.status).toBe(400);

    const withNote = await h.api('PATCH', `/service-requests/${raised.data.requestId}`, {
      token: h.tokens.waiter,
      body: { status: 'cancelled', note: 'guest waved it off' },
    });
    expect(withNote.status).toBe(200);
  });
});

describe('requesting the bill', () => {
  let sessionId = '';

  it('is refused on a table that has not ordered', async () => {
    const result = await h.api('POST', `/public/tables/${h.tables.L5!.code}/service-requests`, {
      body: { type: 'bill' },
    });

    // A mis-tap, not a bill.
    expect(result.status).toBe(422);
  });

  it('moves the session into the billing queue', async () => {
    const order = await customerOrder(
      h,
      'M2',
      [{ productCode: 'BEV001', quantity: 1 }],
      'bill-1-order',
    );
    sessionId = order.data.sessionId;

    await h.api('POST', `/public/tables/${h.tables.M2!.code}/service-requests`, {
      body: { type: 'bill' },
    });

    expect((await tile(h, 'M2')).status).toBe('bill_requested');

    const queue = await h.api('GET', '/billing/queue', { token: h.tokens.billing });
    const waiting = queue.data.sessions.find((s: any) => s.sessionId === sessionId);
    expect(waiting.waitingMinutes).toBeTypeOf('number');
  });

  it('stops the customer ordering into a bill being settled, but not staff', async () => {
    const customer = await customerOrder(h, 'M2', [{ productCode: 'BEV001', quantity: 1 }]);
    expect(customer.status).toBe(422);

    // Staff can see the counter and the table; they may still add.
    const staff = await h.api('POST', `/sessions/${sessionId}/rounds`, {
      token: h.tokens.waiter,
      body: { items: [{ productCode: 'BEV002', quantity: 1 }], idempotencyKey: 'bill-addon-1' },
    });
    expect(staff.success).toBe(true);
  });

  it('auto-resolves outstanding requests when the session closes', async () => {
    await h.api('POST', `/sessions/${sessionId}/close`, {
      token: h.tokens.billing,
      body: { force: true },
    });

    const queue = await h.api('GET', '/service-requests/queue', { token: h.tokens.waiter });
    // Otherwise the dashboard keeps flashing for a table that has already left.
    expect(queue.data.requests.some((r: any) => r.sessionId === sessionId)).toBe(false);
  });
});
