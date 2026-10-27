import { Types } from 'mongoose';

import {
  ACTIVE_SERVICE_REQUEST_STATUSES,
  AUDIT_ACTION,
  AUDIT_ENTITY,
  ITEM_STATUS,
  ORDER_SOURCE,
  SERVICE_REQUEST_STATUS,
  SESSION_STATUS,
  SOCKET_EVENTS,
  type OrderSource,
  type SessionStatus,
} from '../config/constants.js';
import {
  BillingExport,
  OrderRound,
  ServiceRequest,
  TableMaster,
  TableSession,
  type TableSessionDocument,
} from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { minutesSince } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { actorSnapshot, type Actor } from '../utils/actor.js';
import { broadcast } from '../sockets/emitter.js';
import * as auditService from './audit.service.js';
import { nextSessionNumber } from './counter.service.js';
import { deriveRoundStatus, deriveSessionStatus, totalsForItems } from './statusDerivation.js';

/**
 * Table session lifecycle: open -> (rounds happen) -> bill requested -> closed.
 *
 * Everything that changes a session's shape funnels through here so the status
 * recomputation, the socket broadcast and the audit row can never be forgotten
 * by an individual controller.
 */

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function findActiveByTable(
  tableId: string | Types.ObjectId,
): Promise<TableSessionDocument | null> {
  return TableSession.findOne({ tableId, isActive: true });
}

export async function getByIdOrThrow(sessionId: string): Promise<TableSessionDocument> {
  const session = await TableSession.findById(sessionId);
  if (!session) throw ApiError.notFound('Session not found');
  return session;
}

/**
 * Everything one table screen needs in a single round-trip: the session, every
 * round with item statuses, the service-request history and live money totals.
 */
export async function getDetail(sessionId: string): Promise<Record<string, unknown>> {
  const session = await getByIdOrThrow(sessionId);

  const [rounds, requests] = await Promise.all([
    OrderRound.find({ sessionId: session._id }).sort({ roundNumber: 1 }).lean(),
    ServiceRequest.find({ sessionId: session._id }).sort({ raisedAt: -1 }).lean(),
  ]);

  const allItems = rounds.flatMap((round) => round.items);
  const totals = totalsForItems(allItems);

  const [payer, riders] = await Promise.all([
    session.billMovedTo
      ? TableSession.findById(session.billMovedTo).select('tableCode tableId').lean()
      : null,
    TableSession.find({ billMovedTo: session._id }).select('tableCode tableId isActive').lean(),
  ]);

  // The other tables' rounds, so the paying table's screen shows the whole bill.
  const riderRounds = riders.length
    ? await OrderRound.find({ sessionId: { $in: riders.map((rider) => rider._id) } })
        .sort({ roundNumber: 1 })
        .lean()
    : [];

  return {
    session: {
      ...session.toObject(),
      minutesOpen: minutesSince(session.openedAt),
    },
    /** Where this table's bill went, if it was moved. */
    billMovedTo: payer
      ? { sessionId: String(payer._id), tableId: String(payer.tableId), tableCode: payer.tableCode }
      : null,
    /** Tables whose bill was moved onto this one. */
    billIncludes: riders.map((rider) => {
      const rounds = riderRounds.filter((round) => round.sessionId.equals(rider._id));
      return {
        sessionId: String(rider._id),
        tableId: String(rider.tableId),
        tableCode: rider.tableCode,
        isActive: rider.isActive,
        rounds: rounds.map((round) => ({
          ...round,
          elapsedMinutes: minutesSince(round.placedAt),
          isAddOn: round.roundNumber > 1,
        })),
        totals: totalsForItems(rounds.flatMap((round) => round.items)),
      };
    }),
    /** This table plus every table on its bill — what the bill will charge. */
    billTotals: totalsForItems([...allItems, ...riderRounds.flatMap((round) => round.items)]),
    rounds: rounds.map((round) => ({
      ...round,
      elapsedMinutes: minutesSince(round.placedAt),
      isAddOn: round.roundNumber > 1,
    })),
    serviceRequests: requests.map((request) => ({
      ...request,
      waitingMinutes: minutesSince(request.raisedAt),
    })),
    totals,
  };
}

export interface ListSessionFilter {
  status?: SessionStatus;
  tableId?: string;
  activeOnly?: boolean;
  from?: Date;
  to?: Date;
}

export async function list(
  filter: ListSessionFilter,
  skip: number,
  limit: number,
): Promise<{ items: unknown[]; total: number }> {
  const query: Record<string, unknown> = {};
  if (filter.status) query.status = filter.status;
  if (filter.tableId) query.tableId = new Types.ObjectId(filter.tableId);
  if (filter.activeOnly) query.isActive = true;
  if (filter.from || filter.to) {
    query.openedAt = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lte: filter.to } : {}),
    };
  }

  const [items, total] = await Promise.all([
    TableSession.find(query).sort({ openedAt: -1 }).skip(skip).limit(limit).lean(),
    TableSession.countDocuments(query),
  ]);

  return { items, total };
}

// ─── Open ────────────────────────────────────────────────────────────────────

export interface OpenSessionInput {
  tableId: string;
  actor: Actor;
  source: OrderSource;
  guestCount?: number;
  ip?: string | null;
}

/**
 * Opens a session, or returns the existing one.
 *
 * Two customers scanning the same QR within a second, or a waiter tapping an
 * already-seated table, must land in the *same* session — never a duplicate.
 * The unique partial index on `{ tableId, isActive: true }` is the real
 * guarantee; the `existing` check below just avoids a wasted counter increment,
 * and the duplicate-key catch handles the genuine race.
 */
export async function open(
  input: OpenSessionInput,
): Promise<{ session: TableSessionDocument; created: boolean }> {
  const table = await TableMaster.findById(input.tableId).select('code isActive').lean();
  if (!table) throw ApiError.notFound('Table not found');
  if (!table.isActive) throw ApiError.invalidState('This table is not in service');

  const existing = await findActiveByTable(input.tableId);
  if (existing) return { session: existing, created: false };

  const sessionNumber = await nextSessionNumber();

  try {
    const session = await TableSession.create({
      tableId: table._id,
      tableCode: table.code,
      sessionNumber,
      status: SESSION_STATUS.OCCUPIED,
      isActive: true,
      openedAt: new Date(),
      openedBy: actorSnapshot(input.actor),
      source: input.source,
      guestCount: input.guestCount ?? 0,
    });

    await auditService.record({
      entityType: AUDIT_ENTITY.SESSION,
      entityId: session._id,
      action: AUDIT_ACTION.SESSION_OPENED,
      actor: input.actor,
      sessionId: session._id,
      tableCode: table.code,
      after: { sessionNumber, source: input.source },
      ip: input.ip ?? null,
    });

    broadcast(
      SOCKET_EVENTS.SESSION_OPENED,
      {
        sessionId: String(session._id),
        tableId: String(table._id),
        tableCode: table.code,
        sessionNumber,
        status: session.status,
        source: input.source,
      },
      { tableId: String(table._id), sessionId: String(session._id) },
    );

    return { session, created: true };
  } catch (error) {
    // Lost the race — someone else created the session microseconds earlier.
    if ((error as { code?: number }).code === 11000) {
      const winner = await findActiveByTable(input.tableId);
      if (winner) return { session: winner, created: false };
    }
    throw error;
  }
}

/** Convenience used by the QR flow: reuse the live session or start one. */
export async function ensureForTable(
  tableId: string,
  actor: Actor,
  source: OrderSource = ORDER_SOURCE.CUSTOMER_QR,
  ip?: string | null,
): Promise<TableSessionDocument> {
  const { session } = await open({ tableId, actor, source, ip });
  return session;
}

// ─── Recompute ───────────────────────────────────────────────────────────────

/**
 * Recomputes derived session state (status, running total, round count) from
 * its rounds and broadcasts the change if anything actually moved.
 *
 * Called after every round placement and item status change. Cheap enough at
 * one-café volume, and it means the session document can never drift from the
 * rounds it summarises.
 */
export async function recompute(
  sessionId: string | Types.ObjectId,
  options: { emit?: boolean } = {},
): Promise<TableSessionDocument | null> {
  const session = await TableSession.findById(sessionId);
  if (!session) return null;
  if (session.status === SESSION_STATUS.CLOSED) return session;

  const rounds = await OrderRound.find({ sessionId: session._id })
    .select('status items roundNumber')
    .lean();

  const previousStatus = session.status;
  const totals = totalsForItems(rounds.flatMap((round) => round.items));

  session.status = deriveSessionStatus(rounds, { billRequested: Boolean(session.billRequestedAt) });
  session.runningTotal = totals.total;
  session.totalRounds = rounds.length;
  await session.save();

  if (options.emit !== false && previousStatus !== session.status) {
    broadcast(
      SOCKET_EVENTS.SESSION_STATUS_CHANGE,
      {
        sessionId: String(session._id),
        tableId: String(session.tableId),
        tableCode: session.tableCode,
        status: session.status,
        previousStatus,
        runningTotal: session.runningTotal,
      },
      { tableId: String(session.tableId), sessionId: String(session._id) },
    );
  }

  return session;
}

/** Marks the session as having asked for the bill. Sticky until close. */
export async function markBillRequested(
  sessionId: string | Types.ObjectId,
  actor: Actor,
): Promise<TableSessionDocument> {
  const session = await TableSession.findById(sessionId);
  if (!session) throw ApiError.notFound('Session not found');
  if (session.status === SESSION_STATUS.CLOSED) {
    throw ApiError.invalidState('This session is already closed');
  }

  if (!session.billRequestedAt) {
    const previousStatus = session.status;
    session.billRequestedAt = new Date();
    session.status = SESSION_STATUS.BILL_REQUESTED;
    await session.save();

    await auditService.record({
      entityType: AUDIT_ENTITY.SESSION,
      entityId: session._id,
      action: AUDIT_ACTION.SESSION_STATUS_CHANGED,
      actor,
      sessionId: session._id,
      tableCode: session.tableCode,
      before: { status: previousStatus },
      after: { status: session.status },
    });

    broadcast(
      SOCKET_EVENTS.SESSION_STATUS_CHANGE,
      {
        sessionId: String(session._id),
        tableId: String(session.tableId),
        tableCode: session.tableCode,
        status: session.status,
        previousStatus,
        runningTotal: session.runningTotal,
      },
      { tableId: String(session.tableId), sessionId: String(session._id) },
    );
  }

  return session;
}

/** Item statuses that still represent work the kitchen believes it owes. */
const LIVE_ITEM_STATUSES = [
  ITEM_STATUS.PENDING,
  ITEM_STATUS.ACCEPTED,
  ITEM_STATUS.PREPARING,
  ITEM_STATUS.READY,
] as const;

/**
 * Writes off whatever the kitchen had not finished on a table being freed.
 *
 * Only ever runs on the free-without-billing path. When a bill was exported the
 * guest paid for those items, and rewriting them to "cancelled" would make the
 * history disagree with the invoice they hold; here nobody was charged, so
 * cancelled is the honest status -- and it is what stops the kitchen board
 * showing a ticket for a table that has already been cleared.
 *
 * Deliberately does NOT flag the session for review the way a mid-service
 * cancellation does. Freeing a table is already a deliberate decision with a
 * named actor and a reason on it; sending it straight back to a manager queue
 * would turn the escape hatch into another thing to chase.
 */
async function writeOffOutstandingItems(
  session: TableSessionDocument,
  actor: Actor,
): Promise<number> {
  const rounds = await OrderRound.find({
    sessionId: session._id,
    'items.status': { $in: LIVE_ITEM_STATUSES },
  });

  const live = new Set<string>(LIVE_ITEM_STATUSES);
  const cancelledBy = actorSnapshot(actor);
  const now = new Date();
  let cancelledCount = 0;

  for (const round of rounds) {
    const written: string[] = [];

    for (const item of round.items) {
      if (!live.has(item.status)) continue;

      // Recorded even though no manager review follows, because "we had already
      // cooked it" is the difference between tidying up and losing stock.
      item.cancelledAfterPrep = item.status === ITEM_STATUS.READY;
      item.status = ITEM_STATUS.CANCELLED;
      item.cancelledAt = now;
      item.cancelReason = 'Table freed without billing';
      item.cancelledBy = cancelledBy;
      written.push(`${item.quantity} x ${item.displayName}`);
    }

    if (written.length === 0) continue;
    cancelledCount += written.length;

    const totals = totalsForItems(round.items);
    round.subtotal = totals.subtotal;
    round.taxTotal = totals.taxTotal;
    round.total = totals.total;
    round.status = deriveRoundStatus(round.items);
    await round.save();

    await auditService.record({
      entityType: AUDIT_ENTITY.ROUND,
      entityId: round._id,
      action: AUDIT_ACTION.ROUND_ITEM_CANCELLED,
      actor,
      sessionId: session._id,
      tableCode: round.tableCode,
      after: { status: round.status },
      meta: {
        kotId: round.kotId,
        reason: 'Table freed without billing',
        items: written,
      },
    });

    // Takes the ticket off the kitchen board now, rather than at the cook's
    // next refresh.
    broadcast(
      SOCKET_EVENTS.ROUND_STATUS,
      {
        sessionId: String(session._id),
        tableId: String(session.tableId),
        tableCode: round.tableCode,
        roundId: String(round._id),
        kotId: round.kotId,
        status: round.status,
      },
      { tableId: String(session.tableId), sessionId: String(session._id) },
    );
  }

  return cancelledCount;
}

// ─── Close ───────────────────────────────────────────────────────────────────

export interface CloseSessionInput {
  sessionId: string;
  actor: Actor;
  billingExportId?: string;
  note?: string;
  /** Closes even when items are still un-served — requires an explicit tap. */
  force?: boolean;
  ip?: string | null;
}

/**
 * Closes a session and frees the table.
 *
 * The session document is *never* deleted: closing flips `status`/`isActive`
 * and stamps who did it. Every round, item, timestamp and cancellation stays
 * queryable forever, and the next customer at the same table gets a brand-new
 * session so nothing can carry over by accident.
 */
export async function close(input: CloseSessionInput): Promise<TableSessionDocument> {
  const session = await getByIdOrThrow(input.sessionId);

  if (session.status === SESSION_STATUS.CLOSED) {
    throw ApiError.invalidState('This session is already closed');
  }

  const heldRider = input.force
    ? null
    : await TableSession.findOne({ billMovedTo: session._id, isActive: true, heldForReview: true })
        .select('tableCode')
        .lean();
  if (heldRider) {
    throw ApiError.invalidState(
      `${heldRider.tableCode}, which is on this bill, is held for manager review. Resolve it, or close with force.`,
      { heldForReview: true, tableCode: heldRider.tableCode },
    );
  }

  if (session.heldForReview && !input.force) {
    throw ApiError.invalidState(
      'This session is held for manager review. Resolve the review, or close with force.',
      { heldForReview: true, reviewNote: session.reviewNote },
    );
  }

  if (!input.force) {
    // Every table on this bill, not just this one: closing M3 closes M4 too.
    const cooking = await OrderRound.find({
      sessionId: { $in: await billSessionIds(session._id) },
      'items.status': { $in: ['pending', 'accepted', 'preparing'] },
    })
      .select('tableCode')
      .lean();
    if (cooking.length > 0) {
      const tables = [...new Set(cooking.map((round) => round.tableCode))];
      const others = tables.filter((code) => code !== session.tableCode);
      throw ApiError.invalidState(
        others.length > 0
          ? `The kitchen has not finished items for ${tables.join(', ')} on this bill. Close with force to override.`
          : 'This table still has items the kitchen has not finished. Close with force to override.',
        { outstandingRounds: cooking.length, tableCodes: tables },
      );
    }
  }

  const previousStatus = session.status;
  session.status = SESSION_STATUS.CLOSED;
  session.isActive = false;
  session.closedAt = new Date();
  session.closedBy = actorSnapshot(input.actor);
  await session.save();

  // Freeing a table without billing it leaves behind whatever the kitchen had
  // not finished. Those items are written off explicitly: an item left "ready"
  // on a closed session is a job the kitchen can never complete and money the
  // bill never took. A *billed* close skips this -- see the helper.
  const writtenOff = input.billingExportId
    ? 0
    : await writeOffOutstandingItems(session, input.actor);

  // Any request still hanging on this table dies with the session, otherwise
  // the waiter dashboard keeps flashing for a table that has already left.
  await ServiceRequest.updateMany(
    { sessionId: session._id, status: { $in: ACTIVE_SERVICE_REQUEST_STATUSES } },
    {
      $set: {
        status: SERVICE_REQUEST_STATUS.RESOLVED,
        resolvedAt: new Date(),
        resolvedBy: input.actor.userId,
        note: 'Auto-resolved on session close',
      },
    },
  );

  await auditService.record({
    entityType: AUDIT_ENTITY.SESSION,
    entityId: session._id,
    action: AUDIT_ACTION.SESSION_CLOSED,
    actor: input.actor,
    sessionId: session._id,
    tableCode: session.tableCode,
    before: { status: previousStatus, runningTotal: session.runningTotal },
    after: { status: session.status, closedAt: session.closedAt },
    meta: {
      billingExportId: input.billingExportId ?? null,
      forced: Boolean(input.force),
      itemsWrittenOff: writtenOff,
      note: input.note ?? '',
    },
    ip: input.ip ?? null,
  });

  broadcast(
    SOCKET_EVENTS.SESSION_CLOSED,
    {
      sessionId: String(session._id),
      tableId: String(session.tableId),
      tableCode: session.tableCode,
      closedAt: session.closedAt,
      total: session.runningTotal,
    },
    { tableId: String(session.tableId), sessionId: String(session._id) },
  );

  logger.info(`Session ${session.sessionNumber} closed on ${session.tableCode}`, {
    total: session.runningTotal,
    by: input.actor.name,
  });

  await settleRiders(session, input);

  return session;
}

// ─── Moving a bill to another table ─────────────────────────────────────────

/**
 * Two tables, one bill: "M4 and M3 are one party, put it all on M3's bill."
 *
 * Nothing moves. M4 keeps its session, its rounds keep their numbers and their
 * table code — so the kitchen still cooks and runs M4's food to M4 — and M4's
 * session just points at the session that will pay (`billMovedTo`). The bill
 * for M3 then reads every round of M3 *and* of each session pointing at it,
 * and merges them line by line the way it always has: the paper is an ordinary
 * M3 bill with no trace of the move. The KDS splits, billing merges — this is
 * that rule across two tables instead of two rounds.
 *
 * Pointers are kept flat: every session points straight at the paying one,
 * never at another moved session, so moving M3's bill on to M2 later takes M4
 * with it in the same write.
 */

/** The paying session plus every session whose bill was moved onto it. */
export async function billSessionIds(payingSessionId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const moved = await TableSession.find({ billMovedTo: payingSessionId }).select('_id').lean();
  return [payingSessionId, ...moved.map((session) => session._id)];
}

async function assertNotBilled(session: TableSessionDocument, what: string): Promise<void> {
  if (await BillingExport.exists({ sessionId: session._id })) {
    throw ApiError.invalidState(
      `${what} — ${session.tableCode}'s bill has already been generated.`,
    );
  }
}

/** Both affected tables repaint: tiles, billing queue, the table screens. */
function announceBillMove(
  from: TableSessionDocument,
  to: { tableId: Types.ObjectId; tableCode: string },
) {
  for (const table of [
    { tableId: from.tableId, tableCode: from.tableCode },
    { tableId: to.tableId, tableCode: to.tableCode },
  ]) {
    broadcast(
      SOCKET_EVENTS.TABLE_STATUS,
      { tableId: String(table.tableId), tableCode: table.tableCode, billMoved: true },
      { tableId: String(table.tableId) },
    );
  }
  broadcast(
    SOCKET_EVENTS.SESSION_STATUS_CHANGE,
    {
      sessionId: String(from._id),
      tableId: String(from.tableId),
      tableCode: from.tableCode,
      status: from.status,
    },
    { tableId: String(from.tableId), sessionId: String(from._id) },
  );
}

export async function moveBill(input: {
  sessionId: string;
  toTableId: string;
  actor: Actor;
  reason?: string;
  ip?: string | null;
}): Promise<{ session: TableSessionDocument; payingTableCode: string }> {
  const session = await getByIdOrThrow(input.sessionId);
  if (session.status === SESSION_STATUS.CLOSED) {
    throw ApiError.invalidState('This table is already closed');
  }
  if (String(session.tableId) === input.toTableId) {
    throw ApiError.badRequest('Pick a different table');
  }

  const targetTable = await TableMaster.findById(input.toTableId).select('code isActive').lean();
  if (!targetTable?.isActive) {
    throw ApiError.invalidState('That table is not in service');
  }

  const targetSession = await findActiveByTable(targetTable._id);
  if (!targetSession) {
    throw ApiError.invalidState(
      `${targetTable.code} has no open order. A bill can only be moved to a table that has one.`,
    );
  }

  // Follow the target's own pointer, so the move lands on whoever actually pays.
  const paying = targetSession.billMovedTo
    ? await TableSession.findById(targetSession.billMovedTo)
    : targetSession;
  if (!paying || paying.status === SESSION_STATUS.CLOSED) {
    throw ApiError.invalidState(`${targetTable.code}'s bill is no longer open`);
  }
  if (paying._id.equals(session._id)) {
    throw ApiError.badRequest(`${targetTable.code}'s bill is already on ${session.tableCode}`);
  }

  // Already on that bill: a repeated tap or a retried request. Nothing to do,
  // and no second audit row for a move that did not happen.
  if (session.billMovedTo?.equals(paying._id)) {
    return { session, payingTableCode: paying.tableCode };
  }

  await assertNotBilled(session, 'Cannot move this bill');
  if (session.billMovedTo) {
    // Already on someone's bill: if that bill is printed, these orders are on it.
    const current = await TableSession.findById(session.billMovedTo);
    if (current) await assertNotBilled(current, 'Cannot move this bill');
  }
  await assertNotBilled(paying, `Cannot add to ${paying.tableCode}`);

  const previous = session.billMovedTo;
  session.billMovedTo = paying._id;
  session.billMovedAt = new Date();
  session.billMovedBy = actorSnapshot(input.actor);
  await session.save();

  // Anything already riding on this table's bill comes along, pointing
  // straight at the new payer so the chain never gets longer than one hop.
  const riders = await TableSession.find({ billMovedTo: session._id }).select('tableCode').lean();
  if (riders.length > 0) {
    await TableSession.updateMany(
      { billMovedTo: session._id },
      { $set: { billMovedTo: paying._id } },
    );
  }

  await auditService.record({
    entityType: AUDIT_ENTITY.SESSION,
    entityId: session._id,
    action: AUDIT_ACTION.SESSION_BILL_MOVED,
    actor: input.actor,
    sessionId: session._id,
    tableCode: session.tableCode,
    before: { billMovedTo: previous ? String(previous) : null },
    after: { billMovedTo: String(paying._id), toTableCode: paying.tableCode },
    meta: {
      fromTableCode: session.tableCode,
      toTableCode: paying.tableCode,
      toSessionId: String(paying._id),
      alsoMoved: riders.map((rider) => rider.tableCode),
      reason: input.reason ?? '',
    },
    ip: input.ip ?? null,
  });

  announceBillMove(session, paying);
  logger.info(`Bill for ${session.tableCode} moved to ${paying.tableCode} by ${input.actor.name}`);

  return { session, payingTableCode: paying.tableCode };
}

/**
 * Gives a table its own bill back. Allowed until the paying table's bill is
 * generated; after that the money is on paper and the move is history.
 */
export async function undoBillMove(input: {
  sessionId: string;
  actor: Actor;
  reason?: string;
  auto?: boolean;
  ip?: string | null;
}): Promise<TableSessionDocument> {
  const session = await getByIdOrThrow(input.sessionId);
  if (!session.billMovedTo) throw ApiError.invalidState('This table has its own bill');
  // Its orders can only still be paid on the bill it rides on: a closed table
  // can never be billed again, so taking it off would lose the money.
  if (session.status === SESSION_STATUS.CLOSED && !input.auto) {
    throw ApiError.invalidState(
      `${session.tableCode} is already closed; its orders stay on the bill they were moved to.`,
    );
  }

  const paying = await TableSession.findById(session.billMovedTo);
  if (paying && !input.auto) await assertNotBilled(paying, 'Too late to undo');

  session.billMovedTo = null;
  session.billMovedAt = null;
  session.billMovedBy = null;
  await session.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.SESSION,
    entityId: session._id,
    action: AUDIT_ACTION.SESSION_BILL_MOVE_UNDONE,
    actor: input.actor,
    sessionId: session._id,
    tableCode: session.tableCode,
    before: {
      billMovedTo: paying ? String(paying._id) : null,
      toTableCode: paying?.tableCode ?? '',
    },
    after: { billMovedTo: null },
    meta: {
      fromTableCode: session.tableCode,
      toTableCode: paying?.tableCode ?? '',
      reason: input.reason ?? '',
      automatic: Boolean(input.auto),
    },
    ip: input.ip ?? null,
  });

  if (paying) announceBillMove(session, paying);
  return session;
}

/**
 * What happens to the tables riding on a bill when the paying table closes.
 *
 * Billed: they were paid for on that bill, so they close with it — as a billed
 * close, so nothing still cooking for them is written off.
 * Freed without a bill (the floor's escape hatch): nobody paid, so each one
 * gets its own bill back and stays open, rather than its guests' orders
 * vanishing with somebody else's table.
 */
async function settleRiders(paying: TableSessionDocument, input: CloseSessionInput): Promise<void> {
  const riders = await TableSession.find({ billMovedTo: paying._id, isActive: true });

  for (const rider of riders) {
    if (input.billingExportId) {
      await close({
        sessionId: String(rider._id),
        actor: input.actor,
        billingExportId: input.billingExportId,
        note: `Billed with ${paying.tableCode}`,
        force: true,
        ip: input.ip ?? null,
      });
    } else {
      await undoBillMove({
        sessionId: String(rider._id),
        actor: input.actor,
        reason: `${paying.tableCode} was freed without a bill`,
        auto: true,
        ip: input.ip ?? null,
      });
    }
  }
}

// ─── Transfer ────────────────────────────────────────────────────────────────

/**
 * Moves a running session to a different table.
 *
 * A waiter opening the wrong table is not an edge case, it is a Tuesday. This
 * rewrites the denormalised `tableId`/`tableCode` on the session's rounds and
 * open requests too, so the KDS ticket a cook is looking at renames itself.
 */
export async function transfer(input: {
  sessionId: string;
  toTableId: string;
  actor: Actor;
  reason: string;
  ip?: string | null;
}): Promise<TableSessionDocument> {
  const session = await getByIdOrThrow(input.sessionId);
  if (session.status === SESSION_STATUS.CLOSED) {
    throw ApiError.invalidState('Cannot transfer a closed session');
  }

  if (String(session.tableId) === input.toTableId) {
    throw ApiError.badRequest('The session is already on that table');
  }

  const target = await TableMaster.findById(input.toTableId).select('code isActive').lean();
  if (!target) throw ApiError.notFound('Destination table not found');
  if (!target.isActive) throw ApiError.invalidState('Destination table is not in service');

  const occupied = await findActiveByTable(target._id);
  if (occupied) {
    throw ApiError.conflict(`${target.code} already has an open session. Close or move it first.`, {
      blockingSessionId: String(occupied._id),
    });
  }

  const fromTableId = session.tableId;
  const fromTableCode = session.tableCode;

  session.transferHistory.push({
    fromTableId,
    toTableId: target._id,
    at: new Date(),
    byUserId: input.actor.userId,
    reason: input.reason,
  });
  session.tableId = target._id;
  session.tableCode = target.code;
  await session.save();

  await Promise.all([
    OrderRound.updateMany(
      { sessionId: session._id },
      { $set: { tableId: target._id, tableCode: target.code } },
    ),
    ServiceRequest.updateMany(
      { sessionId: session._id, status: { $in: ACTIVE_SERVICE_REQUEST_STATUSES } },
      { $set: { tableId: target._id, tableCode: target.code } },
    ),
  ]);

  await auditService.record({
    entityType: AUDIT_ENTITY.SESSION,
    entityId: session._id,
    action: AUDIT_ACTION.SESSION_TRANSFERRED,
    actor: input.actor,
    sessionId: session._id,
    tableCode: target.code,
    before: { tableId: String(fromTableId), tableCode: fromTableCode },
    after: { tableId: String(target._id), tableCode: target.code },
    meta: { reason: input.reason },
    ip: input.ip ?? null,
  });

  // Both the old and the new table screens need to repaint.
  broadcast(
    SOCKET_EVENTS.SESSION_STATUS_CHANGE,
    {
      sessionId: String(session._id),
      tableId: String(target._id),
      tableCode: target.code,
      status: session.status,
      transferredFrom: fromTableCode,
    },
    { tableId: String(target._id), sessionId: String(session._id) },
  );
  broadcast(
    SOCKET_EVENTS.TABLE_STATUS,
    { tableId: String(fromTableId), tableCode: fromTableCode, status: 'empty' },
    { tableId: String(fromTableId) },
  );

  return session;
}

// ─── Review hold ─────────────────────────────────────────────────────────────

/**
 * Flags a session for manager review instead of silently auto-resolving a
 * discrepancy (e.g. an item cancelled after it was already served).
 */
export async function setReviewHold(input: {
  sessionId: string;
  heldForReview: boolean;
  note?: string;
  actor: Actor;
}): Promise<TableSessionDocument> {
  const session = await getByIdOrThrow(input.sessionId);
  const before = { heldForReview: session.heldForReview, reviewNote: session.reviewNote };

  session.heldForReview = input.heldForReview;
  session.reviewNote = input.heldForReview ? (input.note ?? session.reviewNote) : '';
  await session.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.SESSION,
    entityId: session._id,
    action: AUDIT_ACTION.SESSION_HELD_FOR_REVIEW,
    actor: input.actor,
    sessionId: session._id,
    tableCode: session.tableCode,
    before,
    after: { heldForReview: session.heldForReview, reviewNote: session.reviewNote },
  });

  return session;
}

/** Raises the review flag from inside another flow (no HTTP request behind it). */
export async function flagForReview(
  sessionId: string | Types.ObjectId,
  note: string,
  actor: Actor,
): Promise<void> {
  await TableSession.updateOne(
    { _id: sessionId },
    { $set: { heldForReview: true, reviewNote: note } },
  );
  await auditService.record({
    entityType: AUDIT_ENTITY.SESSION,
    entityId: sessionId,
    action: AUDIT_ACTION.SESSION_HELD_FOR_REVIEW,
    actor,
    sessionId,
    after: { heldForReview: true, reviewNote: note },
  });
}
