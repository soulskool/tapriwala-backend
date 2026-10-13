import bcrypt from 'bcryptjs';

import { AUDIT_ACTION, AUDIT_ENTITY, ROLES, type Role } from '../config/constants.js';
import { User, hashPin, type UserDocument } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { compact } from '../utils/helpers.js';
import { signToken } from '../utils/jwt.js';
import { logger } from '../utils/logger.js';
import type { Actor } from '../utils/actor.js';
import * as auditService from './audit.service.js';

/**
 * Staff authentication.
 *
 * PIN, not password: the devices are shared and on a counter, and a waiter
 * should be three taps from taking an order. Attribution is preserved because
 * each person has their own PIN and every action is audit-logged against them.
 */

export interface LoginResult {
  token: string;
  user: { id: string; name: string; role: Role };
}

/**
 * A real bcrypt hash of nothing anyone can type, compared against when the
 * phone is unknown. Without it an unknown number answers in ~1 ms and a known
 * one in ~60 ms, and that gap alone tells a stranger which phones are staff.
 */
let decoyHash: Promise<string> | null = null;
function getDecoyHash(): Promise<string> {
  decoyHash ??= hashPin(`decoy-${Date.now()}-${Math.random()}`);
  return decoyHash;
}

export async function login(phone: string, pin: string, ip?: string | null): Promise<LoginResult> {
  const user = await User.findOne({ phone: String(phone) }).select(
    '+pinHash name role isActive phone',
  );

  // Same message and the same bcrypt cost either way — never reveal which
  // staff phones exist, or which of them are switched off.
  const invalid = ApiError.unauthorized('Invalid phone or PIN');
  if (!user) {
    await bcrypt.compare(String(pin), await getDecoyHash());
    throw invalid;
  }

  const matches = await user.comparePin(String(pin));
  if (!matches) throw invalid;

  // Only someone who already knows the PIN learns the account is off.
  if (!user.isActive) throw ApiError.forbidden('This account is deactivated');

  user.lastLoginAt = new Date();
  await user.save();

  const token = signToken({ sub: String(user._id), role: user.role, name: user.name });

  await auditService.record({
    entityType: AUDIT_ENTITY.USER,
    entityId: user._id,
    action: AUDIT_ACTION.USER_LOGIN,
    actor: { role: user.role, userId: user._id, name: user.name },
    meta: { role: user.role },
    ip: ip ?? null,
  });

  logger.info(`Login: ${user.name} (${user.role})`);

  return {
    token,
    user: { id: String(user._id), name: user.name, role: user.role },
  };
}

export async function createUser(
  payload: { name: string; phone: string; role: Role; pin: string },
  actor: Actor,
): Promise<UserDocument> {
  const existing = await User.findOne({ phone: payload.phone }).select('_id').lean();
  if (existing) throw ApiError.conflict('A user with this phone already exists');

  const user = await User.create({
    name: payload.name,
    phone: payload.phone,
    role: payload.role,
    pinHash: await hashPin(payload.pin),
  });

  await auditService.record({
    entityType: AUDIT_ENTITY.USER,
    entityId: user._id,
    action: AUDIT_ACTION.USER_CREATED,
    actor,
    after: { name: user.name, phone: user.phone, role: user.role },
  });

  return user;
}

export async function updateUser(
  userId: string,
  payload: { name?: string; phone?: string; role?: Role; pin?: string; isActive?: boolean },
  actor: Actor,
): Promise<UserDocument> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  // An admin is never switched off, by anyone — themselves included. Admins
  // are the only ones who can reactivate an account, so a deactivated admin is
  // how the shop locks itself out of its own Staff page.
  if (user.role === ROLES.ADMIN && payload.isActive === false) {
    throw ApiError.forbidden('An admin account cannot be deactivated');
  }

  const before = { name: user.name, phone: user.phone, role: user.role, isActive: user.isActive };

  if (payload.phone && payload.phone !== user.phone) {
    const clash = await User.findOne({ phone: payload.phone }).select('_id').lean();
    if (clash) throw ApiError.conflict('Another user already uses this phone');
  }

  user.set(
    compact({
      name: payload.name,
      phone: payload.phone,
      role: payload.role,
      isActive: payload.isActive,
    }),
  );
  if (payload.pin) user.pinHash = await hashPin(payload.pin);
  await user.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.USER,
    entityId: user._id,
    action: AUDIT_ACTION.USER_UPDATED,
    actor,
    before,
    after: { name: user.name, phone: user.phone, role: user.role, isActive: user.isActive },
    meta: { pinChanged: Boolean(payload.pin) },
  });

  return user;
}

/**
 * The PINs the seed script creates, which are printed in the README and in
 * every seed run. An account still using one is an open door.
 */
const PUBLISHED_SEED_PINS: Record<string, string> = {
  '9999999999': '1234',
  '9000000001': '1111',
  '9000000002': '2222',
  '9000000003': '3333',
};

/**
 * Names every active account that still has its published seed PIN.
 *
 * Read-only and called once after boot: it only logs, so a café that has not
 * changed its PINs yet keeps working, but the server log says so every start.
 */
export async function findAccountsWithSeedPins(): Promise<string[]> {
  const users = await User.find({
    phone: { $in: Object.keys(PUBLISHED_SEED_PINS) },
    isActive: true,
  }).select('+pinHash name phone role');

  const exposed: string[] = [];
  for (const user of users) {
    const seedPin = PUBLISHED_SEED_PINS[user.phone];
    if (seedPin && (await user.comparePin(seedPin))) {
      exposed.push(`${user.name} (${user.role}, ${user.phone})`);
    }
  }
  return exposed;
}

export async function listUsers(includeInactive = false): Promise<UserDocument[]> {
  const query = includeInactive ? {} : { isActive: true };
  return User.find(query).sort({ role: 1, name: 1 });
}

export async function getProfile(userId: string): Promise<UserDocument> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}
