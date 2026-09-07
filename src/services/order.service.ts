import { Types } from 'mongoose';

import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  CUSTOMER_ACTOR,
  ITEM_STATUS,
  ITEM_STATUS_TRANSITIONS,
  KITCHEN_SETTABLE_STATUSES,
  ORDER_TYPE,
  ROLES,
  ROUND_STATUS,
  SESSION_STATUS,
  SOCKET_EVENTS,
  type ItemStatus,
  type KitchenStation,
  type OrderSource,
  type OrderType,
} from '../config/constants.js';
import { env } from '../config/env.js';
import {
  OrderRound,
  ProductMaster,
  TableSession,
  type IOrderItem,
  type OrderRoundDocument,
} from '../models/index.js';
import type { KdsTicket, OrderItemInput } from '../types/common.js';
import { ApiError } from '../utils/ApiError.js';
import { generateIdempotencyKey, minutesSince, round2 } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { actorSnapshot, type Actor } from '../utils/actor.js';
import { broadcast } from '../sockets/emitter.js';
import * as auditService from './audit.service.js';
import * as sessionService from './session.service.js';
import { nextKotId } from './counter.service.js';
import { deriveRoundStatus, totalsForItems } from './statusDerivation.js';

/**
 * Order rounds — the append-only heart of the system.
 *
 * Each "Place Order" tap creates one round. Rounds are never edited into each
 * other: round 2 is an add-on card on the KDS, and only the billing screen
 * merges rounds back together by productCode.
 */

// ─── Place ───────────────────────────────────────────────────────────────────

export interface PlaceRoundInput {
  sessionId: string;
  items: OrderItemInput[];
  actor: Actor;
  source: OrderSource;
  /**
   * Omitted means dining. The public (QR) controller never passes it, which is
   * what makes "a guest cannot mark their own order a parcel" a server-side
   * fact rather than a hidden button on the phone.
   */
  orderType?: OrderType;
  idempotencyKey?: string;
  ip?: string | null;
}

/**
 * Resolves cart lines against ProductMaster and snapshots price/tax/posName.
 *
 * Prices come from the server, never from the request: a tampered client must
 * not be able to order a 500 rupee item for 5. The snapshot is also what makes
 * a later menu price change leave historic rounds alone.
 */
async function buildItems(input: OrderItemInput[]): Promise<IOrderItem[]> {
  const codes = Array.from(new Set(input.map((item) => item.productCode.trim().toUpperCase())));

  const products = await ProductMaster.find({ productCode: { $in: codes } }).lean();
  const byCode = new Map(products.map((product) => [product.productCode, product]));

  const unknown: string[] = [];
  const retired: string[] = [];
  const unavailable: string[] = [];

  for (const code of codes) {
    const product = byCode.get(code);
    if (!product) unknown.push(code);
    else if (!product.isActive) retired.push(code);
    else if (!product.isAvailable) unavailable.push(product.displayName);
  }

  if (unknown.length > 0 || retired.length > 0) {
    throw ApiError.badRequest('Some items are not on the menu', {
      unknownCodes: unknown,
      retiredCodes: retired,
    });
  }

  // 86'd mid-order: reject the whole round and name the items, so the customer
  // sees "Cold Coffee is finished" rather than a silently shorter bill.
  if (unavailable.length > 0) {
    throw ApiError.invalidState(
      `Not available right now: ${unavailable.join(', ')}. Please remove and try again.`,
      { unavailable },
    );
  }

  // Merge duplicate lines of the same product *with the same instructions* —
  // two separate "1 Tea" taps become "2 Tea", but "1 Tea, no sugar" stays apart.
  const merged = new Map<string, IOrderItem>();

  for (const line of input) {
    const code = line.productCode.trim().toUpperCase();
    const product = byCode.get(code);
    if (!product) continue;

    const instructions = (line.specialInstructions ?? '').trim();
    const key = `${code}::${instructions.toLowerCase()}`;
    const existing = merged.get(key);

    if (existing) {
      existing.quantity += line.quantity;
      continue;
    }

    merged.set(key, {
      _id: new Types.ObjectId(),
      productId: product._id,
      productCode: product.productCode,
      posName: product.posName,
      displayName: product.displayName,
      quantity: line.quantity,
      unitPrice: product.price,
      taxPercent: product.taxPercent ?? env.defaultTaxPercent,
      specialInstructions: instructions,
      kitchenStation: product.kitchenStation,
      status: ITEM_STATUS.PENDING,
      acceptedAt: null,
      preparingAt: null,
      readyAt: null,
      servedAt: null,
      cancelledAt: null,
      cancelReason: '',
      cancelledBy: null,
      cancelledAfterPrep: false,
    });
  }

  return Array.from(merged.values());
}

/**
 * Places a round on a session.
 *
 * Idempotent by `idempotencyKey`: a double-tapped "Place Order", or a retry
 * after the phone lost Wi-Fi mid-POST, returns the round that already exists
 * instead of sending the kitchen a second ticket.
 */
export async function placeRound(
  input: PlaceRoundInput,
): Promise<{ round: OrderRoundDocument; created: boolean }> {
  // An empty-string key must fall back to a generated one, not be used as-is.
  const suppliedKey = input.idempotencyKey?.trim();
  const idempotencyKey =
    suppliedKey && suppliedKey.length > 0 ? suppliedKey : generateIdempotencyKey();

  const session = await sessionService.getByIdOrThrow(input.sessionId);

  // Replay check is scoped to this session — see the index comment on the
  // model for why a global key would let one table read another's round.
  const alreadyPlaced = await OrderRound.findOne({ sessionId: session._id, idempotencyKey });
  if (alreadyPlaced) return { round: alreadyPlaced, created: false };

  if (session.status === SESSION_STATUS.CLOSED) {
    throw ApiError.invalidState('This table has been billed and closed. Please start a new order.');
  }

  // A customer must not slip an order into a bill that is being settled.
  // Staff may still add for them — they can see the counter and the table.
  if (session.billRequestedAt && input.actor.role === CUSTOMER_ACTOR) {
    throw ApiError.invalidState(
      'The bill has been requested for this table. Please ask a staff member to add items.',
      { billRequestedAt: session.billRequestedAt },
    );
  }

  const items = await buildItems(input.items);
  if (items.length === 0) throw ApiError.badRequest('An order must contain at least one item');

  const totals = totalsForItems(items);

  // Atomic $inc so two simultaneous "Place Order" taps get 2 and 3, not 2 twice.
  const counted = await TableSession.findByIdAndUpdate(
    session._id,
    { $inc: { totalRounds: 1 } },
    { new: true, projection: { totalRounds: 1 } },
  ).lean();
  const roundNumber = counted?.totalRounds ?? 1;

  const kotId = await nextKotId();

  let round: OrderRoundDocument;
  try {
    round = await OrderRound.create({
      sessionId: session._id,
      tableId: session.tableId,
      tableCode: session.tableCode,
      roundNumber,
      kotId,
      source: input.source,
      orderType: input.orderType ?? ORDER_TYPE.DINING,
      placedBy: actorSnapshot(input.actor),
      items,
      status: ROUND_STATUS.PENDING,
      placedAt: new Date(),
      idempotencyKey,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
    });
  } catch (error) {
    // Two identical submissions raced past the read above.
    if ((error as { code?: number }).code === 11000) {
      const winner = await OrderRound.findOne({ sessionId: session._id, idempotencyKey });
      if (winner) {
        await TableSession.findByIdAndUpdate(session._id, { $inc: { totalRounds: -1 } });
        return { round: winner, created: false };
      }
    }
    throw error;
  }

  await sessionService.recompute(session._id);

  await auditService.record({
    entityType: AUDIT_ENTITY.ROUND,
    entityId: round._id,
    action: AUDIT_ACTION.ROUND_PLACED,
    actor: input.actor,
    sessionId: session._id,
    tableCode: session.tableCode,
    after: {
      roundNumber,
      kotId,
      orderType: input.orderType ?? ORDER_TYPE.DINING,
      total: totals.total,
      items: items.map((item) => ({
        productCode: item.productCode,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    },
    meta: { source: input.source, idempotencyKey },
    ip: input.ip ?? null,
  });

  broadcast(
    SOCKET_EVENTS.ROUND_NEW,
    {
      sessionId: String(session._id),
      tableId: String(session.tableId),
      tableCode: session.tableCode,
      round: toKdsTicket(round),
    },
    { tableId: String(session.tableId), sessionId: String(session._id) },
  );

  logger.info(`KOT ${kotId} placed on ${session.tableCode} (round ${roundNumber})`, {
    source: input.source,
    orderType: input.orderType ?? ORDER_TYPE.DINING,
    itemCount: items.length,
    total: totals.total,
  });

  return { round, created: true };
}

// ─── Status changes ──────────────────────────────────────────────────────────

export async function getRoundOrThrow(roundId: string): Promise<OrderRoundDocument> {
  const round = await OrderRound.findById(roundId);
  if (!round) throw ApiError.notFound('Order round not found');
  return round;
}

/** Stamps the timestamp that matches the new status. */
function stampTransition(item: IOrderItem, status: ItemStatus, actor: Actor, reason: string): void {
  const now = new Date();
  switch (status) {
    case ITEM_STATUS.ACCEPTED:
      item.acceptedAt = item.acceptedAt ?? now;
      break;
    case ITEM_STATUS.PREPARING:
      item.preparingAt = item.preparingAt ?? now;
      break;
    case ITEM_STATUS.READY:
      item.readyAt = now;
      break;
    case ITEM_STATUS.SERVED:
      item.servedAt = now;
      break;
    case ITEM_STATUS.CANCELLED:
      item.cancelledAt = now;
      item.cancelReason = reason;
      item.cancelledBy = actorSnapshot(actor);
      // Cancelled after the kitchen had already cooked/served it — this is the
      // case that costs money and needs a manager, not a silent write-off.
      item.cancelledAfterPrep =
        item.status === ITEM_STATUS.READY || item.status === ITEM_STATUS.SERVED;
      break;
    default:
      break;
  }
  item.status = status;
}

export interface UpdateItemStatusInput {
  roundId: string;
  itemId: string;
  status: ItemStatus;
  reason?: string;
  actor: Actor;
  ip?: string | null;
}

/**
 * Moves a single item forward (or back, or to cancelled).
 *
 * Item-level rather than ticket-level, because a kitchen genuinely finishes
 * 2 teas before the sandwich and the waiter should be told about the teas now.
 */
export async function updateItemStatus(
  input: UpdateItemStatusInput,
): Promise<{ round: OrderRoundDocument; item: IOrderItem }> {
  const round = await getRoundOrThrow(input.roundId);
  const item = round.items.id(input.itemId);
  if (!item) throw ApiError.notFound('Item not found on this order');

  const previousStatus = item.status;
  const previousRoundStatus = round.status;

  if (previousStatus === input.status) {
    // Idempotent: a double-tap on the KDS is not an error.
    return { round, item };
  }

  const allowed = ITEM_STATUS_TRANSITIONS[previousStatus] ?? [];
  if (!allowed.includes(input.status)) {
    throw ApiError.invalidState(
      `Cannot move an item from "${previousStatus}" to "${input.status}"`,
      { allowed },
    );
  }

  // Kitchen may drive preparation, but only staff with wider rights may cancel
  // or mark served — those are floor/billing decisions, not cook decisions.
  if (input.actor.role === ROLES.KITCHEN && !KITCHEN_SETTABLE_STATUSES.includes(input.status)) {
    throw ApiError.forbidden('Kitchen can set accepted, preparing or ready only');
  }

  stampTransition(item, input.status, input.actor, input.reason ?? '');

  // Money is recomputed here because a cancellation removes a line from the bill.
  const totals = totalsForItems(round.items);
  round.subtotal = totals.subtotal;
  round.taxTotal = totals.taxTotal;
  round.total = totals.total;
  round.status = deriveRoundStatus(round.items);

  if (round.status === ROUND_STATUS.READY && !round.readyAt) round.readyAt = new Date();
  if (round.status === ROUND_STATUS.SERVED && !round.servedAt) round.servedAt = new Date();

  await round.save();

  const isCancellation = input.status === ITEM_STATUS.CANCELLED;

  await auditService.record({
    entityType: AUDIT_ENTITY.ROUND,
    entityId: round._id,
    action: isCancellation
      ? AUDIT_ACTION.ROUND_ITEM_CANCELLED
      : AUDIT_ACTION.ROUND_ITEM_STATUS_CHANGED,
    actor: input.actor,
    sessionId: round.sessionId,
    tableCode: round.tableCode,
    before: { status: previousStatus },
    after: { status: item.status },
    meta: {
      itemId: String(item._id),
      productCode: item.productCode,
      quantity: item.quantity,
      kotId: round.kotId,
      reason: input.reason ?? '',
      cancelledAfterPrep: item.cancelledAfterPrep,
    },
    ip: input.ip ?? null,
  });

  // Discrepancy between what the kitchen served and what gets billed: hold the
  // session rather than resolving it silently in either direction.
  if (isCancellation && item.cancelledAfterPrep) {
    await sessionService.flagForReview(
      round.sessionId,
      `${item.quantity} x ${item.displayName} cancelled after it was ${previousStatus} (KOT ${round.kotId}). Reason: ${input.reason ?? 'not given'}`,
      input.actor,
    );
  }

  broadcast(
    SOCKET_EVENTS.ROUND_ITEM_STATUS,
    {
      sessionId: String(round.sessionId),
      tableId: String(round.tableId),
      tableCode: round.tableCode,
      roundId: String(round._id),
      roundNumber: round.roundNumber,
      kotId: round.kotId,
      itemId: String(item._id),
      productCode: item.productCode,
      displayName: item.displayName,
      quantity: item.quantity,
      status: item.status,
      previousStatus,
    },
    { tableId: String(round.tableId), sessionId: String(round.sessionId) },
  );

  if (round.status !== previousRoundStatus) {
    broadcast(
      SOCKET_EVENTS.ROUND_STATUS,
      {
        sessionId: String(round.sessionId),
        tableId: String(round.tableId),
        tableCode: round.tableCode,
        roundId: String(round._id),
        roundNumber: round.roundNumber,
        kotId: round.kotId,
        status: round.status,
        previousStatus: previousRoundStatus,
      },
      { tableId: String(round.tableId), sessionId: String(round.sessionId) },
    );
  }

  await sessionService.recompute(round.sessionId);

  return { round, item };
}

/** Applies one status to every live item on a ticket — the "all ready" button. */
export async function updateRoundStatus(input: {
  roundId: string;
  status: ItemStatus;
  reason?: string;
  actor: Actor;
  ip?: string | null;
}): Promise<OrderRoundDocument> {
  const round = await getRoundOrThrow(input.roundId);

  const targets = round.items
    .filter(
      (item) =>
        item.status !== ITEM_STATUS.CANCELLED &&
        item.status !== input.status &&
        (ITEM_STATUS_TRANSITIONS[item.status] ?? []).includes(input.status),
    )
    .map((item) => String(item._id));

  if (targets.length === 0) {
    throw ApiError.invalidState(`No items on KOT ${round.kotId} can move to "${input.status}"`);
  }

  let latest = round;
  for (const itemId of targets) {
    const result = await updateItemStatus({
      roundId: input.roundId,
      itemId,
      status: input.status,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      actor: input.actor,
      ip: input.ip ?? null,
    });
    latest = result.round;
  }

  return latest;
}

// ─── Kitchen display ─────────────────────────────────────────────────────────

/** Maps a round document to the KDS card shape. */
export function toKdsTicket(
  round: OrderRoundDocument | (Omit<OrderRoundDocument, never> & Record<string, unknown>),
  unavailableCodes = new Set<string>(),
): KdsTicket {
  const doc = round as unknown as {
    _id: Types.ObjectId;
    sessionId: Types.ObjectId;
    tableId: Types.ObjectId;
    tableCode: string;
    kotId: string;
    roundNumber: number;
    source: string;
    orderType?: OrderType;
    placedBy?: { name?: string };
    placedAt: Date;
    status: string;
    items: IOrderItem[];
    zone?: string;
  };

  const totals = totalsForItems(doc.items);

  return {
    roundId: String(doc._id),
    sessionId: String(doc.sessionId),
    tableId: String(doc.tableId),
    tableCode: doc.tableCode,
    zone: doc.zone ?? '',
    kotId: doc.kotId,
    roundNumber: doc.roundNumber,
    isAddOn: doc.roundNumber > 1,
    source: doc.source,
    // Coalesced rather than trusted: the KDS reads through `.lean()`, which
    // does not apply the schema default, and rounds placed before this field
    // existed have no value stored at all.
    orderType: doc.orderType ?? ORDER_TYPE.DINING,
    placedByName: doc.placedBy?.name ?? '',
    placedAt: doc.placedAt,
    elapsedMinutes: minutesSince(doc.placedAt),
    status: doc.status,
    // Recomputed from the live items rather than read off the stored round
    // totals: cancelling an item must take its money off the card at the same
    // moment it takes the line off it.
    subtotal: totals.subtotal,
    tax: totals.taxTotal,
    total: totals.total,
    items: doc.items.map((item) => ({
      itemId: String(item._id),
      productCode: item.productCode,
      displayName: item.displayName,
      quantity: item.quantity,
      specialInstructions: item.specialInstructions,
      kitchenStation: item.kitchenStation,
      status: item.status,
      // Flags an item the kitchen 86'd *after* it was ordered, so the cook can
      // raise it with the floor instead of the line vanishing silently.
      unavailable: unavailableCodes.has(item.productCode),
      unitPrice: item.unitPrice,
      lineTotal: round2(item.unitPrice * item.quantity),
    })),
  };
}

/**
 * Drops rounds belonging to a table session that has already been closed.
 *
 * A round keeps its own status, and closing a session does not rewrite it. The
 * close guard only blocks items that are pending/accepted/preparing, so a table
 * settled while five limes sat *ready* under the pass closes cleanly and leaves
 * those items ready forever -- a ghost ticket the kitchen cannot clear, sitting
 * on a table the floor screen already shows as free.
 *
 * Filtered here rather than by back-filling item statuses: the item genuinely
 * was ready, and on a billed close the guest genuinely paid for it, so
 * rewriting history to tidy the board would be a lie. This also clears the
 * ghosts already sitting in the database, with no migration.
 */
async function dropClosedSessions<T extends { sessionId: Types.ObjectId }>(
  rounds: T[],
): Promise<T[]> {
  if (rounds.length === 0) return rounds;

  const sessionIds = [...new Set(rounds.map((round) => String(round.sessionId)))];
  const closed = await TableSession.find({ _id: { $in: sessionIds }, isActive: false })
    .select('_id')
    .lean();

  if (closed.length === 0) return rounds;

  const closedIds = new Set(closed.map((session) => String(session._id)));
  return rounds.filter((round) => !closedIds.has(String(round.sessionId)));
}

export interface KitchenQueueOptions {
  station?: KitchenStation;
  includeServed?: boolean;
  sinceMinutes?: number;
}

/**
 * The full live KDS queue.
 *
 * Deliberately a REST read, not a socket replay: a tablet that dropped off the
 * Wi-Fi re-fetches this on reconnect and is instantly correct, rather than
 * trusting that it caught every event while it was away.
 */
export async function getKitchenQueue(options: KitchenQueueOptions = {}): Promise<KdsTicket[]> {
  const liveStatuses = [
    ROUND_STATUS.PENDING,
    ROUND_STATUS.ACCEPTED,
    ROUND_STATUS.PREPARING,
    ROUND_STATUS.READY,
  ];

  const query: Record<string, unknown> = {
    status: options.includeServed ? { $ne: ROUND_STATUS.CANCELLED } : { $in: liveStatuses },
  };

  if (options.sinceMinutes) {
    query.placedAt = { $gte: new Date(Date.now() - options.sinceMinutes * 60_000) };
  }

  const rounds = await dropClosedSessions(
    await OrderRound.find(query).sort({ placedAt: 1 }).lean(),
  );

  // Items 86'd since the order was placed get flagged on the ticket.
  const unavailable = await ProductMaster.find({ isAvailable: false }).select('productCode').lean();
  const unavailableCodes = new Set(unavailable.map((product) => product.productCode));

  const tickets = rounds.map((round) =>
    toKdsTicket(round as unknown as OrderRoundDocument, unavailableCodes),
  );

  if (!options.station) return tickets;

  // Station filter is a view concern, not a data one — Phase 3 splits the
  // screen without touching a single stored document.
  return tickets
    .map((ticket) => ({
      ...ticket,
      items: ticket.items.filter((item) => item.kitchenStation === options.station),
    }))
    .filter((ticket) => ticket.items.length > 0);
}

/** Rounds that have been sitting "ready" too long — the waiter nudge. */
export async function getUnservedReadyRounds(thresholdMinutes = env.readyOrderEscalationMinutes) {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
  // Same ghost, different screen: without this a freed table nags the floor to
  // go and serve an order that no longer has anybody sitting in front of it.
  const rounds = await dropClosedSessions(
    await OrderRound.find({
      status: ROUND_STATUS.READY,
      readyAt: { $lte: cutoff },
    })
      .sort({ readyAt: 1 })
      .lean(),
  );

  return rounds.map((round) => ({
    roundId: String(round._id),
    sessionId: String(round.sessionId),
    tableId: String(round.tableId),
    tableCode: round.tableCode,
    kotId: round.kotId,
    roundNumber: round.roundNumber,
    readyAt: round.readyAt,
    waitingMinutes: minutesSince(round.readyAt),
    items: round.items
      .filter((item) => item.status === ITEM_STATUS.READY)
      .map((item) => ({ displayName: item.displayName, quantity: item.quantity })),
  }));
}

/** All rounds of a session, oldest first — used by billing drill-down. */
export async function getRoundsForSession(sessionId: string | Types.ObjectId) {
  return OrderRound.find({ sessionId }).sort({ roundNumber: 1 }).lean();
}

/** Live money total for a session, computed from its rounds. */
export async function getSessionTotals(sessionId: string | Types.ObjectId) {
  const rounds = await OrderRound.find({ sessionId }).select('items').lean();
  const totals = totalsForItems(rounds.flatMap((round) => round.items));
  return { ...totals, roundCount: rounds.length, grandTotal: round2(totals.total) };
}
