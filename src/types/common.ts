import type { Types } from 'mongoose';

import type {
  ExportMethod,
  ItemStatus,
  KitchenStation,
  OrderType,
  Role,
  SessionStatus,
} from '../config/constants.js';

/** Who performed an action — a staff member, or an anonymous QR customer. */
export interface Actor {
  role: Role | 'customer';
  userId: Types.ObjectId | null;
  name: string;
}

/** One line of a cart as submitted by a client. Prices are never trusted from here. */
export interface OrderItemInput {
  productCode: string;
  quantity: number;
  specialInstructions?: string;
}

/** A consolidated bill line, grouped by productCode across every round. */
export interface ConsolidatedLine {
  productCode: string;
  posName: string;
  displayName: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  amount: number;
  taxAmount: number;
  kitchenStation: KitchenStation;
  /**
   * Dining or parcel. Part of the grouping key, so a table that ate three teas
   * and carried one out bills as two lines rather than one that is half a lie.
   */
  orderType: OrderType;
  /** Round numbers this quantity came from, for staff drill-down. */
  rounds: number[];
}

export interface ConsolidatedBill {
  sessionId: string;
  tableCode: string;
  sessionNumber: number;
  openedAt: Date;
  status: SessionStatus;
  lines: ConsolidatedLine[];
  cancelledLines: ConsolidatedLine[];
  subtotal: number;
  tax: number;
  /** What the guest pays: subtotal + tax rounded to the whole rupee. */
  total: number;
  /** total − (subtotal + tax), signed: +0.50 rounded up, −0.05 rounded down. */
  roundOff: number;
  roundCount: number;
  itemCount: number;
  /**
   * Every order type present on this bill, dining first. One entry is the
   * normal case and prints as a single heading; two means the receipt has to
   * say so per line rather than pick one and be wrong about half the items.
   */
  orderTypes: OrderType[];
  /** True when items were cancelled after preparation started — needs a manager look. */
  requiresReview: boolean;
}

export interface ExportRequestOptions {
  method: ExportMethod;
  note?: string;
}

/** Shape used by the live table grid endpoint. */
export interface LiveTableTile {
  tableId: string;
  code: string;
  zone: string;
  displayOrder: number;
  seatingCapacity: number;
  status: SessionStatus | 'empty';
  sessionId: string | null;
  sessionNumber: number | null;
  openedAt: Date | null;
  minutesOpen: number;
  runningTotal: number;
  roundCount: number;
  pendingItemCount: number;
  readyItemCount: number;
  openServiceRequests: number;
  billRequested: boolean;
  /** Oldest unattended service request age, drives the escalation flash. */
  oldestRequestMinutes: number;
  needsAttention: boolean;
}

/** A KDS ticket: one order round, rendered as a card. */
export interface KdsTicket {
  roundId: string;
  sessionId: string;
  tableId: string;
  tableCode: string;
  zone: string;
  kotId: string;
  roundNumber: number;
  isAddOn: boolean;
  source: string;
  /** Dining or parcel — the heading the KOT prints and the badge on the card. */
  orderType: OrderType;
  /** Who sent it. Printed on the KOT as the server name. */
  placedByName: string;
  placedAt: Date;
  elapsedMinutes: number;
  status: string;
  /**
   * What this round is worth, cancelled items excluded.
   *
   * The KDS is not a billing screen and must never become one — but a cook
   * being asked "is the 420 one ready?" over the pass needs the number on the
   * card to answer it. Derived from the same snapshotted item prices the bill
   * uses, so the two can never disagree.
   */
  subtotal: number;
  tax: number;
  total: number;
  items: {
    itemId: string;
    productCode: string;
    displayName: string;
    quantity: number;
    specialInstructions: string;
    kitchenStation: KitchenStation;
    status: ItemStatus;
    unavailable: boolean;
    /** Snapshotted at order time — never re-read from the menu. */
    unitPrice: number;
    lineTotal: number;
  }[];
}
