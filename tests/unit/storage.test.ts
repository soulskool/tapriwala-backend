import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalStorageDriver } from '../../src/services/storage/local.driver.js';
import { MAX_IMAGE_BYTES, saveImage } from '../../src/services/storage/index.js';

/**
 * Image storage. Two things matter: a user-supplied filename must never reach
 * the filesystem, and a renamed executable must not be stored as an image.
 */

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBuffer = Buffer.concat([PNG_HEADER, Buffer.alloc(64)]);
const jpegBuffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);

let tempDir = '';
let driver: LocalStorageDriver;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acd-cafe-storage-'));
  driver = new LocalStorageDriver(tempDir);
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('LocalStorageDriver', () => {
  it('stores a file and returns a public URL plus a deletion key', async () => {
    const stored = await driver.save({
      buffer: pngBuffer,
      originalName: 'coffee.png',
      mimeType: 'image/png',
      size: pngBuffer.length,
      folder: 'products',
    });

    expect(stored.key).toMatch(/^products\/[a-f0-9]{32}\.png$/);
    expect(stored.url).toContain('/uploads/products/');
    await expect(fs.access(path.join(tempDir, stored.key))).resolves.toBeUndefined();
  });

  it('randomises filenames so two uploads of "coffee.png" do not collide', async () => {
    const first = await driver.save({
      buffer: pngBuffer,
      originalName: 'coffee.png',
      mimeType: 'image/png',
      size: pngBuffer.length,
      folder: 'products',
    });
    const second = await driver.save({
      buffer: pngBuffer,
      originalName: 'coffee.png',
      mimeType: 'image/png',
      size: pngBuffer.length,
      folder: 'products',
    });

    expect(first.key).not.toBe(second.key);
  });

  it('refuses to let a crafted filename escape the uploads directory', async () => {
    const stored = await driver.save({
      buffer: pngBuffer,
      originalName: '../../../etc/passwd',
      mimeType: 'image/png',
      size: pngBuffer.length,
      folder: '../../etc',
    });

    // The folder is sanitised, so the file lands inside tempDir regardless.
    expect(stored.key).not.toContain('..');
    const resolved = path.resolve(tempDir, stored.key);
    expect(resolved.startsWith(path.resolve(tempDir))).toBe(true);
  });

  it('deletes a stored file', async () => {
    const stored = await driver.save({
      buffer: jpegBuffer,
      originalName: 'x.jpg',
      mimeType: 'image/jpeg',
      size: jpegBuffer.length,
      folder: 'products',
    });

    await driver.remove(stored.key);
    await expect(fs.access(path.join(tempDir, stored.key))).rejects.toThrow();
  });

  it('treats deleting a missing file as success', async () => {
    await expect(driver.remove('products/does-not-exist.png')).resolves.toBeUndefined();
  });

  it('ignores a traversal attempt on delete', async () => {
    await expect(driver.remove('../../../etc/passwd')).resolves.toBeUndefined();
  });
});

describe('saveImage validation', () => {
  it('rejects a disallowed MIME type', async () => {
    await expect(
      saveImage({
        buffer: pngBuffer,
        originalName: 'evil.svg',
        mimeType: 'image/svg+xml',
        size: pngBuffer.length,
        folder: 'products',
      }),
    ).rejects.toThrow(/Unsupported image type/);
  });

  it('rejects an oversized file', async () => {
    await expect(
      saveImage({
        buffer: pngBuffer,
        originalName: 'big.png',
        mimeType: 'image/png',
        size: MAX_IMAGE_BYTES + 1,
        folder: 'products',
      }),
    ).rejects.toThrow(/too large/);
  });

  it('rejects a non-image wearing an image MIME type', async () => {
    // A browser will happily send image/png for a renamed executable, and the
    // static route serves whatever is on disk — so the bytes are checked.
    const notAnImage = Buffer.from('MZ\x90\x00This is an executable, not a PNG');

    await expect(
      saveImage({
        buffer: notAnImage,
        originalName: 'payload.png',
        mimeType: 'image/png',
        size: notAnImage.length,
        folder: 'products',
      }),
    ).rejects.toThrow(/not a valid image/);
  });

  it('rejects a file too short to identify', async () => {
    const tiny = Buffer.from([0xff, 0xd8]);
    await expect(
      saveImage({
        buffer: tiny,
        originalName: 'tiny.jpg',
        mimeType: 'image/jpeg',
        size: tiny.length,
        folder: 'products',
      }),
    ).rejects.toThrow(/not a valid image/);
  });
});
