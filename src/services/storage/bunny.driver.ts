import crypto from 'node:crypto';
import path from 'node:path';

import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import type { StorageDriver, StoredFile, UploadInput } from './types.js';

/**
 * Bunny.net Storage driver.
 *
 * Bunny's storage API is plain HTTP — PUT to upload, DELETE to remove, with an
 * `AccessKey` header — so this uses `fetch` rather than pulling in an SDK.
 *
 * Two hosts are involved and they are not interchangeable:
 *   BUNNY_BASE_URL  (sg.storage.bunnycdn.com)   — write here, needs the key
 *   BUNNY_CDN_URL   (…b-cdn.net)                — public reads, no key
 *
 * Files are written under `BUNNY_FOLDER` because the storage zone is shared
 * with another project. Without that prefix the café's uploads would land
 * alongside someone else's.
 */
export class BunnyStorageDriver implements StorageDriver {
  readonly name = 'bunny';

  /** Bunny is a network hop on a customer-facing path; do not hang on it. */
  private readonly timeoutMs = 15_000;

  /** Full write URL for a stored key. */
  private storageUrl(key: string): string {
    const base = env.bunnyBaseUrl.replace(/\/$/, '');
    return `${base}/${env.bunnyStorageZone}/${key}`;
  }

  /** Public CDN URL for a stored key. */
  private publicUrl(key: string): string {
    return `${env.bunnyCdnUrl.replace(/\/$/, '')}/${key}`;
  }

  async save(input: UploadInput): Promise<StoredFile> {
    const key = buildKey(input);
    const url = this.storageUrl(key);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          AccessKey: env.bunnyAccessKey,
          'Content-Type': input.mimeType,
        },
        // Node's fetch wants a view over the buffer, not the Buffer itself.
        body: new Uint8Array(input.buffer),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Network failure or timeout — surface it as a dependency problem, not a
      // 500, so the admin screen can say "storage is unreachable, try again".
      throw ApiError.serviceUnavailable(
        'Could not reach image storage. Please try again in a moment.',
        { cause: (error as Error).message },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error(`Bunny upload failed (${response.status}) for ${key}: ${detail}`);
      throw ApiError.serviceUnavailable('Image storage rejected the upload', {
        status: response.status,
      });
    }

    logger.info(`Uploaded ${key} to Bunny (${input.size} bytes)`);

    return {
      url: this.publicUrl(key),
      key,
      size: input.size,
      mimeType: input.mimeType,
    };
  }

  async remove(key: string): Promise<void> {
    if (!key) return;

    try {
      const response = await fetch(this.storageUrl(key), {
        method: 'DELETE',
        headers: { AccessKey: env.bunnyAccessKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // 404 means it is already gone, which is the outcome we wanted.
      if (response.ok || response.status === 404) {
        logger.info(`Removed ${key} from Bunny`);
        return;
      }

      logger.warn(`Bunny delete failed (${response.status}) for ${key}`);
    } catch (error) {
      // Never fail the request over a leftover file. An orphaned image costs
      // pennies; a failed "replace image" during service costs a menu.
      logger.warn(`Bunny delete errored for ${key}: ${(error as Error).message}`);
    }
  }
}

/**
 * Builds the object key: `<BUNNY_FOLDER>/<folder>/<random>.<ext>`.
 *
 * Random filenames, not the upload's own name: two "coffee.jpg" uploads must
 * not overwrite each other, and a user-supplied name must never become a path.
 */
function buildKey(input: UploadInput): string {
  const segments = [env.bunnyFolder, input.folder]
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '').replace(/^\.+/, ''))
    .filter(Boolean);

  const filename = `${crypto.randomBytes(16).toString('hex')}${extensionFor(input)}`;
  return [...segments, filename].join('/');
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

function extensionFor(input: UploadInput): string {
  const known = EXTENSION_BY_MIME[input.mimeType];
  if (known) return known;
  const fromName = path.extname(input.originalName).toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(fromName) ? fromName : '';
}
