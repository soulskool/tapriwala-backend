import mongoose, { Schema, model, type Types, type Model, type HydratedDocument } from 'mongoose';

import {
  ITEM_STATUS,
  ITEM_STATUS_VALUES,
  KITCHEN_STATION_VALUES,
  ORDER_SOURCE_VALUES,
  ORDER_TYPE,
  ORDER_TYPE_VALUES,
  ROUND_STATUS,
  ROUND_STATUS_VALUES,
  type ItemStatus,
  type KitchenStation,
  type OrderSource,
  type OrderType,
  type RoundStatus,
} from '../config/constants.js';

/**
 * One "Place Order" tap = one round, whether it came from the customer QR page
 * or a waiter phone. Rounds are append-only within a session; round 2 is an
 * add-on, not a replacement.
 *
 * Item lines snapshot posName/price/tax at order time. Historic rounds must
 * never be re-priced from ProductMaster when the menu price changes later.
 */
export interface IOrderItem {
  _id: Types.ObjectId;
  productId: Types.ObjectId | null;
  productCode: string;
  posName: string;
  displayName: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  specialInstructions: string;
  kitchenStation: KitchenStation;
  status: ItemStatus;
  acceptedAt: Date | null;
  preparingAt: Date | null;
  readyAt: Date | null;
  servedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string;
  cancelledBy: {
    role: string;
    userId: Types.ObjectId | null;
    name: string;
  } | null;
  /** True when the item was cancelled after the kitchen had started it. */
  cancelledAfterPrep: boolean;
}

export interface IOrderRound {
  sessionId: Types.ObjectId;
  tableId: Types.ObjectId;
  tableCode: string;
  roundNumber: number;
  kotId: string;
  source: OrderSource;
  /** Eaten here or carried out. Defaults to dining; see ORDER_TYPE. */
  orderType: OrderType;
  placedBy: {
    role: string;
    userId: Types.ObjectId | null;
    name: string;
  };
  items: Types.DocumentArray<IOrderItem>;
  status: RoundStatus;
  placedAt: Date;
  readyAt: Date | null;
  servedAt: Date | null;
  /** Client-supplied key that makes a double-tapped "Place Order" a no-op. */
  idempotencyKey: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderRoundDocument = HydratedDocument<IOrderRound>;

const cancelActorSchema = new Schema(
  {
    role: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '' },
  },
  { _id: false },
);

const orderItemSchema = new Schema<IOrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'ProductMaster', default: null },
    productCode: { type: String, required: true, uppercase: true, trim: true },
    posName: { type: String, required: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    taxPercent: { type: Number, required: true, min: 0, max: 100 },
    specialInstructions: { type: String, default: '', trim: true, maxlength: 300 },
    kitchenStation: { type: String, required: true, enum: KITCHEN_STATION_VALUES },
    status: {
      type: String,
      required: true,
      enum: ITEM_STATUS_VALUES,
      default: ITEM_STATUS.PENDING,
    },
    acceptedAt: { type: Date, default: null },
    preparingAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    servedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '', maxlength: 300 },
    cancelledBy: { type: cancelActorSchema, default: null },
    cancelledAfterPrep: { type: Boolean, default: false },
  },
  { _id: true },
);

const orderRoundSchema = new Schema<IOrderRound>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'TableSession', required: true, index: true },
    tableId: { type: Schema.Types.ObjectId, ref: 'TableMaster', required: true, index: true },
    tableCode: { type: String, required: true, uppercase: true, trim: true },
    roundNumber: { type: Number, required: true, min: 1 },
    kotId: { type: String, required: true, trim: true },
    source: { type: String, required: true, enum: ORDER_SOURCE_VALUES },
    /*
     * Not `required`, and defaulted: every round placed before this field
     * existed reads back as dining, which is what those rounds actually were.
     * Read paths that use `.lean()` skip schema defaults, so the mappers
     * coalesce as well -- the default here is for writes, not for reads.
     */
    orderType: { type: String, enum: ORDER_TYPE_VALUES, default: ORDER_TYPE.DINING },
    placedBy: {
      type: new Schema(
        {
          role: { type: String, required: true },
          userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          name: { type: String, default: '' },
        },
        { _id: false },
      ),
      required: true,
    },
    items: { type: [orderItemSchema], required: true },
    status: {
      type: String,
      required: true,
      enum: ROUND_STATUS_VALUES,
      default: ROUND_STATUS.PENDING,
      index: true,
    },
    placedAt: { type: Date, required: true, default: Date.now, index: true },
    readyAt: { type: Date, default: null },
    servedAt: { type: Date, default: null },
    idempotencyKey: { type: String, required: true },
    subtotal: { type: Number, required: true, default: 0 },
    taxTotal: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

/**
 * A retried "Place Order" with the same key must not create a second round.
 *
 * Scoped to the session, not global: if it were global, two tables whose
 * clients both generate naive keys ("1", "2") would collide, and the second
 * table would silently be handed the first table's round. Uniqueness only
 * needs to hold within the session the key is being replayed against.
 */
orderRoundSchema.index(
  { sessionId: 1, idempotencyKey: 1 },
  { unique: true, name: 'uniq_idempotency_key' },
);
// Round numbers are dense and unique within a session.
orderRoundSchema.index({ sessionId: 1, roundNumber: 1 }, { unique: true });
// KDS queue: live tickets, oldest first.
orderRoundSchema.index({ status: 1, placedAt: 1 });
// Billing consolidation reads every round of a session in order.
orderRoundSchema.index({ sessionId: 1, placedAt: 1 });
orderRoundSchema.index({ kotId: 1 });

export const OrderRound: Model<IOrderRound> =
  (mongoose.models.OrderRound as Model<IOrderRound>) ||
  model<IOrderRound>('OrderRound', orderRoundSchema);

export default OrderRound;
