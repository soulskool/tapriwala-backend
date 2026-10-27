import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditLog,
  ProductMaster,
  TableMaster,
  TableSession,
  User,
} from '../../src/models/index.js';
import {
  createHarness,
  customerOrder,
  findTicket,
  tile,
  type Harness,
} from '../helpers/harness.js';

/**
 * Managed zones, and Delete on tables, menu items and staff.
 *
 * Delete is soft everywhere: the record leaves every screen, history keeps
 * pointing at it, and its human key (code, phone) is free for a new record.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

async function zones() {
  return (await h.api('GET', '/zones', { token: h.tokens.waiter })).data as {
    id: string;
    name: string;
    displayOrder: number;
    tableCount: number;
  }[];
}

async function lastAudit(action: string) {
  return AuditLog.findOne({ action }).sort({ timestamp: -1 }).lean();
}

describe('zones', () => {
  let rooftopId = '';

  it('lists the zones in floor order with how many tables each holds', async () => {
    const list = await zones();
    expect(list.map((zone) => zone.name)).toEqual(['Left', 'Middle', 'Right', 'Veranda']);
    expect(list.find((zone) => zone.name === 'Middle')!.tableCount).toBe(2);
  });

  it('lets an admin add a zone, at the end of the floor by default', async () => {
    const result = await h.api('POST', '/zones', {
      token: h.tokens.admin,
      body: { name: 'Rooftop' },
    });
    expect(result.status).toBe(201);
    rooftopId = result.data.id;

    const list = await zones();
    expect(list.at(-1)!.name).toBe('Rooftop');

    const audit = await lastAudit('zone.created');
    expect(audit!.actor.name).toBe('Test Admin');
  });

  it('refuses a second zone with the same name in another case', async () => {
    const result = await h.api('POST', '/zones', {
      token: h.tokens.admin,
      body: { name: 'rooftop' },
    });
    expect(result.status).toBe(409);
  });

  it('is managed by admins only', async () => {
    const result = await h.api('POST', '/zones', {
      token: h.tokens.waiter,
      body: { name: 'Garden' },
    });
    expect(result.status).toBe(403);
  });

  it('moves a table into a zone, and the floor shows the new name', async () => {
    const result = await h.api('PATCH', `/tables/${h.tables.V1!._id}`, {
      token: h.tokens.admin,
      body: { zoneId: rooftopId },
    });
    expect(result.status).toBe(200);
    expect(result.data.zone).toBe('Rooftop');
    expect((await tile(h, 'V1')).zone).toBe('Rooftop');
  });

  it('renames a zone once, and every table in it follows', async () => {
    await h.api('PATCH', `/zones/${rooftopId}`, {
      token: h.tokens.admin,
      body: { name: 'Terrace' },
    });

    expect((await tile(h, 'V1')).zone).toBe('Terrace');
    expect((await h.api('GET', '/public/tables/V1')).data.table.zone).toBe('Terrace');

    const audit = await lastAudit('zone.updated');
    expect(audit!.before).toMatchObject({ name: 'Rooftop' });
    expect(audit!.after).toMatchObject({ name: 'Terrace' });
  });

  it('orders the live grid by the zones’ own order', async () => {
    await h.api('PATCH', `/zones/${rooftopId}`, {
      token: h.tokens.admin,
      body: { displayOrder: 0 },
    });
    const grid = await h.api('GET', '/tables', { token: h.tokens.waiter });
    expect(grid.data.zones[0]).toBe('Terrace');
  });

  it('will not delete a zone that still has tables, and names them', async () => {
    const result = await h.api('DELETE', `/zones/${rooftopId}`, { token: h.tokens.admin });
    expect(result.status).toBe(422);
    expect(result.error!.message).toContain('V1');
    expect((await tile(h, 'V1')).zone).toBe('Terrace');
  });

  it('deletes an empty zone, and no table can be put into it afterwards', async () => {
    const veranda = (await zones()).find((zone) => zone.name === 'Veranda')!;
    await h.api('PATCH', `/tables/${h.tables.V1!._id}`, {
      token: h.tokens.admin,
      body: { zoneId: veranda.id },
    });

    const result = await h.api('DELETE', `/zones/${rooftopId}`, {
      token: h.tokens.admin,
      body: { reason: 'Roof closed' },
    });
    expect(result.status).toBe(200);
    expect((await zones()).map((zone) => zone.name)).not.toContain('Terrace');

    const audit = await lastAudit('zone.deleted');
    expect(audit!.meta).toMatchObject({ reason: 'Roof closed' });

    const moved = await h.api('PATCH', `/tables/${h.tables.V1!._id}`, {
      token: h.tokens.admin,
      body: { zoneId: rooftopId },
    });
    expect(moved.status).toBe(400);
  });
});

describe('deleting a table', () => {
  let sessionId = '';

  beforeAll(async () => {
    const order = await customerOrder(
      h,
      'R4',
      [{ productCode: 'BEV001', quantity: 1 }],
      'delete-r4-first',
    );
    sessionId = order.data.sessionId;
  });

  it('is refused while the table has an open session', async () => {
    const result = await h.api('DELETE', `/tables/${h.tables.R4!._id}`, { token: h.tokens.admin });
    expect(result.status).toBe(409);
    // …and the refusal leaves the table exactly as it was.
    expect((await TableMaster.findById(h.tables.R4!._id).lean())!.isActive).toBe(true);
  });

  it('deletes a free table: gone from the floor, history intact', async () => {
    await h.api('POST', `/sessions/${sessionId}/close`, {
      token: h.tokens.admin,
      body: { force: true, reason: 'test' },
    });

    const result = await h.api('DELETE', `/tables/${h.tables.R4!._id}`, {
      token: h.tokens.admin,
      body: { reason: 'Table broken' },
    });
    expect(result.status).toBe(200);

    expect(await tile(h, 'R4')).toBeUndefined();
    const master = await h.api('GET', '/tables/master?includeInactive=true', {
      token: h.tokens.admin,
    });
    expect(master.data.map((t: { code: string }) => t.code)).not.toContain('R4');

    // Nothing was removed: the session that ran on it is still on record.
    expect(await TableSession.countDocuments({ tableId: h.tables.R4!._id })).toBe(1);
    const rounds = await h.api('GET', `/sessions/${sessionId}/rounds`, { token: h.tokens.admin });
    expect(rounds.data).toHaveLength(1);

    const audit = await lastAudit('table.deleted');
    expect(audit!.tableCode).toBe('R4');
    expect(audit!.actor.name).toBe('Test Admin');
    expect(audit!.meta).toMatchObject({ reason: 'Table broken' });
  });

  it('tells a guest scanning its old sticker that it is out of service', async () => {
    const result = await h.api('GET', '/public/tables/R4');
    expect(result.status).toBe(403);
    expect(result.error!.message).toContain('no longer in service');

    const order = await customerOrder(
      h,
      'R4',
      [{ productCode: 'BEV001', quantity: 1 }],
      'delete-r4-second',
    );
    expect(order.status).toBe(403);
  });

  it('frees the code: a new R4 can be made, and its sticker works', async () => {
    const created = await h.api('POST', '/tables', {
      token: h.tokens.admin,
      body: { code: 'R4', zoneId: h.tables.R1!.zoneId, seatingCapacity: 2 },
    });
    expect(created.status).toBe(201);
    expect(created.data._id).not.toBe(h.tables.R4!._id);
    expect((await h.api('GET', '/public/tables/R4')).status).toBe(200);
  });

  it('still refuses a code that a live table holds', async () => {
    const result = await h.api('POST', '/tables', {
      token: h.tokens.admin,
      body: { code: 'r4', zoneId: h.tables.R1!.zoneId },
    });
    expect(result.status).toBe(409);
  });
});

describe('deleting a menu item', () => {
  let sessionId = '';

  beforeAll(async () => {
    const order = await customerOrder(
      h,
      'L5',
      [{ productCode: 'BEV002', quantity: 1 }],
      'delete-l5-first',
    );
    sessionId = order.data.sessionId;
  });

  it('works mid-service and leaves the order already in the kitchen alone', async () => {
    const coffee = await ProductMaster.findOne({ productCode: 'BEV002' }).lean();
    const result = await h.api('DELETE', `/products/${String(coffee!._id)}`, {
      token: h.tokens.admin,
      body: { reason: 'Machine sold' },
    });
    expect(result.status).toBe(200);

    const ticket = await findTicket(h, sessionId);
    expect(ticket.items[0].productCode).toBe('BEV002');

    const audit = await lastAudit('product.deleted');
    expect(audit!.meta).toMatchObject({ productCode: 'BEV002', reason: 'Machine sold' });
  });

  it('is gone from every menu, admin lists included', async () => {
    const menu = await h.api('GET', '/public/tables/L5/menu');
    const categories = menu.data.categories as { items: { productCode: string }[] }[];
    const codes = categories.flatMap((c) => c.items.map((i) => i.productCode));
    expect(codes).not.toContain('BEV002');

    const all = await h.api('GET', '/products?includeInactive=true', { token: h.tokens.admin });
    expect(all.data.map((p: { productCode: string }) => p.productCode)).not.toContain('BEV002');
  });

  it('tells a guest with it still in the cart that it is off the menu', async () => {
    const order = await customerOrder(
      h,
      'L5',
      [{ productCode: 'BEV002', quantity: 1 }],
      'delete-l5-second',
    );
    expect(order.status).toBe(400);
    expect(order.error!.message).toContain('not on the menu');
  });

  it('frees the code for an item added again', async () => {
    const result = await h.api('POST', '/products', {
      token: h.tokens.admin,
      body: {
        productCode: 'BEV002',
        posName: 'COFFEE',
        displayName: 'Filter Coffee',
        category: 'Beverages',
        price: 60,
        kitchenStation: 'Beverage',
      },
    });
    expect(result.status).toBe(201);
  });
});

describe('deleting a staff account', () => {
  let doomedId = '';
  let doomedToken = '';

  beforeAll(async () => {
    const created = await h.api('POST', '/admin/users', {
      token: h.tokens.superAdmin,
      body: { name: 'Temp Waiter', phone: '9000000055', role: 'waiter', pin: '5555' },
    });
    doomedId = created.data.id;
    const login = await h.api('POST', '/auth/login', {
      body: { phone: '9000000055', pin: '5555' },
    });
    doomedToken = login.data.token;
  });

  it('is for Admins only, not a plain admin', async () => {
    const result = await h.api('DELETE', `/admin/users/${doomedId}`, { token: h.tokens.admin });
    expect(result.status).toBe(403);
  });

  it('refuses to delete your own account', async () => {
    const me = await User.findOne({ phone: '9000000007' }).lean();
    const result = await h.api('DELETE', `/admin/users/${String(me!._id)}`, {
      token: h.tokens.superAdmin,
    });
    expect(result.status).toBe(403);
  });

  it('signs the account out at once and hides it from the Staff page', async () => {
    expect((await h.api('GET', '/tables', { token: doomedToken })).status).toBe(200);

    const result = await h.api('DELETE', `/admin/users/${doomedId}`, {
      token: h.tokens.superAdmin,
      body: { reason: 'Left the job' },
    });
    expect(result.status).toBe(200);

    expect((await h.api('GET', '/tables', { token: doomedToken })).status).toBe(401);
    const login = await h.api('POST', '/auth/login', {
      body: { phone: '9000000055', pin: '5555' },
    });
    expect(login.status).toBe(401);

    const staff = await h.api('GET', '/admin/users?includeInactive=true', {
      token: h.tokens.admin,
    });
    expect(staff.data.map((u: { id: string }) => u.id)).not.toContain(doomedId);

    const audit = await lastAudit('user.deleted');
    expect(audit!.actor.name).toBe('Test Super Admin');
    expect(audit!.before).toMatchObject({ name: 'Temp Waiter', role: 'waiter' });
  });

  it('frees the phone for a new hire', async () => {
    const result = await h.api('POST', '/admin/users', {
      token: h.tokens.superAdmin,
      body: { name: 'New Waiter', phone: '9000000055', role: 'waiter', pin: '6666' },
    });
    expect(result.status).toBe(201);
    const login = await h.api('POST', '/auth/login', {
      body: { phone: '9000000055', pin: '6666' },
    });
    expect(login.status).toBe(200);
  });
});
