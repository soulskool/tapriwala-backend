import mongoose, { Schema, model, type Model, type HydratedDocument, type Types } from 'mongoose';

import { LIVE_ONLY_INDEX, softDeleteSchemaFields, type SoftDeleteFields } from './softDelete.js';

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
 *
 * `zoneId` points at a Zone document. Tables written before zones were
 * managed carried the zone's name as text in a `zone` field; the zones
 * migration turned each name into a Zone and left the old text in place,
 * unread, so a rollback to the previous release still finds it.
 *
 * Deleting a table is a soft delete (see softDelete.ts). Its code is freed, so
 * a new "M2" can be created and its sticker reprinted from the same URL.
 */
export interface ITableMaster extends SoftDeleteFields {
  code: string;
  zoneId: Types.ObjectId;
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
      trim: true,
      uppercase: true,
      maxlength: 12,
    },
    zoneId: { type: Schema.Types.ObjectId, ref: 'Zone', required: true, index: true },
    displayOrder: { type: Number, required: true, default: 0 },
    seatingCapacity: { type: Number, required: true, default: 4, min: 1, max: 50 },
    isActive: { type: Boolean, default: true, index: true },
    notes: { type: String, default: '', trim: true, maxlength: 200 },
    ...softDeleteSchemaFields,
  },
  { timestamps: true, versionKey: false },
);

// One live table per code; a deleted table's code is free to reuse.
tableMasterSchema.index(
  { code: 1 },
  { unique: true, name: 'uniq_live_table_code', ...LIVE_ONLY_INDEX },
);

export const TableMaster: Model<ITableMaster> =
  (mongoose.models.TableMaster as Model<ITableMaster>) ||
  model<ITableMaster>('TableMaster', tableMasterSchema);

export default TableMaster;
