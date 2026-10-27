import { Types } from 'mongoose';

import {
  ACTIVE_SERVICE_REQUEST_STATUSES,
  AUDIT_ACTION,
  AUDIT_ENTITY,
  ITEM_STATUS,
  SESSION_STATUS,
  SOCKET_EVENTS,
} from '../config/constants.js';
import { env } from '../config/env.js';
import {
  NOT_DELETED,
  OrderRound,
  ServiceRequest,
  TableMaster,
  TableSession,
  type TableMasterDocument,
} from '../models/index.js';
import { emitToStaff } from '../sockets/emitter.js';
import type { LiveTableTile } from '../types/common.js';
import { ApiError } from '../utils/ApiError.js';
import { compact, minutesSince } from '../utils/helpers.js';
import { actorSnapshot, type Actor } from '../utils/actor.js';
import * as auditService from './audit.service.js';
import * as zoneService from './zone.service.js';

/**
 * Table master data and the live table grid.
 *
 * A table stores its zone's id; every response carries the zone's current
 * name as `zone` beside `zoneId`, so screens that only print the name never
 * had to change.
 */

export interface ListTablesFilter {
  zoneId?: string;
  includeInactive?: boolean;
}

/** A table as admin screens and the API see it. */
export interface TableView {
  _id: string;
  code: string;
  zoneId: string;
  zone: string;
  displayOrder: number;
  seatingCapacity: number;
  isActive: boolean;
  notes: string;
}

type ZoneNames = Awaited<ReturnType<typeof zoneService.nameMap>>;

function toView(table: TableMasterDocument, zones: ZoneNames): TableView {
  const zoneId = String(table.zoneId ?? '');
  return {
    _id: String(table._id),
    code: table.code,
    zoneId,
    zone: zones.get(zoneId)?.name ?? '',
    displayOrder: table.displayOrder,
    seatingCapacity: table.seatingCapacity,
    isActive: table.isActive,
    notes: table.notes,
  };
}

/** One table, shaped for a response. */
export async function view(table: TableMasterDocument): Promise<TableView> {
  return toView(table, await zoneService.nameMap());
}

/** Live tables in floor order: by zone order, then the table's own order. */
export async function list(filter: ListTablesFilter): Promise<TableView[]> {
  const query: Record<string, unknown> = { ...NOT_DELETED };
  if (!filter.includeInactive) query.isActive = true;
  if (filter.zoneId) query.zoneId = new Types.ObjectId(filter.zoneId);

  const [tables, zones] = await Promise.all([TableMaster.find(query), zoneService.nameMap()]);
  const zoneOrder = (table: TableMasterDocument) =>
    zones.get(String(table.zoneId))?.displayOrder ?? Number.MAX_SAFE_INTEGER;

  return tables
    .sort(
      (a, b) =>
        zoneOrder(a) - zoneOrder(b) ||
        a.displayOrder - b.displayOrder ||
        a.code.localeCompare(b.code),
    )
    .map((table) => toView(table, zones));
}

/** A live table. A deleted one is "not found" to every caller. */
export async function getByIdOrThrow(id: string): Promise<TableMasterDocument> {
  const table = await TableMaster.findOne({ _id: id, ...NOT_DELETED });
  if (!table) throw ApiError.notFound('Table not found');
  return table;
}

async function assertCodeFree(code: string, exceptId?: Types.ObjectId): Promise<void> {
  const normalised = code.trim().toUpperCase();
  const clash = await TableMaster.findOne({
    code: normalised,
    ...NOT_DELETED,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .select('_id')
    .lean();
  if (clash) throw ApiError.conflict(`Table ${normalised} already exists`);
}

export async function create(
  payload: Record<string, unknown>,
  actor: Actor,
): Promise<TableMasterDocument> {
  const zone = await zoneService.getLiveOrThrow(payload.zoneId as string);
  await assertCodeFree(String(payload.code));

  const table = await TableMaster.create({ ...payload, zoneId: zone._id });

  await auditService.record({
    entityType: AUDIT_ENTITY.TABLE,
    entityId: table._id,
    action: AUDIT_ACTION.TABLE_CREATED,
    actor,
    tableCode: table.code,
    after: { code: table.code, zone: zone.name, seatingCapacity: table.seatingCapacity },
  });

  emitToStaff(SOCKET_EVENTS.TABLE_STATUS, { tableId: String(table._id), tableCode: table.code });
  return table;
}

export async function update(
  id: string,
  payload: Record<string, unknown>,
  actor: Actor,
): Promise<TableMasterDocument> {
  const table = await getByIdOrThrow(id);
  const zones = await zoneService.nameMap();
  const zoneName = (zoneId: unknown) => zones.get(String(zoneId))?.name ?? '';
  const before = {
    code: table.code,
    zone: zoneName(table.zoneId),
    seatingCapacity: table.seatingCapacity,
    isActive: table.isActive,
  };

  // Re-checked here, not trusted from the form: the zone may have been deleted
  // in another tab between opening the dialog and pressing Save.
  if (payload.zoneId !== undefined) {
    const zone = await zoneService.getLiveOrThrow(payload.zoneId as string);
    payload.zoneId = zone._id;
  }
  if (typeof payload.code === 'string' && payload.code.trim().toUpperCase() !== table.code) {
    await assertCodeFree(payload.code, table._id);
  }

  // Retiring a table with a live session would strand the order.
  if (payload.isActive === false) {
    const live = await TableSession.findOne({ tableId: table._id, isActive: true })
      .select('_id sessionNumber')
      .lean();
    if (live) {
      throw ApiError.conflict('Close the open session on this table before deactivating it', {
        sessionId: String(live._id),
      });
    }
  }

  table.set(compact(payload));
  await table.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.TABLE,
    entityId: table._id,
    action: AUDIT_ACTION.TABLE_UPDATED,
    actor,
    tableCode: table.code,
    before,
    after: {
      code: table.code,
      zone: zoneName(table.zoneId),
      seatingCapacity: table.seatingCapacity,
      isActive: table.isActive,
    },
  });

  emitToStaff(SOCKET_EVENTS.TABLE_STATUS, { tableId: String(table._id), tableCode: table.code });
  return table;
}

/**
 * Deletes a table (soft — see models/softDelete.ts).
 *
 * Refused while a session is open or a guest's call is unanswered: either one
 * would vanish from the floor with the table and be stranded. Everything that
 * already happened at the table — sessions, rounds, bills, the audit trail —
 * stores the code it had at the time and is untouched.
 *
 * The table is switched off *before* the checks run, so a guest scanning the
 * sticker in the same instant is refused by the ordinary "not in service"
 * guard instead of opening a session on a table that is about to disappear.
 * If a check fails the switch is put back.
 */
export async function remove(
  id: string,
  reason: string,
  actor: Actor,
): Promise<TableMasterDocument> {
  const table = await getByIdOrThrow(id);
  const wasActive = table.isActive;

  table.isActive = false;
  await table.save();

  const [live, openRequests] = await Promise.all([
    TableSession.findOne({ tableId: table._id, isActive: true }).select('_id').lean(),
    ServiceRequest.countDocuments({
      tableId: table._id,
      status: { $in: ACTIVE_SERVICE_REQUEST_STATUSES },
    }),
  ]);

  if (live || openRequests > 0) {
    table.isActive = wasActive;
    await table.save();
    if (live) {
      throw ApiError.conflict(
        `Table ${table.code} has an open session. Bill it or free the table first.`,
        { sessionId: String(live._id) },
      );
    }
    throw ApiError.conflict(
      `Table ${table.code} has ${openRequests} open request${openRequests === 1 ? '' : 's'}. Resolve them first.`,
    );
  }

  table.isDeleted = true;
  table.deletedAt = new Date();
  table.deletedBy = actorSnapshot(actor);
  table.deleteReason = reason;
  await table.save();

  const zones = await zoneService.nameMap();
  await auditService.record({
    entityType: AUDIT_ENTITY.TABLE,
    entityId: table._id,
    action: AUDIT_ACTION.TABLE_DELETED,
    actor,
    tableCode: table.code,
    before: {
      code: table.code,
      zone: zones.get(String(table.zoneId))?.name ?? '',
      seatingCapacity: table.seatingCapacity,
      isActive: wasActive,
    },
    meta: { reason },
  });

  emitToStaff(SOCKET_EVENTS.TABLE_STATUS, {
    tableId: String(table._id),
    tableCode: table.code,
    deleted: true,
  });
  return table;
}

/**
 * The URL that goes into the printed QR for a table.
 *
 * It is derived purely from the code, which is why there is no longer a
 * "rotate the QR" operation: a sticker is reprinted from the same URL, and
 * re-lettering a table changes the URL as a consequence of the rename.
 */
export function qrUrl(code: string): string {
  return `${env.customerBaseUrl.replace(/\/$/, '')}/order/${code}`;
}

/**
 * Resolves a scanned table code to its table and live session.
 *
 * Returns a `warning` when the table has a session that already asked for the
 * bill: a new guest sitting down must not have their order silently merged
 * into the bill the previous group is settling.
 */
export async function resolveQr(code: string): Promise<Record<string, unknown>> {
  const normalised = code.trim().toUpperCase();
  const table = await TableMaster.findOne({ code: normalised, ...NOT_DELETED }).lean();
  if (!table) {
    // A sticker still on a table that was deleted: say so, rather than
    // "unknown", so the guest asks staff instead of retyping the code.
    const deleted = await TableMaster.exists({ code: normalised, isDeleted: true });
    if (deleted) {
      throw ApiError.invalidState('This table is no longer in service. Please ask staff for help.');
    }
    throw ApiError.notFound('Unknown table code. Please ask staff for help.');
  }
  if (!table.isActive) throw ApiError.invalidState('This table is not in service');
  const zones = await zoneService.nameMap();

  const session = await TableSession.findOne({ tableId: table._id, isActive: true }).lean();

  let warning: string | null = null;
  if (session?.status === SESSION_STATUS.BILL_REQUESTED) {
    warning =
      'This table is settling a bill. Please ask a staff member before ordering, so your order is not added to the previous bill.';
  }

  return {
    table: {
      id: String(table._id),
      code: table.code,
      zone: zones.get(String(table.zoneId))?.name ?? '',
      seatingCapacity: table.seatingCapacity,
    },
    session: session
      ? {
          id: String(session._id),
          sessionNumber: session.sessionNumber,
          status: session.status,
          openedAt: session.openedAt,
          runningTotal: session.runningTotal,
          totalRounds: session.totalRounds,
          billRequestedAt: session.billRequestedAt,
        }
      : null,
    warning,
  };
}

/**
 * The live table grid.
 *
 * Assembled from four small reads rather than one aggregation pipeline: at
 * one-café volume the difference is unmeasurable, and this version can be read
 * and changed by whoever maintains it next.
 */
export async function getLiveGrid(filter: ListTablesFilter = {}): Promise<LiveTableTile[]> {
  const tables = await list(filter);

  const sessions = await TableSession.find({ isActive: true }).lean();
  const sessionByTable = new Map(sessions.map((session) => [String(session.tableId), session]));
  const sessionIds = sessions.map((session) => session._id);

  // Bills moved between tables: a moved table's tile says where its bill went,
  // and the paying table's tile carries everyone's total. Riders already
  // freed still count — their orders are still on the bill.
  const sessionById = new Map(sessions.map((session) => [String(session._id), session]));
  const riders = await TableSession.find({ billMovedTo: { $in: sessionIds } })
    .select('billMovedTo tableCode runningTotal isActive')
    .lean();

  const [rounds, requests] = await Promise.all([
    OrderRound.find({ sessionId: { $in: sessionIds } })
      .select('sessionId items')
      .lean(),
    ServiceRequest.find({ status: { $in: ACTIVE_SERVICE_REQUEST_STATUSES } })
      .select('tableId type raisedAt')
      .lean(),
  ]);

  const countsBySession = new Map<string, { pending: number; ready: number; rounds: number }>();
  for (const round of rounds) {
    const key = String(round.sessionId);
    const entry = countsBySession.get(key) ?? { pending: 0, ready: 0, rounds: 0 };
    entry.rounds += 1;
    for (const item of round.items) {
      if (
        item.status === ITEM_STATUS.PENDING ||
        item.status === ITEM_STATUS.ACCEPTED ||
        item.status === ITEM_STATUS.PREPARING
      ) {
        entry.pending += 1;
      }
      if (item.status === ITEM_STATUS.READY) entry.ready += 1;
    }
    countsBySession.set(key, entry);
  }

  const requestsByTable = new Map<string, { count: number; oldest: Date }>();
  for (const request of requests) {
    const key = String(request.tableId);
    const entry = requestsByTable.get(key);
    if (!entry) {
      requestsByTable.set(key, { count: 1, oldest: request.raisedAt });
    } else {
      entry.count += 1;
      if (request.raisedAt < entry.oldest) entry.oldest = request.raisedAt;
    }
  }

  return tables.map((table) => {
    const tableId = table._id;
    const session = sessionByTable.get(tableId);
    const counts = session
      ? (countsBySession.get(String(session._id)) ?? { pending: 0, ready: 0, rounds: 0 })
      : { pending: 0, ready: 0, rounds: 0 };
    const requestInfo = requestsByTable.get(tableId);
    const oldestRequestMinutes = requestInfo ? minutesSince(requestInfo.oldest) : 0;

    return {
      tableId,
      code: table.code,
      zoneId: table.zoneId,
      zone: table.zone,
      displayOrder: table.displayOrder,
      seatingCapacity: table.seatingCapacity,
      status: session ? session.status : 'empty',
      sessionId: session ? String(session._id) : null,
      sessionNumber: session?.sessionNumber ?? null,
      openedAt: session?.openedAt ?? null,
      minutesOpen: session ? minutesSince(session.openedAt) : 0,
      runningTotal: session
        ? session.runningTotal +
          riders
            .filter((rider) => String(rider.billMovedTo) === String(session._id))
            .reduce((sum, rider) => sum + rider.runningTotal, 0)
        : 0,
      billWithTableCode: session?.billMovedTo
        ? (sessionById.get(String(session.billMovedTo))?.tableCode ?? null)
        : null,
      billIncludes: session
        ? riders
            .filter((rider) => rider.isActive && String(rider.billMovedTo) === String(session._id))
            .map((rider) => rider.tableCode)
        : [],
      roundCount: counts.rounds,
      pendingItemCount: counts.pending,
      readyItemCount: counts.ready,
      openServiceRequests: requestInfo?.count ?? 0,
      billRequested: Boolean(session?.billRequestedAt),
      oldestRequestMinutes,
      // Drives the red flash: someone has been waiting too long, or food is
      // sitting ready under the pass.
      needsAttention:
        oldestRequestMinutes >= env.serviceRequestEscalationMinutes || counts.ready > 0,
    } satisfies LiveTableTile;
  });
}
