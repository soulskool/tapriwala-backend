import { Types } from 'mongoose';

import type { AuditAction, AuditEntity } from '../config/constants.js';
import { AuditLog } from '../models/AuditLog.js';
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
  if (query.action) filter.action = query.action;
  if (query.from || query.to) {
    filter.timestamp = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  return { items, total };
}

export default { record, recordAsync, list };
