import mongoose, { Schema, model, type Types, type Model, type HydratedDocument } from 'mongoose';

import type { AuditAction, AuditEntity } from '../config/constants.js';

/**
 * Append-only trail of who did what.
 *
 * This is the answer to "the customer says they never ordered that" and to
 * "who cancelled a served item". Nothing in the app updates or deletes these
 * rows; they are written by `audit.service` on every state-changing action.
 */
export interface IAuditLog {
  entityType: AuditEntity;
  entityId: Types.ObjectId;
  action: AuditAction;
  actor: {
    role: string;
    userId: Types.ObjectId | null;
    name: string;
  };
  sessionId: Types.ObjectId | null;
  tableCode: string | null;
  before: unknown;
  after: unknown;
  meta: Record<string, unknown>;
  ip: string | null;
  timestamp: Date;
}

export type AuditLogDocument = HydratedDocument<IAuditLog>;

const auditLogSchema = new Schema<IAuditLog>(
  {
    entityType: { type: String, required: true, index: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    action: { type: String, required: true, index: true },
    actor: {
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
    sessionId: { type: Schema.Types.ObjectId, ref: 'TableSession', default: null, index: true },
    tableCode: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    meta: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: false, versionKey: false },
);

// "Show me everything that happened to this session/table today."
auditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

export const AuditLog: Model<IAuditLog> =
  (mongoose.models.AuditLog as Model<IAuditLog>) || model<IAuditLog>('AuditLog', auditLogSchema);

export default AuditLog;
