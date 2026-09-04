import mongoose, { Schema, model, type Types, type Model, type HydratedDocument } from 'mongoose';

import {
  ORDER_SOURCE_VALUES,
  SESSION_STATUS,
  SESSION_STATUS_VALUES,
  type OrderSource,
  type SessionStatus,
} from '../config/constants.js';

/**
 * One continuous occupancy of a table — from the first order until the bill is
 * closed. Add-on rounds attach to the same session, which is what makes "M2
 * ordered again 15 minutes later" one bill instead of three.
 *
 * Sessions are never deleted; closing only flips `status`/`isActive`, so the
 * full history stays queryable for disputes and reporting.
 */
export interface ITableSession {
  tableId: Types.ObjectId;
  tableCode: string;
  sessionNumber: number;
  status: SessionStatus;
  /**
   * Mirror of `status !== 'closed'`, kept as its own field only so MongoDB can
   * enforce "one live session per table" with a unique partial index.
   * (partialFilterExpression cannot express `$ne`.)
   */
  isActive: boolean;
  openedAt: Date;
  closedAt: Date | null;
  openedBy: {
    role: string;
    userId: Types.ObjectId | null;
    name: string;
  };
  closedBy: {
    role: string;
    userId: Types.ObjectId | null;
    name: string;
  } | null;
  source: OrderSource;
  totalRounds: number;
  runningTotal: number;
  guestCount: number;
  billRequestedAt: Date | null;
  /** Set when kitchen/billing disagree (e.g. item cancelled after serving). */
  heldForReview: boolean;
  reviewNote: string;
  /** Populated when an admin moves a running session to a different table. */
  transferHistory: {
    fromTableId: Types.ObjectId;
    toTableId: Types.ObjectId;
    at: Date;
    byUserId: Types.ObjectId | null;
    reason: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

export type TableSessionDocument = HydratedDocument<ITableSession>;

const actorSchema = new Schema(
  {
    role: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '' },
  },
  { _id: false },
);

const tableSessionSchema = new Schema<ITableSession>(
  {
    tableId: { type: Schema.Types.ObjectId, ref: 'TableMaster', required: true, index: true },
    tableCode: { type: String, required: true, uppercase: true, trim: true },
    sessionNumber: { type: Number, required: true },
    status: {
      type: String,
      required: true,
      enum: SESSION_STATUS_VALUES,
      default: SESSION_STATUS.OCCUPIED,
      index: true,
    },
    isActive: { type: Boolean, required: true, default: true },
    openedAt: { type: Date, required: true, default: Date.now },
    closedAt: { type: Date, default: null },
    openedBy: { type: actorSchema, required: true },
    closedBy: { type: actorSchema, default: null },
    source: { type: String, required: true, enum: ORDER_SOURCE_VALUES },
    totalRounds: { type: Number, default: 0 },
    runningTotal: { type: Number, default: 0 },
    guestCount: { type: Number, default: 0, min: 0, max: 100 },
    billRequestedAt: { type: Date, default: null },
    heldForReview: { type: Boolean, default: false },
    reviewNote: { type: String, default: '', maxlength: 500 },
    transferHistory: {
      type: [
        new Schema(
          {
            fromTableId: { type: Schema.Types.ObjectId, ref: 'TableMaster', required: true },
            toTableId: { type: Schema.Types.ObjectId, ref: 'TableMaster', required: true },
            at: { type: Date, default: Date.now },
            byUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
            reason: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, versionKey: false },
);

/**
 * Hard guarantee of "one live session per table". Without this, two waiters
 * tapping the same empty table at the same moment would both pass an
 * application-level check and create duplicate sessions.
 */
tableSessionSchema.index(
  { tableId: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: 'uniq_active_session_table' },
);

// Live table grid + billing queue lookups.
tableSessionSchema.index({ isActive: 1, status: 1 });
// Reporting / history browsing.
tableSessionSchema.index({ openedAt: -1 });
tableSessionSchema.index({ sessionNumber: -1 });

/** Keeps `isActive` honest no matter which code path flips the status. */
tableSessionSchema.pre('save', function syncIsActive(next) {
  this.isActive = this.status !== SESSION_STATUS.CLOSED;
  next();
});

export const TableSession: Model<ITableSession> =
  (mongoose.models.TableSession as Model<ITableSession>) ||
  model<ITableSession>('TableSession', tableSessionSchema);

export default TableSession;
