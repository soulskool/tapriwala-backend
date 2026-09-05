import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, customerOrder, findTicket, type Harness } from '../helpers/harness.js';

/** Menu master data: the 86 toggle, price snapshots, bulk import and images. */

let h: Harness;
let coldCoffeeId = '';
let teaId = '';

beforeAll(async () => {
  h = await createHarness();

  const products = await h.api('GET', '/products', { token: h.tokens.admin });
  coldCoffeeId = products.data.find((p: any) => p.productCode === 'BEV003')._id;
  teaId = products.data.find((p: any) => p.productCode === 'BEV001')._id;
});

afterAll(async () => {
  await h.close();
});

describe('menu rendering', () => {
  it('groups by category for the customer screen', async () => {
    const menu = await h.api('GET', '/products/menu', { token: h.tokens.waiter });
    expect(menu.data.categories.length).toBeGreaterThanOrEqual(3);
    expect(menu.data.categories[0]).toHaveProperty('items');
  });

  it('searches by name or code so a waiter can type "cof"', async () => {
    const byName = await h.api('GET', '/products?search=cof', { token: h.tokens.waiter });
    const byCode = await h.api('GET', '/products?search=BEV003', { token: h.tokens.waiter });

    expect(byName.data.some((p: any) => p.displayName === 'Cold Coffee')).toBe(true);
    expect(byCode.data).toHaveLength(1);
  });
});

describe('the 86 toggle', () => {
  it('lets the kitchen pull an item without finding a manager', async () => {
    const result = await h.api('PATCH', `/products/${coldCoffeeId}/availability`, {
      token: h.tokens.kitchen,
      body: { isAvailable: false, reason: 'ran out' },
    });
    expect(result.status).toBe(200);
    expect(result.data.isAvailable).toBe(false);
  });

  it('hides it from customers but keeps it visible to staff', async () => {
    const customerMenu = await h.api('GET', `/public/tables/${h.tables.M2!.code}/menu`);
    const staffList = await h.api('GET', '/products', { token: h.tokens.kitchen });

    expect(JSON.stringify(customerMenu.data)).not.toContain('BEV003');
    // Staff must still see it to be able to un-86 it.
    expect(staffList.data.some((p: any) => p.productCode === 'BEV003')).toBe(true);
  });

  it('refuses a new order for it, naming the item', async () => {
    const result = await customerOrder(h, 'M2', [{ productCode: 'BEV003', quantity: 1 }]);

    expect(result.status).toBe(422);
    expect(result.error?.message).toContain('Cold Coffee');
  });

  it('flags an already-placed item on the KDS instead of deleting the line', async () => {
    await h.api('PATCH', `/products/${coldCoffeeId}/availability`, {
      token: h.tokens.kitchen,
      body: { isAvailable: true },
    });
    const order = await customerOrder(
      h,
      'R1',
      [{ productCode: 'BEV003', quantity: 1 }],
      'p86-1-order',
    );
    await h.api('PATCH', `/products/${coldCoffeeId}/availability`, {
      token: h.tokens.kitchen,
      body: { isAvailable: false },
    });

    const ticket = await findTicket(h, order.data.sessionId);
    // The cook is told, so they raise it with the floor rather than the line
    // silently vanishing from someone's order.
    expect(ticket.items.some((i: any) => i.productCode === 'BEV003' && i.unavailable)).toBe(true);

    await h.api('PATCH', `/products/${coldCoffeeId}/availability`, {
      token: h.tokens.kitchen,
      body: { isAvailable: true },
    });
  });
});

describe('price changes', () => {
  it('never re-prices a round that was already placed', async () => {
    const order = await customerOrder(
      h,
      'V1',
      [{ productCode: 'BEV001', quantity: 1 }],
      'price-1-order',
    );

    await h.api('PATCH', `/products/${teaId}`, { token: h.tokens.admin, body: { price: 999 } });

    const bill = await h.api('GET', `/billing/${order.data.sessionId}/consolidate`, {
      token: h.tokens.billing,
    });
    expect(bill.data.lines[0].unitPrice).toBe(30);

    await h.api('PATCH', `/products/${teaId}`, { token: h.tokens.admin, body: { price: 30 } });
  });

  it('applies the new price to the next order', async () => {
    await h.api('PATCH', `/products/${teaId}`, { token: h.tokens.admin, body: { price: 40 } });
    const order = await customerOrder(
      h,
      'L5',
      [{ productCode: 'BEV001', quantity: 1 }],
      'price-2-order',
    );

    expect(order.data.total).toBe(42);
    await h.api('PATCH', `/products/${teaId}`, { token: h.tokens.admin, body: { price: 30 } });
  });
});

describe('bulk import', () => {
  it('creates and updates by productCode', async () => {
    const result = await h.api('POST', '/products/bulk', {
      token: h.tokens.admin,
      body: {
        products: [
          {
            productCode: 'NEW001',
            posName: 'NEW ITEM',
            displayName: 'New Item',
            category: 'Snacks',
            price: 99,
          },
          {
            productCode: 'BEV001',
            posName: 'TEA',
            displayName: 'Masala Tea (Large)',
            category: 'Beverages',
            price: 35,
          },
        ],
      },
    });

    expect(result.data.created).toBe(1);
    expect(result.data.updated).toBe(1);
  });

  it('reports duplicate codes in the upload instead of last-one-wins', async () => {
    const result = await h.api('POST', '/products/bulk', {
      token: h.tokens.admin,
      body: {
        products: [
          { productCode: 'DUP1', posName: 'A', displayName: 'A', category: 'X', price: 10 },
          { productCode: 'DUP1', posName: 'B', displayName: 'B', category: 'X', price: 20 },
        ],
      },
    });

    // A duplicate code in the source sheet is the data problem this exists to find.
    expect(result.data.created).toBe(1);
    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0].reason).toContain('Duplicate');
  });

  it('audits the catalogue for duplicates and bad prices', async () => {
    const audit = await h.api('GET', '/products/audit', { token: h.tokens.admin });

    expect(audit.data.totalActive).toBeTypeOf('number');
    expect(Array.isArray(audit.data.duplicatePosNames)).toBe(true);
    expect(Array.isArray(audit.data.zeroOrNegativePrice)).toBe(true);
  });
});

describe('menu images', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(128),
  ]);

  async function upload(productId: string, buffer: Buffer, filename: string, type: string) {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(buffer)], { type }), filename);

    const response = await fetch(`${h.ctx.baseUrl}/products/${productId}/image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.tokens.admin}` },
      body: form,
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, ...body } as any;
  }

  it('stores an uploaded image and returns a URL the menu can render', async () => {
    const result = await upload(teaId, PNG, 'tea.png', 'image/png');

    expect(result.status).toBe(200);
    expect(result.data.imageUrl).toMatch(/\/uploads\/products\/[a-f0-9]{32}\.png$/);
  });

  it('serves the stored file over HTTP', async () => {
    const product = await h.api('GET', `/products/${teaId}`, { token: h.tokens.admin });
    const response = await fetch(product.data.imageUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    // Uploads must never be sniffed into markup by a browser.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('puts the image on the customer menu', async () => {
    const menu = await h.api('GET', `/public/tables/${h.tables.M2!.code}/menu`);
    const tea = menu.data.categories
      .flatMap((c: any) => c.items)
      .find((i: any) => i.productCode === 'BEV001');

    expect(tea.imageUrl).toContain('/uploads/products/');
  });

  it('rejects a non-image wearing an image content type', async () => {
    const notAnImage = Buffer.from('MZ\x90\x00 definitely not a png');
    const result = await upload(teaId, notAnImage, 'payload.png', 'image/png');

    expect(result.status).toBe(400);
  });

  it('rejects a disallowed type outright', async () => {
    const result = await upload(teaId, PNG, 'evil.svg', 'image/svg+xml');
    expect(result.status).toBe(400);
  });

  it('replaces an image without leaving the product imageless on failure', async () => {
    const before = await h.api('GET', `/products/${teaId}`, { token: h.tokens.admin });
    await upload(teaId, PNG, 'tea2.png', 'image/png');
    const after = await h.api('GET', `/products/${teaId}`, { token: h.tokens.admin });

    expect(after.data.imageUrl).not.toBe(before.data.imageUrl);
    // Old file is cleaned up rather than orphaned.
    expect((await fetch(before.data.imageUrl)).status).toBe(404);
  });

  it('removes an image on request', async () => {
    const result = await h.api('DELETE', `/products/${teaId}/image`, { token: h.tokens.admin });

    expect(result.status).toBe(200);
    expect(result.data.imageUrl).toBe('');
    expect(result.data.imageKey).toBe('');
  });

  it('keeps uploads admin-only', async () => {
    const response = await fetch(`${h.ctx.baseUrl}/products/${teaId}/image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.tokens.waiter}` },
      body: new FormData(),
    });
    expect(response.status).toBe(403);
  });
});
