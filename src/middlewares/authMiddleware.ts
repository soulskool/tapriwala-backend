import type { RequestHandler } from 'express';

import { FULL_ACCESS_ROLES, READ_ONLY_ROLES, type Role } from '../config/constants.js';
import { TableMaster, TableSession, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { tokenFromRequest } from '../utils/authToken.js';
import { verifyToken } from '../utils/jwt.js';

/**
 * Requires a valid staff token.
 *
 * The account is re-read on every request so deactivating a user takes effect
 * immediately instead of at token expiry — important for shared floor devices.
 */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = tokenFromRequest(req);
  if (!token) {
    throw ApiError.unauthorized('Authentication required');
  }

  const payload = verifyToken(token);
  const user = await User.findById(payload.sub).select('name role isActive').lean();

  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (!user.isActive) throw ApiError.forbidden('Account is deactivated');

  // The whole of the view-only rule, in one place. Checked here rather than in
  // `authorize` because some writes sit behind `authenticate` alone, and a
  // route added next year must be read-only for these roles without anybody
  // remembering to say so.
  if (READ_ONLY_ROLES.includes(user.role) && !isSafeMethod(req.method)) {
    throw ApiError.forbidden('This account is view-only and cannot change anything');
  }

  req.user = { id: String(user._id), role: user.role, name: user.name };
  next();
});

/** A request that reads and never writes. */
function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

/**
 * Restricts a route to specific roles. Admin and super admin pass every check
 * by design — ownership needs to be able to unstick the floor without
 * role-swapping.
 *
 * A view-only admin passes on reads only: it sees every screen an admin sees.
 * Writes never reach this far for it (`authenticate` already refused them);
 * the method test is repeated here so this function is safe on its own.
 *
 *   router.post('/close', authenticate, authorize(ROLES.BILLING), handler)
 */
export const authorize =
  (...allowed: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) {
      next(ApiError.unauthorized('Authentication required'));
      return;
    }
    const { role } = req.user;
    if (FULL_ACCESS_ROLES.includes(role) || allowed.includes(role)) {
      next();
      return;
    }
    if (READ_ONLY_ROLES.includes(role) && isSafeMethod(req.method)) {
      next();
      return;
    }
    next(ApiError.forbidden(`This action requires one of: ${allowed.join(', ')}`));
  };

/**
 * Restricts a route to exactly these roles — no admin bypass, no read-only
 * pass.
 *
 * For the few actions a plain admin must not take, which today is only
 * creating and editing staff accounts (super admin).
 */
export const requireRole =
  (...allowed: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) {
      next(ApiError.unauthorized('Authentication required'));
      return;
    }
    if (allowed.includes(req.user.role)) {
      next();
      return;
    }
    next(ApiError.forbidden(`This action requires one of: ${allowed.join(', ')}`));
  };

/**
 * Binds a tokenless customer request to exactly one table.
 *
 * The table code in the URL is what the QR sticker carries, and it pins the
 * request to that table for every handler downstream -- which is still what
 * stops a customer at M2 writing onto M3, whatever they put in the body.
 *
 * It is not a credential, and nothing here pretends otherwise: `M2` is
 * guessable by design. See the note on the TableMaster model.
 *
 * Reads the code from `:tableCode` or the `x-table-code` header.
 */
export const resolveTableCode: RequestHandler = asyncHandler(async (req, _res, next) => {
  const raw =
    (req.params.tableCode as string | undefined) ??
    (req.headers['x-table-code'] as string | undefined) ??
    (req.body as { tableCode?: string } | undefined)?.tableCode;

  if (!raw || raw.trim() === '') {
    throw ApiError.unauthorized('Table code is required');
  }

  // Codes are stored uppercase, and a guest may well type /order/m2 by hand.
  const table = await TableMaster.findOne({ code: raw.trim().toUpperCase() })
    .select('code isActive')
    .lean();

  if (!table) throw ApiError.unauthorized('Unknown table code. Please ask staff for help.');
  if (!table.isActive) throw ApiError.forbidden('This table is not in service');

  const activeSession = await TableSession.findOne({ tableId: table._id, isActive: true })
    .select('_id')
    .lean();

  req.customer = {
    tableId: String(table._id),
    tableCode: table.code,
    sessionId: activeSession ? String(activeSession._id) : null,
  };
  next();
});

export default authenticate;
