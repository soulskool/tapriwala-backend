import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';

import { env } from '../../src/config/env.js';
import { User } from '../../src/models/index.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * Security regressions from the 2026-10 audit (security/SECURITY_AUDIT.md).
 *
 * Each block pins one fix, so undoing it fails a test instead of reopening the
 * hole quietly.
 */

let h: Harness;
const sockets: Socket[] = [];

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  sockets.forEach((socket) => socket.close());
  await h.close();
});

async function raw(path: string, init: RequestInit = {}) {
  const response = await fetch(`${h.ctx.baseUrl}${path}`, init);
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body, text };
}

function login(body: unknown) {
  return raw('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('error responses leak nothing', () => {
  it('carries no stack trace or server path', async () => {
    const result = await raw('/sessions/not-a-real-id');
    expect(result.status).toBe(401);
    expect(result.body).not.toHaveProperty('stack');
    expect(result.text).not.toMatch(/node_modules|\.ts:\d+|[A-Z]:\\|\/var\//);
  });

  it('answers malformed JSON with a plain 400', async () => {
    const result = await raw('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(result.status).toBe(400);
    expect(result.body).not.toHaveProperty('stack');
  });
});

describe('CORS', () => {
  it('echoes an allowed origin with credentials', async () => {
    const origin = env.corsOrigins[0]!;
    const result = await raw('/health', { headers: { origin } });
    expect(result.status).toBe(200);
    expect(result.headers.get('access-control-allow-origin')).toBe(origin);
    expect(result.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('refuses a foreign origin with 403 and never echoes it', async () => {
    const result = await raw('/health', { headers: { origin: 'https://evil.example' } });
    expect(result.status).toBe(403);
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('stops a cross-site form POST before it reaches a route', async () => {
    const result = await raw('/sessions', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${h.tokens.waiter}`,
      },
      body: `tableId=${h.tables.M1!._id}`,
    });
    expect(result.status).toBe(403);
  });
});

describe('NoSQL operator injection', () => {
  it('rejects an operator object in place of the phone', async () => {
    const result = await login({ phone: { $ne: null }, pin: '1234' });
    expect(result.status).toBe(400);
  });

  it('rejects an operator object in place of the PIN', async () => {
    const result = await login({ phone: '9999999999', pin: { $gt: '' } });
    expect(result.status).toBe(400);
  });

  it('rejects an array phone, which Mongo would read as $in', async () => {
    const result = await login({ phone: ['9999999999', '9000000001'], pin: '1234' });
    expect(result.status).toBe(400);
  });

  it('still logs in with plain strings', async () => {
    const result = await login({ phone: '9999999999', pin: '1234' });
    expect(result.status).toBe(200);
  });
});

describe('audit filters are validated before they reach Mongo', () => {
  const audit = (query: string) =>
    raw(`/admin/audit?${query}`, { headers: { authorization: `Bearer ${h.tokens.admin}` } });

  it('accepts the filters the audit screen sends', async () => {
    expect((await audit('entityType=TableSession&tableCode=M2&page=1&limit=50')).status).toBe(200);
  });

  it('rejects values that are not real filters', async () => {
    expect((await audit('entityType=nonsense')).status).toBe(400);
    expect((await audit('entityId=not-an-id')).status).toBe(400);
    expect((await audit('action=drop')).status).toBe(400);
  });
});

describe('login does not reveal accounts', () => {
  it('answers an unknown phone and a wrong PIN identically', async () => {
    const unknown = await login({ phone: '9111111111', pin: '0000' });
    const wrong = await login({ phone: '9000000001', pin: '0000' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('tells a deactivated account so only after the right PIN', async () => {
    await User.updateOne({ phone: '9000000002' }, { isActive: false });
    try {
      expect((await login({ phone: '9000000002', pin: '0000' })).status).toBe(401);
      expect((await login({ phone: '9000000002', pin: '2222' })).status).toBe(403);
    } finally {
      await User.updateOne({ phone: '9000000002' }, { isActive: true });
    }
  });
});

describe('session cookie', () => {
  it('is HttpOnly and SameSite', async () => {
    const result = await login({ phone: '9000000001', pin: '1111' });
    const cookie = result.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=(Lax|Strict|None)/i);
    // Secure follows env.cookieSecure: on for any https deployment.
    expect(/;\s*Secure/i.test(cookie)).toBe(env.cookieSecure || env.cookieSameSite === 'none');
  });
});

describe('request id', () => {
  it('keeps a well-formed id', async () => {
    const result = await raw('/health', { headers: { 'x-request-id': 'abc-123' } });
    expect(result.headers.get('x-request-id')).toBe('abc-123');
  });

  it('replaces an id that could forge log lines', async () => {
    const result = await raw('/health', { headers: { 'x-request-id': 'x'.repeat(200) } });
    expect(result.headers.get('x-request-id')).not.toBe('x'.repeat(200));
  });
});

describe('socket handshake', () => {
  function attempt(auth: Record<string, string>, extraHeaders?: Record<string, string>) {
    const socket = io(h.ctx.wsUrl, {
      auth,
      transports: ['polling'],
      reconnection: false,
      ...(extraHeaders ? { extraHeaders } : {}),
    });
    sockets.push(socket);
    return new Promise<'joined' | 'refused'>((resolve) => {
      const timer = setTimeout(() => resolve('refused'), 5000);
      socket.once('app:joined', () => {
        clearTimeout(timer);
        resolve('joined');
      });
      socket.once('connect_error', () => {
        clearTimeout(timer);
        resolve('refused');
      });
    });
  }

  it('accepts staff from an allowed origin', async () => {
    expect(await attempt({ token: h.tokens.kitchen }, { origin: env.corsOrigins[0]! })).toBe(
      'joined',
    );
  });

  it('refuses a handshake from a foreign origin', async () => {
    expect(await attempt({ token: h.tokens.kitchen }, { origin: 'https://evil.example' })).toBe(
      'refused',
    );
  });

  it('refuses a deactivated staff member whose token is still valid', async () => {
    await User.updateOne({ phone: '9000000002' }, { isActive: false });
    try {
      expect(await attempt({ token: h.tokens.kitchen })).toBe('refused');
    } finally {
      await User.updateOne({ phone: '9000000002' }, { isActive: true });
    }
  });
});
