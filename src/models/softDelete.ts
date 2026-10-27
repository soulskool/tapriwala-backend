import { Schema, type Types } from 'mongoose';

/**
 * Soft delete, shared by the master-data models (Zone, TableMaster,
 * ProductMaster, User).
 *
 * "Delete" on an admin screen never removes a document: sessions, rounds,
 * bills and the audit log all point back at these records, and the sales
 * report reads a deleted item's category long after it left the menu. A
 * deleted record is hidden from every list and lookup, keeps its history, and
 * frees its human key (table code, product code, phone) for a new record.
 *
 * Deleting also sets `isActive: false`, so every guard that already refuses a
 * retired table, product or account refuses a deleted one with no extra code.
 *
 * The human key's unique index is partial on `isDeleted: false`. That is why
 * the migration writes `isDeleted: false` onto every existing document: a
 * document without the field sits outside the index.
 */
export interface SoftDeleteFields {
  isDeleted: boolean;
  deletedAt: Date | null;
  deletedBy: { role: string; userId: Types.ObjectId | null; name: string } | null;
  deleteReason: string;
}

export const softDeleteSchemaFields = {
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  deletedBy: {
    type: new Schema(
      {
        role: { type: String, required: true },
        userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        name: { type: String, default: '' },
      },
      { _id: false },
    ),
    default: null,
  },
  deleteReason: { type: String, default: '', trim: true, maxlength: 200 },
};

/**
 * Query fragment for "not deleted".
 *
 * `$ne: true` rather than `false`, so a document written before the field
 * existed still counts as live — the app keeps working on a database the
 * migration has not reached yet.
 */
export const NOT_DELETED = { isDeleted: { $ne: true } } as const;

/** Partial filter for the unique index on a live record's human key. */
export const LIVE_ONLY_INDEX = { partialFilterExpression: { isDeleted: false } } as const;
