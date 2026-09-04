import {
  ACTIVE_SERVICE_REQUEST_STATUSES,
  AUDIT_ACTION,
  AUDIT_ENTITY,
  ITEM_STATUS,
  SESSION_STATUS,
  type TableZone,
} from '../config/constants.js';
import { env } from '../config/env.js';
import {
  OrderRound,
  ServiceRequest,
  TableMaster,
  TableSession,
  type TableMasterDocument,
} from '../models/index.js';
import type { LiveTableTile } from '../types/common.js';
import { ApiError } from '../utils/ApiError.js';
import { compact, minutesSince } from '../utils/helpers.js';
import type { Actor } from '../utils/actor.js';
import * as auditService from './audit.service.js';

/**
 * Table master data and the live table grid.
 */

export interface ListTablesFilter {
  zone?: TableZone;
  includeInactive?: boolean;
}

export async function list(filter: ListTablesFilter): Promise<TableMasterDocument[]> {
  const query: Record<string, unknown> = {};
  if (!filter.includeInactive) query.isActive = true;
  if (filter.zone) query.zone = filter.zone;

  return TableMaster.find(query).sort({ zone: 1, displayOrder: 1, code: 1 });
}

export async function getByIdOrThrow(id: string): Promise<TableMasterDocument> {
  const table = await TableMaster.findById(id);
  if (!table) throw ApiError.notFound('Table not found');
  return table;
}

export async function create(
  payload: Record<string, unknown>,
  actor: Actor,
): Promise<TableMasterDocument> {
  const table = await TableMaster.create(payload);

  await auditService.record({
    entityType: AUDIT_ENTITY.TABLE,
    entityId: table._id,
    action: AUDIT_ACTION.TABLE_CREATED,
    actor,
    tableCode: table.code,
    after: { code: table.code, zone: table.zone },
  });

  return table;
}

export async function update(
  id: string,
  payload: Record<string, unknown>,
  actor: Actor,
): Promise<TableMasterDocument> {
  const table = await getByIdOrThrow(id);
  const before = { code: table.code, zone: table.zone, isActive: table.isActive };

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
    after: { code: table.code, zone: table.zone, isActive: table.isActive },
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
  const table = await TableMaster.findOne({ code: code.trim().toUpperCase() }).lean();
  if (!table) throw ApiError.notFound('Unknown table code. Please ask staff for help.');
  if (!table.isActive) throw ApiError.invalidState('This table is not in service');

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
      zone: table.zone,
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
    const tableId = String(table._id);
    const session = sessionByTable.get(tableId);
    const counts = session
      ? (countsBySession.get(String(session._id)) ?? { pending: 0, ready: 0, rounds: 0 })
      : { pending: 0, ready: 0, rounds: 0 };
    const requestInfo = requestsByTable.get(tableId);
    const oldestRequestMinutes = requestInfo ? minutesSince(requestInfo.oldest) : 0;

    return {
      tableId,
      code: table.code,
      zone: table.zone,
      displayOrder: table.displayOrder,
      seatingCapacity: table.seatingCapacity,
      status: session ? session.status : 'empty',
      sessionId: session ? String(session._id) : null,
      sessionNumber: session?.sessionNumber ?? null,
      openedAt: session?.openedAt ?? null,
      minutesOpen: session ? minutesSince(session.openedAt) : 0,
      runningTotal: session?.runningTotal ?? 0,
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
