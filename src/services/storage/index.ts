import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { BunnyStorageDriver } from './bunny.driver.js';
import { LocalStorageDriver } from './local.driver.js';
import type { StorageDriver, StoredFile, UploadInput } from './types.js';

/**
 * Storage driver factory.
 *
 *   local — disk, for development
 *   bunny — Bunny.net Storage + CDN, for production
 *
 * Resolved once and cached. Config is validated in `assertEnv()` at boot, so a
 * missing Bunny key fails on startup rather than on the first upload mid-service.
 */

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

/** 3 MB. Menu photos are taken on a phone; anything larger is unresized. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

let driver: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (driver) return driver;

  // Tests must never write to the real CDN, whatever .env says.
  if (env.isTest) {
    driver = new LocalStorageDriver();
    return driver;
  }

  switch (env.storageDriver) {
    case 'bunny':
      driver = new BunnyStorageDriver();
      break;

    case 'local':
      driver = new LocalStorageDriver();
      break;

    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${String(env.storageDriver)}`);
  }

  logger.info(`Storage driver: ${driver.name}`);
  return driver;
}

/**
 * Validates and stores an uploaded image.
 *
 * Validation is by declared MIME *and* magic bytes: a browser will happily
 * send `image/png` for a renamed executable, and the static route serves
 * whatever is on disk.
 */
export async function saveImage(input: UploadInput): Promise<StoredFile> {
  if (!ALLOWED_IMAGE_TYPES.includes(input.mimeType as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    throw ApiError.badRequest(
      `Unsupported image type "${input.mimeType}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
    );
  }

  if (input.size > MAX_IMAGE_BYTES) {
    throw ApiError.badRequest(
      `Image is too large (${Math.round(input.size / 1024)} KB). Maximum is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    );
  }

  if (!looksLikeImage(input.buffer)) {
    throw ApiError.badRequest('That file is not a valid image');
  }

  return getStorageDriver().save(input);
}

export async function removeImage(key: string | null | undefined): Promise<void> {
  if (!key) return;
  await getStorageDriver().remove(key);
}

/** Magic-byte sniff for the formats we accept. */
function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => buffer[index] === byte)) return true;

  // WEBP / AVIF are RIFF- and ISO-BMFF-based: check the container tag.
  const header = buffer.subarray(0, 12).toString('binary');
  if (header.startsWith('RIFF') && header.includes('WEBP')) return true;
  if (header.includes('ftyp') && (header.includes('avif') || header.includes('avis'))) return true;

  return false;
}

/** Test seam: forces the factory to re-resolve after env changes. */
export function resetStorageDriver(): void {
  driver = null;
}

export { type StorageDriver, type StoredFile, type UploadInput } from './types.js';
