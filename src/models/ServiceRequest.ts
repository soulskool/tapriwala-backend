import mongoose, { Schema, model, type Types, type Model, type HydratedDocument } from 'mongoose';

import {
  SERVICE_REQUEST_STATUS,
  SERVICE_REQUEST_STATUS_VALUES,
  SERVICE_REQUEST_TYPE_VALUES,
  type ServiceRequestStatus,
  type ServiceRequestType,
} from '../config/constants.js';

/**
 * Water / call-staff / bill request raised from a table.
 *
 * Repeat taps do NOT create new rows — they bump `repeatCount` and
 * `lastRaisedAt` on the existing live request. That keeps the waiter dashboard
 * readable while making impatience visible (5 taps in 2 minutes is louder than
 * one), and `raisedAt` still drives the true wait time.
 */
export interface IServiceRequest {
  tableId: Types.ObjectId;
  tableCode: string;
  sessionId: Types.ObjectId | null;
  type: ServiceRequestType;
  status: ServiceRequestStatus;
  raisedAt: Date;
  lastRaisedAt: Date;
  repeatCount: number;
  raisedBy: {
    role: string;
    userId: Types.ObjectId | null;
    name: string;
  };
  acknowledgedAt: Date | null;
  acknowledgedBy: Types.ObjectId | null;
  resolvedAt: Date | null;
  resolvedBy: Types.ObjectId | null;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ServiceRequestDocument = HydratedDocument<IServiceRequest>;

const serviceRequestSchema = new Schema<IServiceRequest>(
  {
    tableId: { type: Schema.Types.ObjectId, ref: 'TableMaster', required: true, index: true },
    tableCode: { type: String, required: true, uppercase: true, trim: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'TableSession', default: null, index: true },
    type: { type: String, required: true, enum: SERVICE_REQUEST_TYPE_VALUES },
    status: {
      type: String,
      required: true,
      enum: SERVICE_REQUEST_STATUS_VALUES,
      default: SERVICE_REQUEST_STATUS.OPEN,
      index: true,
    },
    raisedAt: { type: Date, required: true, default: Date.now },
    lastRaisedAt: { type: Date, required: true, default: Date.now },
    repeatCount: { type: Number, default: 1, min: 1 },
    raisedBy: {
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
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true, versionKey: false },
);

// De-dupe lookup: "is there already a live request of this type on this table?"
serviceRequestSchema.index({ tableId: 1, type: 1, status: 1 });
// Waiter dashboard: open requests, oldest first.
serviceRequestSchema.index({ status: 1, raisedAt: 1 });
serviceRequestSchema.index({ sessionId: 1, raisedAt: -1 });

export const ServiceRequest: Model<IServiceRequest> =
  (mongoose.models.ServiceRequest as Model<IServiceRequest>) ||
  model<IServiceRequest>('ServiceRequest', serviceRequestSchema);

export default ServiceRequest;
