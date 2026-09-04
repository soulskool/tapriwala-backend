import type { TableZone } from '../config/constants.js';
import * as tableService from '../services/table.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { queryBool } from '../utils/helpers.js';

/** GET /tables — the live table grid (Requirement 1). */
export const getLiveGrid = asyncHandler(async (req, res) => {
  const tiles = await tableService.getLiveGrid({
    zone: req.query.zone as TableZone | undefined,
    includeInactive: queryBool(req.query.includeInactive),
  });

  // Zones are returned alongside so the frontend can lay the grid out by area
  // without hardcoding the café floor plan.
  const zones = Array.from(new Set(tiles.map((tile) => tile.zone)));

  return sendSuccess(res, { tables: tiles, zones, count: tiles.length });
});

/** GET /tables/master — plain table list for admin screens. */
export const list = asyncHandler(async (req, res) => {
  const tables = await tableService.list({
    zone: req.query.zone as TableZone | undefined,
    includeInactive: queryBool(req.query.includeInactive),
  });
  return sendSuccess(res, tables);
});

/** GET /tables/:id */
export const getById = asyncHandler(async (req, res) => {
  const table = await tableService.getByIdOrThrow(req.params.id as string);
  return sendSuccess(res, { ...table.toObject(), qrUrl: tableService.qrUrl(table.code) });
});

/** POST /tables — admin */
export const create = asyncHandler(async (req, res) => {
  const table = await tableService.create(req.body as Record<string, unknown>, getActor(req));
  return sendCreated(
    res,
    { ...table.toObject(), qrUrl: tableService.qrUrl(table.code) },
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
  return sendSuccess(res, table, `Table ${table.code} updated`);
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
