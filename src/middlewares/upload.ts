import multer from 'multer';
import type { RequestHandler } from 'express';

import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from '../services/storage/index.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Multipart upload handling for menu images.
 *
 * Memory storage, not disk: the file is validated (MIME, size, magic bytes) and
 * handed to the storage driver before anything touches the filesystem, so a
 * rejected upload never leaves a temp file behind. At 3 MB a file this is
 * cheap; a large-file feature would want streaming instead.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as (typeof ALLOWED_IMAGE_TYPES)[number])) {
      callback(
        ApiError.badRequest(
          `Unsupported image type "${file.mimetype}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
        ),
      );
      return;
    }
    callback(null, true);
  },
});

/**
 * Accepts one file on the `image` field and converts multer's own errors into
 * the standard envelope, so a too-large upload reads like every other 400.
 */
export const uploadImage: RequestHandler = (req, res, next) => {
  upload.single('image')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          ApiError.badRequest(
            `Image is too large. Maximum is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
          ),
        );
        return;
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        next(ApiError.badRequest('Send the file on the "image" field'));
        return;
      }
      next(ApiError.badRequest(`Upload failed: ${error.message}`));
      return;
    }

    next(error);
  });
};

export default uploadImage;
