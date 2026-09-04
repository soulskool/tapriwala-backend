import type { KitchenStation } from '../config/constants.js';
import * as productService from '../services/product.service.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { queryBool } from '../utils/helpers.js';

/** GET /products — flat list with filters (staff/admin). */
export const list = asyncHandler(async (req, res) => {
  const products = await productService.list({
    category: req.query.category as string | undefined,
    station: req.query.station as KitchenStation | undefined,
    search: req.query.search as string | undefined,
    availableOnly: queryBool(req.query.availableOnly),
    includeInactive: queryBool(req.query.includeInactive),
  });
  return sendSuccess(res, products);
});

/** GET /products/menu — grouped by category, ready to render. */
export const menu = asyncHandler(async (req, res) => {
  // Staff see 86'd items greyed out; customers do not see them at all.
  const grouped = await productService.getMenu({ forCustomer: !req.user });
  return sendSuccess(res, { categories: grouped });
});

/** GET /products/categories */
export const categories = asyncHandler(async (_req, res) => {
  return sendSuccess(res, await productService.getCategories());
});

/** GET /products/:id */
export const getById = asyncHandler(async (req, res) => {
  return sendSuccess(res, await productService.getByIdOrThrow(req.params.id as string));
});

/** POST /products — admin */
export const create = asyncHandler(async (req, res) => {
  const product = await productService.create(req.body as Record<string, unknown>, getActor(req));
  return sendCreated(res, product, `${product.displayName} added to the menu`);
});

/** PATCH /products/:id — admin */
export const update = asyncHandler(async (req, res) => {
  const product = await productService.update(
    req.params.id as string,
    req.body as Record<string, unknown>,
    getActor(req),
  );
  return sendSuccess(res, product, `${product.displayName} updated`);
});

/**
 * PATCH /products/:id/availability — the 86 toggle.
 * Kitchen can hit this too: they are the ones who know the sandwiches ran out.
 */
export const setAvailability = asyncHandler(async (req, res) => {
  const { isAvailable, reason } = req.body as { isAvailable: boolean; reason?: string };
  const product = await productService.setAvailability(
    req.params.id as string,
    isAvailable,
    getActor(req),
    reason ?? '',
  );
  return sendSuccess(
    res,
    product,
    isAvailable
      ? `${product.displayName} is available again`
      : `${product.displayName} marked unavailable`,
  );
});

/** POST /products/bulk — Excel import (admin). */
export const bulkUpsert = asyncHandler(async (req, res) => {
  const { products } = req.body as { products: productService.BulkRow[] };
  const result = await productService.bulkUpsert(products, getActor(req));
  return sendSuccess(
    res,
    result,
    `${result.created} created, ${result.updated} updated, ${result.skipped.length} skipped`,
  );
});

/**
 * POST /products/:id/image — multipart upload, field name `image`.
 * The response carries the new absolute URL, ready to render.
 */
export const uploadProductImage = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No image was uploaded (field name: "image")');

  const product = await productService.setImage(
    req.params.id as string,
    {
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
    },
    getActor(req),
  );

  return sendSuccess(
    res,
    { id: String(product._id), productCode: product.productCode, imageUrl: product.imageUrl },
    `Image updated for ${product.displayName}`,
  );
});

/** DELETE /products/:id/image */
export const deleteProductImage = asyncHandler(async (req, res) => {
  const product = await productService.clearImage(req.params.id as string, getActor(req));
  return sendSuccess(res, product, `Image removed from ${product.displayName}`);
});

/** GET /products/audit — duplicate codes/names, zero prices, missing categories. */
export const auditCatalogue = asyncHandler(async (_req, res) => {
  return sendSuccess(res, await productService.auditCatalogue());
});
