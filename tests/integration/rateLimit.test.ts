import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../../src/config/env.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * The broad API limiter.
 *
 * Every device in the café shares one Wi-Fi IP, so staff must be counted per
 * person and never per IP — otherwise one busy evening drains a single bucket
 * for the whole floor and the kitchen board starts answering 429. The
 * `RateLimit` headers show which bucket a request landed in without having to
 * send thousands of requests.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

async function rateLimit(token?: string) {
  const response = await fetch(`${h.ctx.baseUrl}/tables`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    limit: Number(response.headers.get('ratelimit-limit')),
    remaining: Number(response.headers.get('ratelimit-remaining')),
  };
}

describe('API rate limit', () => {
  it('gives signed-in staff the staff limit', async () => {
    for (const token of Object.values(h.tokens)) {
      expect((await rateLimit(token)).limit).toBe(env.rateLimitStaffMax);
    }
  });

  it('gives a request without a token the guest limit', async () => {
    expect((await rateLimit()).limit).toBe(env.rateLimitMax);
  });

  it('treats a forged token as a guest', async () => {
    expect((await rateLimit('not-a-real-token')).limit).toBe(env.rateLimitMax);
  });

  it('counts each staff member separately, though they share an IP', async () => {
    const waiterBefore = (await rateLimit(h.tokens.waiter)).remaining;
    await rateLimit(h.tokens.kitchen);
    await rateLimit(h.tokens.kitchen);
    const waiterAfter = (await rateLimit(h.tokens.waiter)).remaining;

    // Only the waiter's own second request came off the waiter's bucket.
    expect(waiterAfter).toBe(waiterBefore - 1);
  });
});

describe('PIN login limit', () => {
  it("does not lock everyone out over one person's wrong PINs", async () => {
    // Same IP for every request here, exactly like the café Wi-Fi.
    let last = 0;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      last = (await h.api('POST', '/auth/login', { body: { phone: '9000000001', pin: '0000' } }))
        .status;
    }
    expect(last).toBe(429);

    const kitchen = await h.api('POST', '/auth/login', {
      body: { phone: '9000000002', pin: '2222' },
    });
    expect(kitchen.success).toBe(true);
  });
});
