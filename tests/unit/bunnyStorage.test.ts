import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../../src/config/env.js';
import { BunnyStorageDriver } from '../../src/services/storage/bunny.driver.js';

/**
 * Bunny driver, with `fetch` mocked.
 *
 * The real CDN is never called here — these tests pin the request shape (host,
 * method, AccessKey header, object key) and the failure behaviour, which is
 * what actually breaks in production.
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

const upload = {
  buffer: PNG,
  originalName: 'coffee.png',
  mimeType: 'image/png',
  size: PNG.length,
  folder: 'products',
};

/**
 * Fixed config, so the test does not depend on whatever the developer happens
 * to have in .env — and so real credentials are never needed to run it.
 */
const CONFIG = {
  bunnyBaseUrl: 'https://sg.storage.bunnycdn.com',
  bunnyCdnUrl: 'https://example-zone.b-cdn.net',
  bunnyStorageZone: 'test-zone',
  bunnyAccessKey: 'test-access-key',
  bunnyFolder: 'acd-cafe-test',
} as const;

let fetchMock: ReturnType<typeof vi.fn>;
let driver: BunnyStorageDriver;
let originalConfig: Record<string, unknown>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const mutableEnv = env as unknown as Record<string, unknown>;
  originalConfig = Object.fromEntries(Object.keys(CONFIG).map((key) => [key, mutableEnv[key]]));
  Object.assign(mutableEnv, CONFIG);

  driver = new BunnyStorageDriver();
});

afterEach(() => {
  Object.assign(env as unknown as Record<string, unknown>, originalConfig);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = () => Promise.resolve(new Response('', { status: 201 }));

describe('upload', () => {
  it('PUTs to the storage host with the access key', async () => {
    fetchMock.mockImplementation(ok);
    await driver.save(upload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(init.method).toBe('PUT');
    // Writes go to the storage host, never the CDN host.
    expect(url).toContain(env.bunnyBaseUrl.replace(/\/$/, ''));
    expect(url).toContain(`/${env.bunnyStorageZone}/`);
    expect((init.headers as Record<string, string>).AccessKey).toBe(env.bunnyAccessKey);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('nests the key under the configured folder', async () => {
    fetchMock.mockImplementation(ok);
    const stored = await driver.save(upload);

    // The storage zone is shared with another project — the prefix is what
    // keeps the café's uploads separate.
    expect(stored.key.startsWith(`${env.bunnyFolder}/products/`)).toBe(true);
    expect(stored.key).toMatch(/[a-f0-9]{32}\.png$/);
  });

  it('returns the public CDN URL, not the storage URL', async () => {
    fetchMock.mockImplementation(ok);
    const stored = await driver.save(upload);

    // Customers read from the CDN; the storage host requires a key.
    expect(stored.url).toBe(`${env.bunnyCdnUrl.replace(/\/$/, '')}/${stored.key}`);
    expect(stored.url).not.toContain(env.bunnyAccessKey);
  });

  it('randomises the filename so two "coffee.png" uploads cannot collide', async () => {
    fetchMock.mockImplementation(ok);
    const first = await driver.save(upload);
    const second = await driver.save(upload);

    expect(first.key).not.toBe(second.key);
  });

  it('never lets a crafted name or folder escape the prefix', async () => {
    fetchMock.mockImplementation(ok);
    const stored = await driver.save({
      ...upload,
      originalName: '../../../etc/passwd',
      folder: '../../other-project',
    });

    expect(stored.key).not.toContain('..');
    expect(stored.key.startsWith(`${env.bunnyFolder}/`)).toBe(true);
  });

  it('maps the extension from the MIME type, not the upload name', async () => {
    fetchMock.mockImplementation(ok);
    const stored = await driver.save({ ...upload, originalName: 'photo.exe', mimeType: 'image/webp' });
    expect(stored.key.endsWith('.webp')).toBe(true);
  });

  it('surfaces a rejection from Bunny as a dependency failure, not a 500', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    await expect(driver.save(upload)).rejects.toMatchObject({
      statusCode: 503,
      code: 'INTEGRATION_ERROR',
    });
  });

  it('surfaces a network failure with a message staff can act on', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(driver.save(upload)).rejects.toMatchObject({ statusCode: 503 });
    await expect(driver.save(upload)).rejects.toThrow(/try again/i);
  });
});

describe('delete', () => {
  it('DELETEs the object with the access key', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await driver.remove('acd-retreat/products/abc.png');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toContain('acd-retreat/products/abc.png');
    expect((init.headers as Record<string, string>).AccessKey).toBe(env.bunnyAccessKey);
  });

  it('treats a 404 as success — deletion is idempotent', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    await expect(driver.remove('gone.png')).resolves.toBeUndefined();
  });

  it('never throws on a failed delete', async () => {
    // An orphaned image costs pennies; a failed "replace image" during service
    // costs a menu. Cleanup must not be able to fail the request.
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(driver.remove('some/key.png')).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expect(driver.remove('some/key.png')).resolves.toBeUndefined();
  });

  it('ignores an empty key without calling out', async () => {
    await driver.remove('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
