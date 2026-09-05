import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from '../helpers/harness.js';

/** Staff PIN login, role permissions and the shape of an error response. */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('PIN login', () => {
  it('issues a token for a valid PIN', async () => {
    const result = await h.api('POST', '/auth/login', {
      body: { phone: '9000000001', pin: '1111' },
    });

    expect(result.success).toBe(true);
    expect(result.data.user.role).toBe('waiter');
    expect(result.data.token).toBeTypeOf('string');
  });

  it('never leaks whether a phone number exists', async () => {
    const wrongPin = await h.api('POST', '/auth/login', {
      body: { phone: '9000000001', pin: '0000' },
    });
    const unknownPhone = await h.api('POST', '/auth/login', {
      body: { phone: '9000000009', pin: '1111' },
    });

    expect(wrongPin.status).toBe(401);
    expect(unknownPhone.status).toBe(401);
    expect(wrongPin.error?.message).toBe(unknownPhone.error?.message);
  });

  it('returns the signed-in user from /auth/me', async () => {
    const me = await h.api('GET', '/auth/me', { token: h.tokens.kitchen });
    expect(me.data.role).toBe('kitchen');
    expect(me.data).not.toHaveProperty('pinHash');
  });
});

describe('access control', () => {
  it('rejects an unauthenticated request', async () => {
    expect((await h.api('GET', '/tables')).status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    expect((await h.api('GET', '/tables', { token: 'not.a.token' })).status).toBe(401);
  });

  it('keeps each role inside its own routes', async () => {
    // Billing closes sessions; a waiter must not.
    expect((await h.api('GET', '/billing/queue', { token: h.tokens.waiter })).status).toBe(403);
    // Admin owns master data.
    expect((await h.api('GET', '/admin/overview', { token: h.tokens.kitchen })).status).toBe(403);
  });

  it('lets admin through every role check', async () => {
    expect((await h.api('GET', '/billing/queue', { token: h.tokens.admin })).status).toBe(200);
    expect((await h.api('GET', '/kitchen/queue', { token: h.tokens.admin })).status).toBe(200);
  });

  it('deactivating a user takes effect immediately, not at token expiry', async () => {
    const users = await h.api('GET', '/admin/users', { token: h.tokens.admin });
    const waiter = users.data.find((user: any) => user.role === 'waiter');

    await h.api('PATCH', `/admin/users/${waiter.id}`, {
      token: h.tokens.admin,
      body: { isActive: false },
    });

    // Same token as before — the account is re-read on every request.
    expect((await h.api('GET', '/tables', { token: h.tokens.waiter })).status).toBe(403);

    await h.api('PATCH', `/admin/users/${waiter.id}`, {
      token: h.tokens.admin,
      body: { isActive: true },
    });
    expect((await h.api('GET', '/tables', { token: h.tokens.waiter })).status).toBe(200);
  });
});

describe('error envelope', () => {
  it('returns validation failures as an array of field errors', async () => {
    const result = await h.api('POST', '/auth/login', { body: { phone: 'abc', pin: '1' } });

    expect(result.status).toBe(400);
    // Must stay an ARRAY — frontends index into it to mark inputs red.
    expect(Array.isArray(result.error?.details)).toBe(true);
    expect(result.error?.details[0]).toHaveProperty('field');
    expect(result.error?.details[0]).toHaveProperty('message');
  });

  it('turns a malformed ObjectId into a 400, not a 500', async () => {
    expect((await h.api('GET', '/sessions/not-an-id', { token: h.tokens.waiter })).status).toBe(
      400,
    );
  });

  it('404s an unknown route with the standard shape', async () => {
    const result = await h.api('GET', '/no-such-route', { token: h.tokens.admin });
    expect(result.status).toBe(404);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});
