import type { AuditAction, AuditEntity, Role } from '../config/constants.js';
import * as auditService from '../services/audit.service.js';
import * as authService from '../services/auth.service.js';
import * as billingService from '../services/billing.service.js';
import * as orderService from '../services/order.service.js';
import * as serviceRequestService from '../services/serviceRequest.service.js';
import * as tableService from '../services/table.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendPaginated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { getPagination } from '../utils/pagination.js';
import { queryBool, queryDate } from '../utils/helpers.js';

// ─── Users ───────────────────────────────────────────────────────────────────

/** GET /admin/users */
export const listUsers = asyncHandler(async (req, res) => {
  const users = await authService.listUsers(
    queryBool(req.query.includeInactive),
  );
  return sendSuccess(
    res,
    users.map((user) => ({
      id: String(user._id),
      name: user.name,
      phone: user.phone,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
    })),
  );
});

/** POST /admin/users */
export const createUser = asyncHandler(async (req, res) => {
  const user = await authService.createUser(
    req.body as { name: string; phone: string; role: Role; pin: string },
    getActor(req),
  );
  return sendCreated(
    res,
    { id: String(user._id), name: user.name, phone: user.phone, role: user.role },
    `${user.name} added as ${user.role}`,
  );
});

/** PATCH /admin/users/:id */
export const updateUser = asyncHandler(async (req, res) => {
  const user = await authService.updateUser(
    req.params.id as string,
    req.body as Record<string, never>,
    getActor(req),
  );
  return sendSuccess(
    res,
    {
      id: String(user._id),
      name: user.name,
      phone: user.phone,
      role: user.role,
      isActive: user.isActive,
    },
    `${user.name} updated`,
  );
});

// ─── Audit ───────────────────────────────────────────────────────────────────

/** GET /admin/audit — the scrutiny trail. */
export const listAudit = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);

  const { items, total } = await auditService.list(
    {
      entityType: req.query.entityType as AuditEntity | undefined,
      entityId: req.query.entityId as string | undefined,
      sessionId: req.query.sessionId as string | undefined,
      action: req.query.action as AuditAction | undefined,
      from: queryDate(req.query.from),
      to: queryDate(req.query.to),
    },
    skip,
    limit,
  );

  return sendPaginated(res, items, page, limit, total);
});

// ─── Live operations overview ────────────────────────────────────────────────

/**
 * GET /admin/overview — one read-only screen with the whole floor: table grid,
 * kitchen queue, open requests and the billing queue.
 *
 * This exists so ownership can see what is happening without walking the floor
 * or asking staff mid-service.
 */
export const overview = asyncHandler(async (_req, res) => {
  const [tables, kitchen, requests, billing, readyTooLong] = await Promise.all([
    tableService.getLiveGrid({}),
    orderService.getKitchenQueue(),
    serviceRequestService.getLiveQueue(),
    billingService.getBillingQueue(),
    orderService.getUnservedReadyRounds(),
  ]);

  const occupied = tables.filter((table) => table.status !== 'empty');

  return sendSuccess(res, {
    generatedAt: new Date(),
    summary: {
      totalTables: tables.length,
      occupiedTables: occupied.length,
      freeTables: tables.length - occupied.length,
      liveTickets: kitchen.length,
      openServiceRequests: requests.length,
      escalatedRequests: requests.filter((request) => request.isEscalated === true).length,
      awaitingBill: billing.length,
      readyButUnserved: readyTooLong.length,
      runningRevenue: occupied.reduce((sum, table) => sum + table.runningTotal, 0),
    },
    tables,
    kitchenQueue: kitchen,
    serviceRequests: requests,
    billingQueue: billing,
    readyTooLong,
  });
});
