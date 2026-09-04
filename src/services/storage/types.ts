/**
 * Storage abstraction for menu item images.
 *
 * The café starts on local disk (one VPS, a few dozen images — a CDN would be
 * cost and complexity for nothing). But `imageUrl` on a product must never
 * encode *where* the file lives, so swapping to S3 or Cloudinary later is one
 * driver file and an env change, not a data migration.
 *
 * Every driver returns both a public `url` (what the browser loads) and an
 * opaque `key` (what the driver needs to delete it). The key is stored so a
 * replaced image can be cleaned up instead of orphaned forever.
 */

export interface StoredFile {
  /** Publicly reachable URL, stored on ProductMaster.imageUrl. */
  url: string;
  /** Driver-specific handle used for deletion. Stored on ProductMaster.imageKey. */
  key: string;
  size: number;
  mimeType: string;
}

export interface UploadInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
  /** Logical folder, e.g. "products". Drivers map this to a prefix or path. */
  folder: string;
}

export interface StorageDriver {
  readonly name: string;
  save(input: UploadInput): Promise<StoredFile>;
  /** Must not throw if the file is already gone — deletion is idempotent. */
  remove(key: string): Promise<void>;
}
