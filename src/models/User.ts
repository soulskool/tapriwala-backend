import bcrypt from 'bcryptjs';
import mongoose, { Schema, model, type Model, type HydratedDocument } from 'mongoose';

import { APP_CONSTANTS, ROLE_VALUES, type Role } from '../config/constants.js';

/**
 * Staff account.
 *
 * Devices on the floor are shared (one waiter phone, one kitchen tablet), so
 * login is a short PIN rather than a password — but every action is still
 * attributed to the individual who tapped it via the audit log.
 */
export interface IUser {
  name: string;
  phone: string;
  role: Role;
  pinHash: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  comparePin(candidate: string): Promise<boolean>;
}

export type UserDocument = HydratedDocument<IUser, IUserMethods>;
type UserModel = Model<IUser, Record<string, never>, IUserMethods>;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^\d{10}$/, 'Phone must be a 10 digit number'],
    },
    role: { type: String, required: true, enum: ROLE_VALUES, index: true },
    // Never selected by default — a stray `.find()` must not leak PIN hashes.
    pinHash: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true, index: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

userSchema.methods.comparePin = function comparePin(candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.pinHash);
};

/** Hashes a raw PIN with the project-wide cost factor. */
export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, APP_CONSTANTS.BCRYPT_ROUNDS);
}

export const User: UserModel =
  (mongoose.models.User as UserModel) || model<IUser, UserModel>('User', userSchema);

export default User;
