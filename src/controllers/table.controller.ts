import * as tableService from '../services/table.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { queryBool } from '../utils/helpers.js';

/** GET /tables — the live table grid (Requirement 1). */
export const getLiveGrid = asyncHandler(async (req, res) => {
  const tiles = await tableService.getLiveGrid({
    zoneId: req.query.zoneId as string | undefined,
    includeInactive: queryBool(req.query.includeInactive),
  });

  // Zones are returned alongside so the frontend can lay the grid out by area
  // without hardcoding the café floor plan. Tiles arrive in zone order, so the
  // first-seen order of names is the floor order.
  const zones = Array.from(new Set(tiles.map((tile) => tile.zone)));

  return sendSuccess(res, { tables: tiles, zones, count: tiles.length });
});

/** GET /tables/master — plain table list for admin screens. */
export const list = asyncHandler(async (req, res) => {
  const tables = await tableService.list({
    zoneId: req.query.zoneId as string | undefined,
    includeInactive: queryBool(req.query.includeInactive),
  });
  return sendSuccess(res, tables);
});

/** GET /tables/:id */
export const getById = asyncHandler(async (req, res) => {
  const table = await tableService.getByIdOrThrow(req.params.id as string);
  return sendSuccess(res, {
    ...(await tableService.view(table)),
    qrUrl: tableService.qrUrl(table.code),
  });
});

/** POST /tables — admin */
export const create = asyncHandler(async (req, res) => {
  const table = await tableService.create(req.body as Record<string, unknown>, getActor(req));
  return sendCreated(
    res,
    { ...(await tableService.view(table)), qrUrl: tableService.qrUrl(table.code) },
    `Table ${table.code} created`,
  );
});

/** PATCH /tables/:id — admin */
export const update = asyncHandler(async (req, res) => {
  const table = await tableService.update(
    req.params.id as string,
    req.body as Record<string, unknown>,
    getActor(req),
  );
  return sendSuccess(res, await tableService.view(table), `Table ${table.code} updated`);
});

/** DELETE /tables/:id — admin. Refused while the table has an open session. */
export const remove = asyncHandler(async (req, res) => {
  // Express 5 leaves `req.body` undefined on a DELETE sent without one.
  const reason = (req.body as { reason?: string } | undefined)?.reason;
  const table = await tableService.remove(req.params.id as string, reason ?? '', getActor(req));
  return sendSuccess(
    res,
    { _id: String(table._id), code: table.code },
    `Table ${table.code} deleted`,
  );
});

/** GET /tables/qr-sheet — every active table's QR URL, for printing. */
export const qrSheet = asyncHandler(async (_req, res) => {
  const tables = await tableService.list({});
  return sendSuccess(
    res,
    tables.map((table) => ({
      code: table.code,
      zone: table.zone,
      qrUrl: tableService.qrUrl(table.code),
    })),
  );
});
