import { Types } from 'mongoose';

import {
  ACTIVE_SERVICE_REQUEST_STATUSES,
  AUDIT_ACTION,
  AUDIT_ENTITY,
  ROLES,
  SERVICE_REQUEST_STATUS,
  SERVICE_REQUEST_TYPE,
  SOCKET_EVENTS,
  type ServiceRequestStatus,
  type ServiceRequestType,
} from '../config/constants.js';
import { env } from '../config/env.js';
import { ServiceRequest, TableMaster, type ServiceRequestDocument } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { minutesSince } from '../utils/helpers.js';
import { actorSnapshot, type Actor } from '../utils/actor.js';
import { broadcast } from '../sockets/emitter.js';
import * as auditService from './audit.service.js';
import * as sessionService from './session.service.js';

/**
 * Water / call-staff / bill requests.
 *
 * The dashboard these feed is the answer to the veranda-and-lawn problem:
 * a guest out of eyeshot taps once and a waiter sees it, with the wait time
 * counting up, instead of waving at nobody.
 */

export interface RaiseInput {
  tableId: string;
  sessionId?: string | null;
  type: ServiceRequestType;
  note?: string;
  actor: Actor;
  ip?: string | null;
}

/**
 * Raises a request, or bumps the live one.
 *
 * A guest tapping "Call Staff" five times is impatient, not five guests: the
 * repeat taps raise `repeatCount` on the existing row so the dashboard shows
 * one increasingly loud line instead of five rows to dismiss. `raisedAt` is
 * kept from the first tap so the true wait time never resets.
 */
export async function raise(
  input: RaiseInput,
): Promise<{ request: ServiceRequestDocument; created: boolean }> {
  const table = await TableMaster.findById(input.tableId).select('code isActive').lean();
  if (!table) throw ApiError.notFound('Table not found');
  if (!table.isActive) throw ApiError.invalidState('This table is not in service');

  const sessionId = input.sessionId ? new Types.ObjectId(input.sessionId) : null;

  const existing = await ServiceRequest.findOne({
    tableId: table._id,
    type: input.type,
    status: { $in: ACTIVE_SERVICE_REQUEST_STATUSES },
  });

  if (existing) {
    existing.repeatCount += 1;
    existing.lastRaisedAt = new Date();
    if (input.note) existing.note = input.note;
    await existing.save();

    broadcast(SOCKET_EVENTS.SERVICE_REQUEST_UPDATE, serializeRequest(existing), {
      tableId: String(table._id),
      sessionId: existing.sessionId ? String(existing.sessionId) : null,
    });

    return { request: existing, created: false };
  }

  const request = await ServiceRequest.create({
    tableId: table._id,
    tableCode: table.code,
    sessionId,
    type: input.type,
    status: SERVICE_REQUEST_STATUS.OPEN,
    raisedAt: new Date(),
    lastRaisedAt: new Date(),
    repeatCount: 1,
    raisedBy: actorSnapshot(input.actor),
    note: input.note ?? '',
  });

  // "Request bill" is more than a notification — it moves the session into the
  // billing queue, which is what the counter screen watches.
  if (input.type === SERVICE_REQUEST_TYPE.BILL && sessionId) {
    await sessionService.markBillRequested(sessionId, input.actor);
  }

  await auditService.record({
    entityType: AUDIT_ENTITY.SERVICE_REQUEST,
    entityId: request._id,
    action: AUDIT_ACTION.SERVICE_REQUEST_RAISED,
    actor: input.actor,
    sessionId,
    tableCode: table.code,
    after: { type: input.type },
    ip: input.ip ?? null,
  });

  broadcast(SOCKET_EVENTS.SERVICE_REQUEST_NEW, serializeRequest(request), {
    tableId: String(table._id),
    sessionId: sessionId ? String(sessionId) : null,
    roles: [ROLES.WAITER, ROLES.BILLING],
  });

  return { request, created: true };
}

export interface UpdateInput {
  requestId: string;
  status: ServiceRequestStatus;
  note?: string;
  actor: Actor;
  ip?: string | null;
}

/** Acknowledge (waiter is on the way), resolve (done) or cancel (raised by mistake). */
export async function update(input: UpdateInput): Promise<ServiceRequestDocument> {
  const request = await ServiceRequest.findById(input.requestId);
  if (!request) throw ApiError.notFound('Service request not found');

  if (
    request.status === SERVICE_REQUEST_STATUS.RESOLVED ||
    request.status === SERVICE_REQUEST_STATUS.CANCELLED
  ) {
    throw ApiError.invalidState(`This request is already ${request.status}`);
  }

  const before = request.status;
  const now = new Date();

  request.status = input.status;
  if (input.note) request.note = input.note;

  if (input.status === SERVICE_REQUEST_STATUS.ACKNOWLEDGED) {
    request.acknowledgedAt = now;
    request.acknowledgedBy = input.actor.userId;
  }
  if (
    input.status === SERVICE_REQUEST_STATUS.RESOLVED ||
    input.status === SERVICE_REQUEST_STATUS.CANCELLED
  ) {
    request.resolvedAt = now;
    request.resolvedBy = input.actor.userId;
    if (!request.acknowledgedAt) {
      // Resolved straight from open — record that it was seen at resolution.
      request.acknowledgedAt = now;
      request.acknowledgedBy = input.actor.userId;
    }
  }

  await request.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.SERVICE_REQUEST,
    entityId: request._id,
    action: AUDIT_ACTION.SERVICE_REQUEST_UPDATED,
    actor: input.actor,
    sessionId: request.sessionId,
    tableCode: request.tableCode,
    before: { status: before },
    after: { status: request.status },
    meta: {
      type: request.type,
      responseMinutes: minutesSince(request.raisedAt, now),
      note: input.note ?? '',
    },
    ip: input.ip ?? null,
  });

  broadcast(SOCKET_EVENTS.SERVICE_REQUEST_UPDATE, serializeRequest(request), {
    tableId: String(request.tableId),
    sessionId: request.sessionId ? String(request.sessionId) : null,
  });

  return request;
}

export interface ListFilter {
  status?: ServiceRequestStatus;
  type?: ServiceRequestType;
  tableId?: string;
  sessionId?: string;
  openOnly?: boolean;
  from?: Date;
  to?: Date;
}

export async function list(
  filter: ListFilter,
  skip: number,
  limit: number,
): Promise<{ items: unknown[]; total: number }> {
  const query: Record<string, unknown> = {};
  if (filter.status) query.status = filter.status;
  if (filter.openOnly) query.status = { $in: ACTIVE_SERVICE_REQUEST_STATUSES };
  if (filter.type) query.type = filter.type;
  if (filter.tableId) query.tableId = new Types.ObjectId(filter.tableId);
  if (filter.sessionId) query.sessionId = new Types.ObjectId(filter.sessionId);
  if (filter.from || filter.to) {
    query.raisedAt = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lte: filter.to } : {}),
    };
  }

  const [items, total] = await Promise.all([
    ServiceRequest.find(query).sort({ raisedAt: 1 }).skip(skip).limit(limit).lean(),
    ServiceRequest.countDocuments(query),
  ]);

  return { items: items.map(decorate), total };
}

/**
 * The waiter dashboard feed: every live request, oldest first, with an
 * escalation flag once it has been waiting past the configured threshold.
 */
export async function getLiveQueue(): Promise<Record<string, unknown>[]> {
  const requests = await ServiceRequest.find({
    status: { $in: ACTIVE_SERVICE_REQUEST_STATUSES },
  })
    .sort({ raisedAt: 1 })
    .lean();

  return requests.map(decorate);
}

/** Adds the computed fields the dashboards render (wait time, escalation). */
function decorate(request: Record<string, unknown>): Record<string, unknown> {
  const waitingMinutes = minutesSince(request.raisedAt as Date);
  return {
    ...request,
    waitingMinutes,
    isEscalated: waitingMinutes >= env.serviceRequestEscalationMinutes,
  };
}

function serializeRequest(request: ServiceRequestDocument): Record<string, unknown> {
  const waitingMinutes = minutesSince(request.raisedAt);
  return {
    requestId: String(request._id),
    tableId: String(request.tableId),
    tableCode: request.tableCode,
    sessionId: request.sessionId ? String(request.sessionId) : null,
    type: request.type,
    status: request.status,
    raisedAt: request.raisedAt,
    lastRaisedAt: request.lastRaisedAt,
    repeatCount: request.repeatCount,
    note: request.note,
    waitingMinutes,
    isEscalated: waitingMinutes >= env.serviceRequestEscalationMinutes,
  };
}
