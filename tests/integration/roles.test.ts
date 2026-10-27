import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';

import { ProductMaster, TableSession, User } from '../../src/models/index.js';
import { createHarness, customerOrder, findTicket, type Harness } from '../helpers/harness.js';

/**
 * The two admin variants.
 *
 * Super admin: an admin in every respect, and the only role that can create or
 * change a staff account — including making someone else super admin and
 * taking it back. A plain admin reads the Staff page and nothing more.
 *
 * View-only admin: sees every screen and every report an admin sees, and
 * cannot change a single thing. The rule is enforced by HTTP method in
 * `authenticate`, so the list of refused writes below is a sample of every
 * kind of write, not a list the code has to keep in step with.
 */

let h: Harness;
let sessionId = '';
let roundId = '';
let itemId = '';

beforeAll(async () => {
  h = await createHarness();

  const order = await customerOrder(
    h,
    'M2',
    [{ productCode: 'BEV001', quantity: 2 }],
    'roles-order-1',
  );
  sessionId = order.data.sessionId;
  const ticket = await findTicket(h, sessionId);
  roundId = ticket.roundId;
  itemId = ticket.items[0].itemId;
});

afterAll(async () => {
  await h.close();
});

async function userByRole(role: string) {
  const users = await h.api('GET', '/admin/users', { token: h.tokens.superAdmin });
  return users.data.find((user: any) => user.role === role);
}

// ─── Super admin ─────────────────────────────────────────────────────────────

describe('super admin', () => {
  it('passes every role check an admin passes', async () => {
    for (const path of [
      '/billing/queue',
      '/kitchen/queue',
      '/admin/overview',
      '/tables/qr-sheet',
    ]) {
      expect((await h.api('GET', path, { token: h.tokens.superAdmin })).status).toBe(200);
    }
    // And writes outside staff management too — it is an admin first.
    const opened = await h.api('POST', '/sessions', {
      token: h.tokens.superAdmin,
      body: { tableId: h.tables.R4!._id },
    });
    expect(opened.success).toBe(true);
  });

  it('creates staff of any role, super admin included', async () => {
    const created = await h.api('POST', '/admin/users', {
      token: h.tokens.superAdmin,
      body: { name: 'Second Owner', phone: '9000000061', role: 'super_admin', pin: '6161' },
    });
    expect(created.status).toBe(201);
    expect(created.data.role).toBe('super_admin');
  });

  it('makes an admin a super admin, and takes it back', async () => {
    const admin = await userByRole('admin');

    const up = await h.api('PATCH', `/admin/users/${admin.id}`, {
      token: h.tokens.superAdmin,
      body: { role: 'super_admin' },
    });
    expect(up.data.role).toBe('super_admin');

    // The promotion is live at once: the same admin token can now manage staff,
    // because the role is re-read from the database on every request.
    const asPromoted = await h.api('POST', '/admin/users', {
      token: h.tokens.admin,
      body: { name: 'Hired By Promoted', phone: '9000000062', role: 'waiter', pin: '6262' },
    });
    expect(asPromoted.status).toBe(201);

    const down = await h.api('PATCH', `/admin/users/${admin.id}`, {
      token: h.tokens.superAdmin,
      body: { role: 'admin' },
    });
    expect(down.data.role).toBe('admin');

    const asDemoted = await h.api('POST', '/admin/users', {
      token: h.tokens.admin,
      body: { name: 'Too Late', phone: '9000000063', role: 'waiter', pin: '6363' },
    });
    expect(asDemoted.status).toBe(403);
  });

  it('records every role change in the audit log with who made it', async () => {
    const audit = await h.api('GET', '/admin/audit?action=user.updated&limit=100', {
      token: h.tokens.superAdmin,
    });
    const promotion = audit.data.find(
      (entry: any) => entry.before?.role === 'admin' && entry.after?.role === 'super_admin',
    );
    expect(promotion.actor.role).toBe('super_admin');
  });

  it('cannot be deactivated', async () => {
    const self = await User.findOne({ phone: '9000000007' }).lean();
    const result = await h.api('PATCH', `/admin/users/${String(self!._id)}`, {
      token: h.tokens.superAdmin,
      body: { isActive: false },
    });
    expect(result.status).toBe(403);
  });

  it('refuses to create a deactivated admin by promoting and switching off at once', async () => {
    const waiter = await User.findOne({ phone: '9000000062' }).lean();
    const result = await h.api('PATCH', `/admin/users/${String(waiter!._id)}`, {
      token: h.tokens.superAdmin,
      body: { role: 'admin', isActive: false },
    });
    expect(result.status).toBe(403);
    expect((await User.findById(waiter!._id).lean())!.role).toBe('waiter');
  });

  it('never lets the last super admin give the role away', async () => {
    // Two exist now (the test user and "Second Owner"): retire the second one
    // first, which is allowed because another super admin remains.
    const second = await User.findOne({ phone: '9000000061' }).lean();
    const retired = await h.api('PATCH', `/admin/users/${String(second!._id)}`, {
      token: h.tokens.superAdmin,
      body: { role: 'admin' },
    });
    expect(retired.success).toBe(true);

    // Now only one is left, and it cannot demote itself.
    const self = await User.findOne({ phone: '9000000007' }).lean();
    const result = await h.api('PATCH', `/admin/users/${String(self!._id)}`, {
      token: h.tokens.superAdmin,
      body: { role: 'admin' },
    });
    expect(result.status).toBe(422);
    expect((await User.findById(self!._id).lean())!.role).toBe('super_admin');
  });
});

// ─── Plain admin and staff management ────────────────────────────────────────

describe('staff management is super admin only', () => {
  it('lets a plain admin read the Staff list', async () => {
    const users = await h.api('GET', '/admin/users', { token: h.tokens.admin });
    expect(users.status).toBe(200);
    expect(JSON.stringify(users.data)).not.toContain('pinHash');
  });

  it('refuses a plain admin creating or editing anyone', async () => {
    const waiter = await userByRole('waiter');

    const create = await h.api('POST', '/admin/users', {
      token: h.tokens.admin,
      body: { name: 'Nope', phone: '9000000064', role: 'waiter', pin: '6464' },
    });
    const edit = await h.api('PATCH', `/admin/users/${waiter.id}`, {
      token: h.tokens.admin,
      body: { pin: '0000' },
    });
    // Including promoting themselves.
    const admin = await userByRole('admin');
    const selfPromote = await h.api('PATCH', `/admin/users/${admin.id}`, {
      token: h.tokens.admin,
      body: { role: 'super_admin' },
    });

    expect(create.status).toBe(403);
    expect(edit.status).toBe(403);
    expect(selfPromote.status).toBe(403);
    expect(await User.countDocuments({ phone: '9000000064' })).toBe(0);
    expect((await User.findById(admin.id).lean())!.role).toBe('admin');
  });

  it('refuses every other role too', async () => {
    for (const role of ['waiter', 'kitchen', 'billing', 'viewer'] as const) {
      const result = await h.api('POST', '/admin/users', {
        token: h.tokens[role],
        body: { name: 'Nope', phone: '9000000065', role: 'waiter', pin: '6565' },
      });
      expect(result.status).toBe(403);
    }
  });
});

// ─── View-only admin ─────────────────────────────────────────────────────────

describe('view-only admin', () => {
  it('signs in and is told its role', async () => {
    const me = await h.api('GET', '/auth/me', { token: h.tokens.viewer });
    expect(me.data.role).toBe('admin_viewer');
  });

  it('reads every screen an admin reads', async () => {
    const paths = [
      '/tables',
      '/tables/master',
      '/tables/qr-sheet',
      '/products',
      '/products/menu',
      '/products/audit',
      '/sessions',
      `/sessions/${sessionId}`,
      `/sessions/${sessionId}/rounds`,
      '/kitchen/queue',
      '/kitchen/ready',
      '/service-requests/queue',
      '/billing/queue',
      '/billing/exports',
      `/billing/${sessionId}/consolidate`,
      '/admin/overview',
      '/admin/users',
      '/admin/audit',
      '/admin/sales/daily',
      '/admin/sales/items',
    ];
    for (const path of paths) {
      const result = await h.api('GET', path, { token: h.tokens.viewer });
      expect(result.status, path).toBe(200);
    }
  });

  it('downloads the reports', async () => {
    for (const path of [
      '/billing/exports/xlsx',
      `/billing/${sessionId}/csv`,
      '/admin/sales/items/xlsx',
    ]) {
      const response = await fetch(`${h.ctx.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${h.tokens.viewer}` },
      });
      expect(response.status, path).toBe(200);
    }
  });

  it('is refused every kind of write', async () => {
    const product = await ProductMaster.findOne({ productCode: 'BEV002' }).lean();
    const waiter = await userByRole('waiter');
    const writes: [string, string, unknown][] = [
      ['POST', '/sessions', { tableId: h.tables.L5!._id }],
      [
        'POST',
        `/sessions/${sessionId}/rounds`,
        { items: [{ productCode: 'BEV001', quantity: 1 }] },
      ],
      ['POST', `/sessions/${sessionId}/close`, { force: true }],
      ['POST', `/sessions/${sessionId}/transfer`, { toTableId: h.tables.V1!._id, reason: 'x' }],
      ['PATCH', `/sessions/${sessionId}/review`, { heldForReview: true, note: 'x' }],
      ['POST', `/sessions/${sessionId}/move-bill`, { toTableId: h.tables.V1!._id }],
      ['POST', `/sessions/${sessionId}/undo-bill-move`, {}],
      ['PATCH', `/rounds/${roundId}/items/${itemId}`, { status: 'ready' }],
      ['PATCH', `/rounds/${roundId}/status`, { status: 'ready' }],
      ['PATCH', `/products/${String(product!._id)}/availability`, { isAvailable: false }],
      ['PATCH', `/products/${String(product!._id)}`, { price: 1 }],
      [
        'POST',
        '/products',
        {
          productCode: 'VW1',
          posName: 'X',
          displayName: 'X',
          category: 'X',
          price: 1,
          kitchenStation: 'Kitchen',
        },
      ],
      [
        'POST',
        '/tables',
        { code: 'VW1', zoneId: h.tables.V1!.zoneId, displayOrder: 1, seatingCapacity: 2 },
      ],
      ['PATCH', `/tables/${h.tables.V1!._id}`, { seatingCapacity: 9 }],
      ['DELETE', `/tables/${h.tables.V1!._id}`, {}],
      ['DELETE', `/products/${String(product!._id)}`, {}],
      ['POST', '/zones', { name: 'Rooftop' }],
      ['PATCH', `/zones/${h.tables.V1!.zoneId}`, { name: 'Porch' }],
      ['DELETE', `/zones/${h.tables.V1!.zoneId}`, {}],
      ['POST', '/service-requests', { tableId: h.tables.M2!._id, type: 'water' }],
      ['POST', `/billing/${sessionId}/export`, {}],
      ['POST', '/admin/users', { name: 'Nope', phone: '9000000066', role: 'waiter', pin: '6666' }],
      ['PATCH', `/admin/users/${waiter.id}`, { isActive: false }],
      ['DELETE', `/admin/users/${waiter.id}`, {}],
    ];

    for (const [method, path, body] of writes) {
      const result = await h.api(method, path, { token: h.tokens.viewer, body });
      expect(result.status, `${method} ${path}`).toBe(403);
    }
  });

  it('changed nothing while being refused', async () => {
    const ticket = await findTicket(h, sessionId);
    expect(ticket.items[0].status).toBe('pending');

    const coffee = await ProductMaster.findOne({ productCode: 'BEV002' }).lean();
    expect(coffee!.isAvailable).toBe(true);
    expect(coffee!.price).toBe(50);

    expect(await TableSession.countDocuments({ tableId: h.tables.L5!._id })).toBe(0);

    const session = await TableSession.findById(sessionId).lean();
    expect(session!.isActive).toBe(true);
    expect(session!.heldForReview).toBe(false);
  });

  it('cannot reach staff management even through a role it could read', async () => {
    const viewer = await userByRole('admin_viewer');
    const result = await h.api('PATCH', `/admin/users/${viewer.id}`, {
      token: h.tokens.viewer,
      body: { role: 'super_admin' },
    });
    expect(result.status).toBe(403);
    expect((await User.findById(viewer.id).lean())!.role).toBe('admin_viewer');
  });

  it('can still sign out', async () => {
    // Logout clears a cookie and needs no session, so read-only never traps
    // anyone on a shared device.
    const result = await h.api('POST', '/auth/logout', { token: h.tokens.viewer });
    expect(result.status).toBe(204);
  });
});

// ─── Realtime ────────────────────────────────────────────────────────────────

describe('live updates for the admin roles', () => {
  const sockets: Socket[] = [];

  afterAll(() => {
    sockets.forEach((socket) => socket.close());
  });

  function joined(token: string): Promise<{ socket: Socket; role: string | null }> {
    return new Promise((resolve) => {
      const socket = io(h.ctx.wsUrl, { auth: { token }, transports: ['websocket'] });
      sockets.push(socket);
      const timer = setTimeout(() => resolve({ socket, role: null }), 6000);
      socket.once('app:joined', (payload: { role: string }) => {
        clearTimeout(timer);
        resolve({ socket, role: payload.role });
      });
    });
  }

  function next(socket: Socket, event: string): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      socket.once(event, (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  it('hears a new order on both the super admin and the view-only screens', async () => {
    const superAdmin = await joined(h.tokens.superAdmin);
    const viewer = await joined(h.tokens.viewer);
    expect(superAdmin.role).toBe('super_admin');
    expect(viewer.role).toBe('admin_viewer');

    const heardBySuper = next(superAdmin.socket, 'round:new');
    const heardByViewer = next(viewer.socket, 'round:new');
    await customerOrder(h, 'R1', [{ productCode: 'BEV001', quantity: 1 }], 'roles-socket-1');

    expect(await heardBySuper).not.toBeNull();
    expect(await heardByViewer).not.toBeNull();
  });

  it('hears a service request aimed only at the floor roles', async () => {
    const viewer = await joined(h.tokens.viewer);
    const heard = next(viewer.socket, 'serviceRequest:new');
    await h.api('POST', '/public/tables/R1/service-requests', { body: { type: 'water' } });
    expect(await heard).not.toBeNull();
  });
});
