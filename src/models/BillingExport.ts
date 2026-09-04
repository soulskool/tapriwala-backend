import mongoose, { Schema, model, type Types, type Model, type HydratedDocument } from 'mongoose';

import {
  EXPORT_METHOD_VALUES,
  EXPORT_STATUS,
  EXPORT_STATUS_VALUES,
  type ExportMethod,
  type ExportStatus,
} from '../config/constants.js';

/**
 * A bill handed to the legacy POS.
 *
 * Deliberately many-per-session (not embedded in TableSession) so Phase 2 split
 * bills and export retries after a POS failure both fit without a migration.
 * The line items are a frozen snapshot: re-printing an old bill must reproduce
 * exactly what was charged, not today's prices.
 */
export interface IBillingExportLine {
  productCode: string;
  posName: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  amount: number;
  taxAmount: number;
}

export interface IBillingExport {
  sessionId: Types.ObjectId;
  tableId: Types.ObjectId;
  tableCode: string;
  billNumber: number;
  generatedAt: Date;
  generatedBy: {
    role: string;
    userId: Types.ObjectId | null;
    name: string;
  };
  lineItems: IBillingExportLine[];
  subtotal: number;
  tax: number;
  total: number;
  exportMethod: ExportMethod;
  exportStatus: ExportStatus;
  posReferenceId: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
  confirmedAt: Date | null;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

export type BillingExportDocument = HydratedDocument<IBillingExport>;

const lineItemSchema = new Schema<IBillingExportLine>(
  {
    productCode: { type: String, required: true, uppercase: true, trim: true },
    posName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    taxPercent: { type: Number, required: true, min: 0, max: 100 },
    amount: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const billingExportSchema = new Schema<IBillingExport>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'TableSession', required: true, index: true },
    tableId: { type: Schema.Types.ObjectId, ref: 'TableMaster', required: true },
    tableCode: { type: String, required: true, uppercase: true, trim: true },
    billNumber: { type: Number, required: true, unique: true },
    generatedAt: { type: Date, required: true, default: Date.now },
    generatedBy: {
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
    lineItems: { type: [lineItemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    exportMethod: { type: String, required: true, enum: EXPORT_METHOD_VALUES },
    exportStatus: {
      type: String,
      required: true,
      enum: EXPORT_STATUS_VALUES,
      default: EXPORT_STATUS.PENDING,
      index: true,
    },
    posReferenceId: { type: String, default: null, trim: true },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    confirmedAt: { type: Date, default: null },
    note: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true, versionKey: false },
);

billingExportSchema.index({ generatedAt: -1 });
billingExportSchema.index({ exportStatus: 1, generatedAt: -1 });

export const BillingExport: Model<IBillingExport> =
  (mongoose.models.BillingExport as Model<IBillingExport>) ||
  model<IBillingExport>('BillingExport', billingExportSchema);

export default BillingExport;
