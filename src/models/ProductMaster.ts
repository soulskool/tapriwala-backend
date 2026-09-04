import mongoose, { Schema, model, type Model, type HydratedDocument } from 'mongoose';

import { KITCHEN_STATION_VALUES, type KitchenStation } from '../config/constants.js';

/**
 * Menu item.
 *
 * `productCode` is the contract with the legacy billing software — it is what
 * gets exported/typed at the counter, so it is unique, immutable in practice,
 * and stored uppercase to avoid "T01" vs "t01" duplicates.
 *
 * Two different "off" switches, deliberately:
 *   isAvailable = false  -> 86'd for today, comes back tomorrow
 *   isActive    = false  -> retired from the menu permanently
 */
export interface IProductMaster {
  productCode: string;
  posName: string;
  displayName: string;
  category: string;
  description: string;
  price: number;
  taxPercent: number;
  kitchenStation: KitchenStation;
  imageUrl: string;
  /** Driver handle for the stored file, so a replaced image can be deleted. */
  imageKey: string;
  displayOrder: number;
  isAvailable: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ProductMasterDocument = HydratedDocument<IProductMaster>;

const productMasterSchema = new Schema<IProductMaster>(
  {
    productCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 32,
    },
    posName: { type: String, required: true, trim: true, maxlength: 120 },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, required: true, trim: true, maxlength: 60, index: true },
    description: { type: String, default: '', trim: true, maxlength: 300 },
    price: { type: Number, required: true, min: 0 },
    taxPercent: { type: Number, required: true, min: 0, max: 100, default: 5 },
    kitchenStation: {
      type: String,
      required: true,
      enum: KITCHEN_STATION_VALUES,
      default: 'Kitchen',
      index: true,
    },
    imageUrl: { type: String, default: '', trim: true },
    imageKey: { type: String, default: '', trim: true },
    displayOrder: { type: Number, default: 0 },
    isAvailable: { type: Boolean, default: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, versionKey: false },
);

// Menu render: active products, grouped by category, in fixed order.
productMasterSchema.index({ isActive: 1, category: 1, displayOrder: 1 });
// Waiter search-as-you-type over name and code.
productMasterSchema.index({ displayName: 'text', posName: 'text', productCode: 'text' });

export const ProductMaster: Model<IProductMaster> =
  (mongoose.models.ProductMaster as Model<IProductMaster>) ||
  model<IProductMaster>('ProductMaster', productMasterSchema);

export default ProductMaster;
