import type { Types } from 'mongoose';

import type {
  ExportMethod,
  ItemStatus,
  KitchenStation,
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
  total: number;
  roundCount: number;
  itemCount: number;
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
  placedAt: Date;
  elapsedMinutes: number;
  status: string;
  items: {
    itemId: string;
    productCode: string;
    displayName: string;
    quantity: number;
    specialInstructions: string;
    kitchenStation: KitchenStation;
    status: ItemStatus;
    unavailable: boolean;
  }[];
}
