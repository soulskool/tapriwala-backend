import mongoose, { Schema, model, type Model, type HydratedDocument } from 'mongoose';

import { LIVE_ONLY_INDEX, softDeleteSchemaFields, type SoftDeleteFields } from './softDelete.js';

/**
 * An area of the café floor ("Left", "Veranda", "Lawn").
 *
 * Managed from the admin Tables page. A table points at its zone by id, so a
 * rename is one write and shows on every screen at once — tables never carry
 * a copy of the name that could drift. `displayOrder` is the order zones read
 * on the live floor, left to right as the café is laid out.
 *
 * A zone cannot be deleted while any table still points at it (see
 * zone.service), so no table is ever left without one.
 */
export interface IZone extends SoftDeleteFields {
  name: string;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ZoneDocument = HydratedDocument<IZone>;

const zoneSchema = new Schema<IZone>(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    displayOrder: { type: Number, required: true, default: 0, min: 0 },
    ...softDeleteSchemaFields,
  },
  { timestamps: true, versionKey: false },
);

// Case-insensitive, so "lawn" cannot sit next to "Lawn" in the dropdown.
zoneSchema.index(
  { name: 1 },
  {
    unique: true,
    name: 'uniq_live_zone_name',
    collation: { locale: 'en', strength: 2 },
    ...LIVE_ONLY_INDEX,
  },
);

export const Zone: Model<IZone> =
  (mongoose.models.Zone as Model<IZone>) || model<IZone>('Zone', zoneSchema);

export default Zone;
