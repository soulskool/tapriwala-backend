import {
  ITEM_STATUS,
  ITEM_STATUS_RANK,
  ROUND_STATUS,
  SESSION_STATUS,
  type ItemStatus,
  type RoundStatus,
  type SessionStatus,
} from '../config/constants.js';
import { round2 } from '../utils/helpers.js';

/**
 * Status is never stored twice as an independent fact — item statuses are the
 * truth, and round/session status are *derived* from them here. One place, so
 * the KDS, the live table grid and the customer screen can never disagree.
 */

interface ItemLike {
  status: ItemStatus;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
}

/**
 * A round is only as far along as its least-progressed live item: 2 teas ready
 * while a sandwich is still preparing means the round is "preparing".
 * Cancelled items are ignored; a round of only-cancelled items is cancelled.
 */
export function deriveRoundStatus(items: ItemLike[]): RoundStatus {
  const live = items.filter((item) => item.status !== ITEM_STATUS.CANCELLED);
  if (live.length === 0) return ROUND_STATUS.CANCELLED;

  const minRank = Math.min(
    ...live.map((item) => ITEM_STATUS_RANK[item.status as Exclude<ItemStatus, 'cancelled'>]),
  );

  switch (minRank) {
    case 0:
      return ROUND_STATUS.PENDING;
    case 1:
      return ROUND_STATUS.ACCEPTED;
    case 2:
      return ROUND_STATUS.PREPARING;
    case 3:
      return ROUND_STATUS.READY;
    default:
      return ROUND_STATUS.SERVED;
  }
}

interface RoundLike {
  status: RoundStatus;
  items: ItemLike[];
}

/**
 * Session status for the live table grid.
 *
 * `bill_requested` is sticky and outranks everything: once a table has asked
 * for the bill, staff must see that even if the kitchen is still finishing an
 * add-on. `closed` is set explicitly by billing, never derived.
 */
export function deriveSessionStatus(
  rounds: RoundLike[],
  options: { billRequested: boolean },
): SessionStatus {
  if (options.billRequested) return SESSION_STATUS.BILL_REQUESTED;

  const liveItems = rounds
    .flatMap((round) => round.items)
    .filter((item) => item.status !== ITEM_STATUS.CANCELLED);

  if (liveItems.length === 0) return SESSION_STATUS.OCCUPIED;

  const minRank = Math.min(
    ...liveItems.map((item) => ITEM_STATUS_RANK[item.status as Exclude<ItemStatus, 'cancelled'>]),
  );

  if (minRank === 0) return SESSION_STATUS.ORDER_PENDING;
  if (minRank === 1 || minRank === 2) return SESSION_STATUS.PREPARING;
  if (minRank === 3) return SESSION_STATUS.READY;
  // Everything served and nothing outstanding — the table is simply occupied.
  return SESSION_STATUS.OCCUPIED;
}

export interface MoneyTotals {
  subtotal: number;
  taxTotal: number;
  total: number;
}

/** Money for a set of item lines. Cancelled lines are excluded — never billed. */
export function totalsForItems(items: ItemLike[]): MoneyTotals {
  let subtotal = 0;
  let taxTotal = 0;

  for (const item of items) {
    if (item.status === ITEM_STATUS.CANCELLED) continue;
    const amount = item.unitPrice * item.quantity;
    subtotal += amount;
    taxTotal += (amount * item.taxPercent) / 100;
  }

  subtotal = round2(subtotal);
  taxTotal = round2(taxTotal);
  return { subtotal, taxTotal, total: round2(subtotal + taxTotal) };
}
