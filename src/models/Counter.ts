import mongoose, { Schema, model, type Model, type HydratedDocument } from 'mongoose';

/**
 * Atomic sequence generator.
 *
 * KOT ids and session numbers must never repeat or skip under concurrent
 * ordering, so they come from a single `findOneAndUpdate($inc)` here rather
 * than from a `count()` + 1 read, which races.
 *
 * `scope` lets a sequence reset per day ("2026-08-31") or run forever ("global").
 */
export interface ICounter {
  key: string;
  scope: string;
  seq: number;
}

export type CounterDocument = HydratedDocument<ICounter>;

const counterSchema = new Schema<ICounter>(
  {
    key: { type: String, required: true, trim: true },
    scope: { type: String, required: true, default: 'global', trim: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

counterSchema.index({ key: 1, scope: 1 }, { unique: true });

export const Counter: Model<ICounter> =
  (mongoose.models.Counter as Model<ICounter>) || model<ICounter>('Counter', counterSchema);

export default Counter;
