import { Types } from 'mongoose';

import type { AuditAction, AuditEntity } from '../config/constants.js';
import { AuditLog } from '../models/AuditLog.js';
import { ProductMaster } from '../models/ProductMaster.js';
import { logger } from '../utils/logger.js';
import { actorSnapshot, type Actor } from '../utils/actor.js';

export interface AuditInput {
  entityType: AuditEntity;
  entityId: Types.ObjectId | string;
  action: AuditAction;
  actor: Actor;
  sessionId?: Types.ObjectId | string | null;
  tableCode?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Writes one audit row.
 *
 * Awaited by callers that must not lose the trail (cancellations, closes,
 * price overrides). A failure here is logged but never bubbles: losing an audit
 * row is bad, but failing a customer's order because the audit write failed is
 * worse — the log line is what tells you it happened.
 */
export async function record(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      entityType: input.entityType,
      entityId: new Types.ObjectId(String(input.entityId)),
      action: input.action,
      actor: actorSnapshot(input.actor),
      sessionId: input.sessionId ? new Types.ObjectId(String(input.sessionId)) : null,
      tableCode: input.tableCode ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      meta: input.meta ?? {},
      ip: input.ip ?? null,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to write audit log for ${input.action}`, {
      entityType: input.entityType,
      entityId: String(input.entityId),
      error: (error as Error).message,
    });
  }
}

/** Fire-and-forget variant for high-frequency, low-stakes events. */
export function recordAsync(input: AuditInput): void {
  void record(input);
}

export interface AuditQuery {
  entityType?: AuditEntity;
  entityId?: string;
  sessionId?: string;
  tableCode?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
}

/** Paginated audit browse for the admin screen. */
export async function list(
  query: AuditQuery,
  skip: number,
  limit: number,
): Promise<{ items: unknown[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = new Types.ObjectId(query.entityId);
  if (query.sessionId) filter.sessionId = new Types.ObjectId(query.sessionId);
  if (query.tableCode) filter.tableCode = query.tableCode.toUpperCase();
  if (query.action) filter.action = query.action;
  if (query.from || query.to) {
    filter.timestamp = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  return { items: await withProductNames(rows), total };
}

type Bag = Record<string, unknown> | null | undefined;

/** Every product code a row mentions, wherever that action keeps it. */
function productCodesIn(row: { before?: unknown; after?: unknown; meta?: unknown }): string[] {
  const codes: string[] = [];
  for (const bag of [row.before, row.after, row.meta] as Bag[]) {
    if (!bag) continue;
    if (typeof bag.productCode === 'string') codes.push(bag.productCode);
    if (Array.isArray(bag.items)) {
      for (const item of bag.items as Bag[]) {
        if (typeof item?.productCode === 'string') codes.push(item.productCode);
      }
    }
  }
  return codes;
}

/**
 * Attaches `productNames` (code → menu name) to each row that mentions a
 * product, so the admin screen can say "2 x Masala Tea" instead of "2 x BEV001".
 *
 * New rows carry the name they were written with; this is the fallback for
 * rows written before that, and costs one indexed query per page.
 */
async function withProductNames<T extends { before?: unknown; after?: unknown; meta?: unknown }>(
  rows: T[],
): Promise<(T & { productNames?: Record<string, string> })[]> {
  const codes = [...new Set(rows.flatMap(productCodesIn))];
  if (codes.length === 0) return rows;

  const products = await ProductMaster.find({ productCode: { $in: codes } })
    .select('productCode displayName')
    .lean();
  const names = new Map(products.map((product) => [product.productCode, product.displayName]));

  return rows.map((row) => {
    const mine = productCodesIn(row).filter((code) => names.has(code));
    if (mine.length === 0) return row;
    return {
      ...row,
      productNames: Object.fromEntries(mine.map((code) => [code, names.get(code)!])),
    };
  });
}

export default { record, recordAsync, list };
