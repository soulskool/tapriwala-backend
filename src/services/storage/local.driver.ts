import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { StorageDriver, StoredFile, UploadInput } from './types.js';

/**
 * Local disk driver — the Phase 1 default.
 *
 * Files land in `uploads/<folder>/` and are served by the static route mounted
 * in `app.ts`. Filenames are randomised rather than derived from the upload
 * name: two "coffee.jpg" uploads must not collide, and a user-supplied name
 * must never reach the filesystem (`../../etc/passwd` is a real upload name
 * somebody will eventually try).
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';

  constructor(private readonly rootDir = env.uploadDir) {}

  async save(input: UploadInput): Promise<StoredFile> {
    const folder = sanitiseSegment(input.folder);
    const extension = extensionFor(input.mimeType, input.originalName);
    const filename = `${crypto.randomBytes(16).toString('hex')}${extension}`;

    const directory = path.join(this.rootDir, folder);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, filename), input.buffer);

    const key = `${folder}/${filename}`;
    logger.info(`Stored upload ${key} (${input.size} bytes)`);

    return {
      url: `${env.publicBaseUrl.replace(/\/$/, '')}${env.uploadUrlPath}/${key}`,
      key,
      size: input.size,
      mimeType: input.mimeType,
    };
  }

  async remove(key: string): Promise<void> {
    // Re-sanitise on the way out too: `key` comes from the database, and a bad
    // row must not turn a delete into an arbitrary file removal.
    const safeKey = key.split('/').map(sanitiseSegment).filter(Boolean).join('/');
    if (!safeKey) return;

    try {
      await fs.unlink(path.join(this.rootDir, safeKey));
      logger.info(`Removed upload ${safeKey}`);
    } catch (error) {
      // Already gone is success, not failure.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Could not remove upload ${safeKey}: ${(error as Error).message}`);
      }
    }
  }
}

/** Strips anything that could escape the uploads directory. */
function sanitiseSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '').replace(/^\.+/, '');
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

function extensionFor(mimeType: string, originalName: string): string {
  const known = EXTENSION_BY_MIME[mimeType];
  if (known) return known;
  const fromName = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(fromName) ? fromName : '';
}
