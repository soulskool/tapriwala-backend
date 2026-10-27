import { Types } from 'mongoose';

import { AUDIT_ACTION, AUDIT_ENTITY, SOCKET_EVENTS } from '../config/constants.js';
import { NOT_DELETED, TableMaster, Zone, type ZoneDocument } from '../models/index.js';
import { emitToStaff } from '../sockets/emitter.js';
import { ApiError } from '../utils/ApiError.js';
import { actorSnapshot, type Actor } from '../utils/actor.js';
import * as auditService from './audit.service.js';

/**
 * Café zones — the areas the floor is drawn in.
 *
 * A table holds its zone's id, never its name, so a rename is this one write.
 * The only rule worth guarding is the one that would orphan a table: a zone
 * with tables in it cannot be deleted. Move the tables first.
 */

/** Case-insensitive, matching the unique index on Zone.name. */
const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface ZoneView {
  id: string;
  name: string;
  displayOrder: number;
  tableCount: number;
}

/** Live zones in floor order, each with how many live tables it holds. */
export async function list(): Promise<ZoneView[]> {
  const [zones, counts] = await Promise.all([
    Zone.find(NOT_DELETED).sort({ displayOrder: 1, name: 1 }).lean(),
    TableMaster.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: NOT_DELETED },
      { $group: { _id: '$zoneId', count: { $sum: 1 } } },
    ]),
  ]);
  const countByZone = new Map(counts.map((row) => [String(row._id), row.count]));

  return zones.map((zone) => ({
    id: String(zone._id),
    name: zone.name,
    displayOrder: zone.displayOrder,
    tableCount: countByZone.get(String(zone._id)) ?? 0,
  }));
}

/**
 * Every zone ever made, deleted ones included, keyed by id.
 *
 * For labelling tables: a table always points at a live zone (delete is
 * refused otherwise), but reading the deleted ones too means a table can never
 * render without a name, whatever happened to the data.
 */
export async function nameMap(): Promise<Map<string, { name: string; displayOrder: number }>> {
  const zones = await Zone.find().select('name displayOrder').lean();
  return new Map(
    zones.map((zone) => [String(zone._id), { name: zone.name, displayOrder: zone.displayOrder }]),
  );
}

/** A live zone, for assigning a table to it. */
export async function getLiveOrThrow(id: string): Promise<ZoneDocument> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('Choose a zone');
  const zone = await Zone.findOne({ _id: id, ...NOT_DELETED });
  if (!zone) throw ApiError.badRequest('That zone no longer exists. Pick another one.');
  return zone;
}

async function assertNameFree(name: string, exceptId?: Types.ObjectId): Promise<void> {
  const clash = await Zone.findOne({
    name,
    ...NOT_DELETED,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .collation(NAME_COLLATION)
    .select('_id')
    .lean();
  if (clash) throw ApiError.conflict(`A zone called "${name}" already exists`);
}

/** Tells every floor screen to re-read the grid: a zone name or order changed. */
function notifyFloor(zone: ZoneDocument): void {
  emitToStaff(SOCKET_EVENTS.TABLE_STATUS, { zoneId: String(zone._id), zone: zone.name });
}

export async function create(
  payload: { name: string; displayOrder?: number },
  actor: Actor,
): Promise<ZoneDocument> {
  await assertNameFree(payload.name);

  // New zones go to the end of the floor unless told otherwise.
  let displayOrder = payload.displayOrder;
  if (displayOrder === undefined) {
    const last = await Zone.findOne(NOT_DELETED).sort({ displayOrder: -1 }).select('displayOrder');
    displayOrder = last ? last.displayOrder + 1 : 1;
  }

  const zone = await Zone.create({ name: payload.name, displayOrder });

  await auditService.record({
    entityType: AUDIT_ENTITY.ZONE,
    entityId: zone._id,
    action: AUDIT_ACTION.ZONE_CREATED,
    actor,
    after: { name: zone.name, displayOrder: zone.displayOrder },
  });

  notifyFloor(zone);
  return zone;
}

export async function update(
  id: string,
  payload: { name?: string; displayOrder?: number },
  actor: Actor,
): Promise<ZoneDocument> {
  const zone = await getLiveOrThrow(id);
  const before = { name: zone.name, displayOrder: zone.displayOrder };

  if (payload.name !== undefined && payload.name !== zone.name) {
    await assertNameFree(payload.name, zone._id);
    zone.name = payload.name;
  }
  if (payload.displayOrder !== undefined) zone.displayOrder = payload.displayOrder;
  await zone.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.ZONE,
    entityId: zone._id,
    action: AUDIT_ACTION.ZONE_UPDATED,
    actor,
    before,
    after: { name: zone.name, displayOrder: zone.displayOrder },
  });

  notifyFloor(zone);
  return zone;
}

/**
 * Deletes a zone — refused while any table, in service or not, still sits in
 * it. Deleted tables do not count: they keep their old zoneId for history and
 * read the zone's name through `nameMap`, which includes deleted zones.
 */
export async function remove(id: string, reason: string, actor: Actor): Promise<ZoneDocument> {
  const zone = await getLiveOrThrow(id);

  const tables = await TableMaster.find({ zoneId: zone._id, ...NOT_DELETED })
    .select('code')
    .sort({ code: 1 })
    .lean();
  if (tables.length > 0) {
    const codes = tables.map((table) => table.code);
    throw ApiError.invalidState(
      `${zone.name} still has ${codes.length} table${codes.length === 1 ? '' : 's'} (${codes.join(', ')}). Move them to another zone first.`,
      { tableCodes: codes },
    );
  }

  zone.isDeleted = true;
  zone.deletedAt = new Date();
  zone.deletedBy = actorSnapshot(actor);
  zone.deleteReason = reason;
  await zone.save();

  await auditService.record({
    entityType: AUDIT_ENTITY.ZONE,
    entityId: zone._id,
    action: AUDIT_ACTION.ZONE_DELETED,
    actor,
    before: { name: zone.name, displayOrder: zone.displayOrder },
    meta: { reason },
  });

  notifyFloor(zone);
  return zone;
}
