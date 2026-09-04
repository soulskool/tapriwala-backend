import mongoose, { Schema, model, type Model, type HydratedDocument } from 'mongoose';

import { TABLE_ZONE_VALUES, type TableZone } from '../config/constants.js';

/**
 * A physical table.
 *
 * `code` is both what humans say ("M2") and what the QR sticker encodes, so a
 * sticker is simply `/order/M2` and reprinting one needs nothing looked up.
 *
 * This used to be two fields: a random `qrToken` carried the URL precisely so
 * that `/order/M2` could not be typed by hand. That protection was dropped by
 * an explicit decision -- the printed sheet is now readable, and a lost sticker
 * is replaced by printing the same URL again. What it costs is that anybody who
 * knows the table letters can open a session from outside the cafe. The floor's
 * "Free table" button is the accepted answer to that, with the rate limiter and
 * the audit log bounding the damage. Revisit if fake orders become real.
 */
export interface ITableMaster {
  code: string;
  zone: TableZone;
  displayOrder: number;
  seatingCapacity: number;
  isActive: boolean;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TableMasterDocument = HydratedDocument<ITableMaster>;

const tableMasterSchema = new Schema<ITableMaster>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 12,
    },
    zone: { type: String, required: true, enum: TABLE_ZONE_VALUES, index: true },
    displayOrder: { type: Number, required: true, default: 0 },
    seatingCapacity: { type: Number, required: true, default: 4, min: 1, max: 50 },
    isActive: { type: Boolean, default: true, index: true },
    notes: { type: String, default: '', trim: true, maxlength: 200 },
  },
  { timestamps: true, versionKey: false },
);

// The grid is always rendered zone-by-zone in a fixed physical order.
tableMasterSchema.index({ zone: 1, displayOrder: 1 });

export const TableMaster: Model<ITableMaster> =
  (mongoose.models.TableMaster as Model<ITableMaster>) ||
  model<ITableMaster>('TableMaster', tableMasterSchema);

export default TableMaster;
