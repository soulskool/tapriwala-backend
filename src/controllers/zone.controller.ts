import * as zoneService from '../services/zone.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';

const view = (zone: { _id: unknown; name: string; displayOrder: number }) => ({
  id: String(zone._id),
  name: zone.name,
  displayOrder: zone.displayOrder,
});

/** GET /zones — live zones in floor order, with table counts. */
export const list = asyncHandler(async (_req, res) => {
  return sendSuccess(res, await zoneService.list());
});

/** POST /zones — admin */
export const create = asyncHandler(async (req, res) => {
  const zone = await zoneService.create(
    req.body as { name: string; displayOrder?: number },
    getActor(req),
  );
  return sendCreated(res, view(zone), `Zone ${zone.name} created`);
});

/** PATCH /zones/:id — admin */
export const update = asyncHandler(async (req, res) => {
  const zone = await zoneService.update(
    req.params.id as string,
    req.body as { name?: string; displayOrder?: number },
    getActor(req),
  );
  return sendSuccess(res, view(zone), `Zone ${zone.name} updated`);
});

/** DELETE /zones/:id — admin. Refused while the zone still has tables. */
export const remove = asyncHandler(async (req, res) => {
  // Express 5 leaves `req.body` undefined on a DELETE sent without one.
  const reason = (req.body as { reason?: string } | undefined)?.reason;
  const zone = await zoneService.remove(req.params.id as string, reason ?? '', getActor(req));
  return sendSuccess(res, view(zone), `Zone ${zone.name} deleted`);
});
