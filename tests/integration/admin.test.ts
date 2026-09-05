import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  customerOrder,
  findTicket,
  setItemStatus,
  type Harness,
} from '../helpers/harness.js';

/** Ops visibility, user management and the audit trail. */

let h: Harness;
let sessionId = '';

beforeAll(async () => {
  h = await createHarness();

  const order = await customerOrder(
    h,
    'M2',
    [{ productCode: 'BEV001', quantity: 2 }],
    'admin-1-order',
  );
  sessionId = order.data.sessionId;

  const ticket = await findTicket(h, sessionId);
  await setItemStatus(h, ticket.roundId, ticket.items[0].itemId, 'preparing');
});

afterAll(async () => {
  await h.close();
});

describe('live overview', () => {
  it('returns the whole floor in one payload', async () => {
    const overview = await h.api('GET', '/admin/overview', { token: h.tokens.admin });

    // So ownership can see what is happening without asking staff mid-service.
    expect(overview.data.summary.totalTables).toBe(6);
    expect(overview.data.summary.occupiedTables).toBeGreaterThan(0);
    expect(overview.data.summary.runningRevenue).toBeGreaterThan(0);
    expect(Array.isArray(overview.data.kitchenQueue)).toBe(true);
    expect(Array.isArray(overview.data.serviceRequests)).toBe(true);
    expect(Array.isArray(overview.data.billingQueue)).toBe(true);
  });

  it('is admin-only', async () => {
    for (const role of ['waiter', 'kitchen', 'billing'] as const) {
      expect((await h.api('GET', '/admin/overview', { token: h.tokens[role] })).status).toBe(403);
    }
  });
});

describe('user management', () => {
  it('lists staff without exposing PIN hashes', async () => {
    const users = await h.api('GET', '/admin/users', { token: h.tokens.admin });

    expect(users.data.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(users.data)).not.toContain('pinHash');
  });

  it('covers every role the system defines', async () => {
    const users = await h.api('GET', '/admin/users', { token: h.tokens.admin });
    const roles = new Set(users.data.map((user: any) => user.role));

    // If a new role is ever added, the seed must grow with it.
    expect(roles).toEqual(new Set(['admin', 'waiter', 'kitchen', 'billing']));
  });

  it('creates a new staff member who can immediately log in', async () => {
    await h.api('POST', '/admin/users', {
      token: h.tokens.admin,
      body: { name: 'New Waiter', phone: '9000000055', role: 'waiter', pin: '5555' },
    });

    const login = await h.api('POST', '/auth/login', {
      body: { phone: '9000000055', pin: '5555' },
    });
    expect(login.success).toBe(true);
  });

  it('refuses a duplicate phone number', async () => {
    const result = await h.api('POST', '/admin/users', {
      token: h.tokens.admin,
      body: { name: 'Clash', phone: '9000000055', role: 'waiter', pin: '6666' },
    });
    expect(result.status).toBe(409);
  });

  it('enforces a 4 digit numeric PIN', async () => {
    const result = await h.api('POST', '/admin/users', {
      token: h.tokens.admin,
      body: { name: 'Bad Pin', phone: '9000000056', role: 'waiter', pin: 'abcd' },
    });
    expect(result.status).toBe(400);
  });
});

describe('audit trail', () => {
  it('records every state change with the actor who made it', async () => {
    const audit = await h.api('GET', `/admin/audit?sessionId=${sessionId}&limit=100`, {
      token: h.tokens.admin,
    });
    const actions = new Set(audit.data.map((entry: any) => entry.action));

    expect(actions.has('session.opened')).toBe(true);
    expect(actions.has('round.placed')).toBe(true);
    expect(actions.has('round.item_status_changed')).toBe(true);
    expect(audit.data.every((entry: any) => entry.actor?.role)).toBe(true);
  });

  it('attributes a customer QR action to the customer, not a staff member', async () => {
    const audit = await h.api('GET', `/admin/audit?sessionId=${sessionId}&action=round.placed`, {
      token: h.tokens.admin,
    });
    expect(audit.data[0].actor.role).toBe('customer');
  });

  it('keeps before and after for a status change', async () => {
    const audit = await h.api('GET', '/admin/audit?action=round.item_status_changed', {
      token: h.tokens.admin,
    });

    expect(audit.data[0].before).toHaveProperty('status');
    expect(audit.data[0].after).toHaveProperty('status');
  });

  it('records the reason a cancelled item was cancelled', async () => {
    const ticket = await findTicket(h, sessionId);
    await setItemStatus(
      h,
      ticket.roundId,
      ticket.items[0].itemId,
      'cancelled',
      h.tokens.waiter,
      'guest left',
    );

    const audit = await h.api('GET', '/admin/audit?action=round.item_cancelled', {
      token: h.tokens.admin,
    });
    // This is the answer to "who cancelled that, and why".
    expect(audit.data[0].meta.reason).toBe('guest left');
    expect(audit.data[0].actor.role).toBe('waiter');
  });

  it('paginates', async () => {
    const page = await h.api('GET', '/admin/audit?page=1&limit=2', { token: h.tokens.admin });

    expect(page.data).toHaveLength(2);
    expect(page.meta?.pagination?.hasNextPage).toBe(true);
  });

  it('is admin-only — staff cannot inspect their own trail', async () => {
    expect((await h.api('GET', '/admin/audit', { token: h.tokens.billing })).status).toBe(403);
  });
});

describe('table master data', () => {
  it('creates a table whose printable URL is its own code', async () => {
    const result = await h.api('POST', '/tables', {
      token: h.tokens.admin,
      body: { code: 'V9', zone: 'Veranda', displayOrder: 9, seatingCapacity: 6 },
    });

    // The sticker is reprintable from the code alone — there is no stored token
    // to look up, and no way for the sheet and the database to drift apart.
    expect(result.data.qrUrl).toContain('/order/V9');
  });

  it('resolves that table from its code, case-insensitively', async () => {
    expect((await h.api('GET', '/public/tables/V9')).status).toBe(200);
    expect((await h.api('GET', '/public/tables/v9')).status).toBe(200);
  });

  it('rejects a code that was never printed', async () => {
    expect((await h.api('GET', '/public/tables/ZZ9')).status).toBe(401);
  });

  it('refuses to deactivate a table with a live session', async () => {
    const result = await h.api('PATCH', `/tables/${h.tables.M2!._id}`, {
      token: h.tokens.admin,
      body: { isActive: false },
    });
    expect(result.status).toBe(409);
  });

  it('produces a printable QR sheet for every table', async () => {
    const sheet = await h.api('GET', '/tables/qr-sheet', { token: h.tokens.admin });

    expect(sheet.data.length).toBeGreaterThanOrEqual(6);
    expect(sheet.data[0]).toHaveProperty('qrUrl');
    expect(sheet.data[0]).toHaveProperty('code');
  });
});
