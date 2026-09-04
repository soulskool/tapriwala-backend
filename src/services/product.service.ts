import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  SOCKET_EVENTS,
  type KitchenStation,
} from '../config/constants.js';
import { env } from '../config/env.js';
import { ProductMaster, type ProductMasterDocument } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { compact } from '../utils/helpers.js';
import type { Actor } from '../utils/actor.js';
import { emitToAll } from '../sockets/emitter.js';
import * as auditService from './audit.service.js';
import { removeImage, saveImage, type UploadInput } from './storage/index.js';

/**
 * Menu master data.
 *
 * The two "off" switches matter and are not interchangeable: `isAvailable`
 * is today's 86 list (comes back tomorrow), `isActive` is retirement. Only
 * `isActive: false` hides an item from admin screens; an 86'd item still needs
 * to be visible to staff so they can un-86 it.
 */

export interface ListProductsFilter {
  category?: string;
  station?: KitchenStation;
  search?: string;
  availableOnly?: boolean;
  includeInactive?: boolean;
}

export async function list(filter: ListProductsFilter): Promise<ProductMasterDocument[]> {
  const query: Record<string, unknown> = {};

  if (!filter.includeInactive) query.isActive = true;
  if (filter.availableOnly) query.isAvailable = true;
  if (filter.category) query.category = filter.category;
  if (filter.station) query.kitchenStation = filter.station;

  if (filter.search) {
    // Plain regex rather than $text: the menu is small, and staff expect
    // "cof" to match "Cold Coffee" — a text index would not.
    const escaped = filter.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    query.$or = [{ displayName: pattern }, { posName: pattern }, { productCode: pattern }];
  }

  return ProductMaster.find(query).sort({ category: 1, displayOrder: 1, displayName: 1 });
}

/** Menu grouped by category — the shape the customer and waiter screens render. */
export async function getMenu(options: { forCustomer: boolean }): Promise<
  { category: string; items: unknown[] }[]
> {
  const query: Record<string, unknown> = { isActive: true };
  // Staff still see 86'd items (greyed out); customers should not see them at all.
  if (options.forCustomer) query.isAvailable = true;

  const products = await ProductMaster.find(query)
    .sort({ category: 1, displayOrder: 1, displayName: 1 })
    .lean();

  const grouped = new Map<string, unknown[]>();
  for (const product of products) {
    const bucket = grouped.get(product.category) ?? [];
    bucket.push({
      id: String(product._id),
      productCode: product.productCode,
      displayName: product.displayName,
      description: product.description,
      price: product.price,
      taxPercent: product.taxPercent,
      imageUrl: product.imageUrl,
      kitchenStation: product.kitchenStation,
      isAvailable: product.isAvailable,
      // POS name is an internal detail; never ship it to a customer phone.
      ...(options.forCustomer ? {} : { posName: product.posName }),
    });
    grouped.set(product.category, bucket);
  }

  return Array.from(grouped.entries()).map(([category, items]) => ({ category, items }));
}

export async function getByIdOrThrow(id: string): Promise<ProductMasterDocument> {
  const product = await ProductMaster.findById(id);
  if (!product) throw ApiError.notFound('Product not found');
  return product;
}

export async function create(
  payload: Record<string, unknown>,
  actor: Actor,
): Promise<ProductMasterDocument> {
  const product = await ProductMaster.create({
    ...payload,
    taxPercent: payload.taxPercent ?? env.defaultTaxPercent,
  });

  await auditService.record({
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product._id,
    action: AUDIT_ACTION.PRODUCT_CREATED,
    actor,
    after: product.toObject(),
  });

  return product;
}

export async function update(
  id: string,
  payload: Record<string, unknown>,
  actor: Actor,
): Promise<ProductMasterDocument> {
  const product = await getByIdOrThrow(id);
  const before = product.toObject();

  product.set(compact(payload));
  await product.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product._id,
    action: AUDIT_ACTION.PRODUCT_UPDATED,
    actor,
    before,
    after: product.toObject(),
  });

  // A price edit must never reach rounds already placed — those snapshot their
  // own price. Live menus do need to repaint, hence the broadcast.
  if (before.price !== product.price || before.isAvailable !== product.isAvailable) {
    emitToAll(SOCKET_EVENTS.PRODUCT_AVAILABILITY, {
      productCode: product.productCode,
      displayName: product.displayName,
      price: product.price,
      isAvailable: product.isAvailable,
    });
  }

  return product;
}

/**
 * The 86 toggle.
 *
 * Broadcast immediately so a customer cannot add the last sandwich four
 * seconds after the kitchen ran out. Rounds already placed keep their item —
 * the KDS flags it as unavailable so a cook raises it with the floor instead
 * of the line vanishing from someone's order silently.
 */
export async function setAvailability(
  id: string,
  isAvailable: boolean,
  actor: Actor,
  reason = '',
): Promise<ProductMasterDocument> {
  const product = await getByIdOrThrow(id);
  const before = product.isAvailable;

  if (before === isAvailable) return product;

  product.isAvailable = isAvailable;
  await product.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product._id,
    action: AUDIT_ACTION.PRODUCT_AVAILABILITY_TOGGLED,
    actor,
    before: { isAvailable: before },
    after: { isAvailable },
    meta: { reason, productCode: product.productCode },
  });

  emitToAll(SOCKET_EVENTS.PRODUCT_AVAILABILITY, {
    productCode: product.productCode,
    displayName: product.displayName,
    isAvailable,
    reason,
  });

  return product;
}

/**
 * Attaches an image to a product.
 *
 * The previous file is deleted after the new one is stored, not before: if the
 * upload fails, the product keeps the image it had rather than ending up with
 * none. Orphaning a file is recoverable; showing a broken image on the menu
 * during service is not.
 */
export async function setImage(
  id: string,
  file: Omit<UploadInput, 'folder'>,
  actor: Actor,
): Promise<ProductMasterDocument> {
  const product = await getByIdOrThrow(id);
  const previousKey = product.imageKey;

  const stored = await saveImage({ ...file, folder: 'products' });

  product.imageUrl = stored.url;
  product.imageKey = stored.key;
  await product.save();

  if (previousKey && previousKey !== stored.key) await removeImage(previousKey);

  await auditService.record({
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product._id,
    action: AUDIT_ACTION.PRODUCT_UPDATED,
    actor,
    before: { imageUrl: '', imageKey: previousKey },
    after: { imageUrl: product.imageUrl, imageKey: product.imageKey },
    meta: { source: 'image_upload', sizeBytes: stored.size, mimeType: stored.mimeType },
  });

  emitToAll(SOCKET_EVENTS.PRODUCT_AVAILABILITY, {
    productCode: product.productCode,
    displayName: product.displayName,
    isAvailable: product.isAvailable,
    imageUrl: product.imageUrl,
  });

  return product;
}

/** Removes a product image and its stored file. */
export async function clearImage(id: string, actor: Actor): Promise<ProductMasterDocument> {
  const product = await getByIdOrThrow(id);
  const previousKey = product.imageKey;

  product.imageUrl = '';
  product.imageKey = '';
  await product.save();

  await removeImage(previousKey);

  await auditService.record({
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product._id,
    action: AUDIT_ACTION.PRODUCT_UPDATED,
    actor,
    before: { imageKey: previousKey },
    after: { imageUrl: '', imageKey: '' },
    meta: { source: 'image_removed' },
  });

  return product;
}

export interface BulkRow {
  productCode: string;
  posName: string;
  displayName: string;
  category: string;
  price: number;
  taxPercent?: number;
  kitchenStation?: KitchenStation;
  description?: string;
  displayOrder?: number;
}

export interface BulkResult {
  created: number;
  updated: number;
  skipped: { productCode: string; reason: string }[];
}

/**
 * Upsert a batch of products by `productCode` — the Excel import path.
 *
 * Duplicate codes inside the same upload are rejected rather than
 * last-one-wins, because a duplicate code in the source sheet is exactly the
 * data problem this import exists to surface.
 */
export async function bulkUpsert(rows: BulkRow[], actor: Actor): Promise<BulkResult> {
  const result: BulkResult = { created: 0, updated: 0, skipped: [] };
  const seen = new Set<string>();

  for (const row of rows) {
    const productCode = row.productCode.trim().toUpperCase();

    if (seen.has(productCode)) {
      result.skipped.push({ productCode, reason: 'Duplicate productCode in upload' });
      continue;
    }
    seen.add(productCode);

    const existing = await ProductMaster.findOne({ productCode });

    if (existing) {
      const before = existing.toObject();
      existing.set(
        compact({
          posName: row.posName,
          displayName: row.displayName,
          category: row.category,
          price: row.price,
          taxPercent: row.taxPercent,
          kitchenStation: row.kitchenStation,
          description: row.description,
          displayOrder: row.displayOrder,
        }),
      );
      await existing.save();
      result.updated += 1;

      await auditService.record({
        entityType: AUDIT_ENTITY.PRODUCT,
        entityId: existing._id,
        action: AUDIT_ACTION.PRODUCT_UPDATED,
        actor,
        before,
        after: existing.toObject(),
        meta: { source: 'bulk_upsert' },
      });
      continue;
    }

    const created = await ProductMaster.create({
      productCode,
      posName: row.posName,
      displayName: row.displayName,
      category: row.category,
      price: row.price,
      taxPercent: row.taxPercent ?? env.defaultTaxPercent,
      kitchenStation: row.kitchenStation ?? 'Kitchen',
      description: row.description ?? '',
      displayOrder: row.displayOrder ?? 0,
    });
    result.created += 1;

    await auditService.record({
      entityType: AUDIT_ENTITY.PRODUCT,
      entityId: created._id,
      action: AUDIT_ACTION.PRODUCT_CREATED,
      actor,
      after: created.toObject(),
      meta: { source: 'bulk_upsert' },
    });
  }

  return result;
}

/** Distinct category list for the menu tabs. */
export async function getCategories(): Promise<string[]> {
  const categories = await ProductMaster.distinct('category', { isActive: true });
  return (categories).sort((a, b) => a.localeCompare(b));
}

/**
 * Data-quality report over ProductMaster — duplicate POS names, zero prices,
 * missing categories. Run this against the imported Excel before go-live.
 */
export async function auditCatalogue(): Promise<Record<string, unknown>> {
  const products = await ProductMaster.find({ isActive: true }).lean();

  const byPosName = new Map<string, string[]>();
  const byDisplayName = new Map<string, string[]>();
  const zeroPrice: string[] = [];
  const missingCategory: string[] = [];

  for (const product of products) {
    const posKey = product.posName.trim().toLowerCase();
    byPosName.set(posKey, [...(byPosName.get(posKey) ?? []), product.productCode]);

    const displayKey = product.displayName.trim().toLowerCase();
    byDisplayName.set(displayKey, [...(byDisplayName.get(displayKey) ?? []), product.productCode]);

    if (product.price <= 0) zeroPrice.push(product.productCode);
    if (!product.category?.trim()) missingCategory.push(product.productCode);
  }

  const duplicates = (map: Map<string, string[]>) =>
    Array.from(map.entries())
      .filter(([, codes]) => codes.length > 1)
      .map(([name, codes]) => ({ name, productCodes: codes }));

  return {
    totalActive: products.length,
    duplicatePosNames: duplicates(byPosName),
    duplicateDisplayNames: duplicates(byDisplayName),
    zeroOrNegativePrice: zeroPrice,
    missingCategory,
    unavailableToday: products.filter((p) => !p.isAvailable).map((p) => p.productCode),
  };
}
