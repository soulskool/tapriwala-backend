import mongoose, { type Types } from 'mongoose';

import { AUDIT_ACTION, AUDIT_ENTITY, DEFAULT_ZONE_NAMES } from '../config/constants.js';
import { syncIndexes } from '../config/db.js';
import { assertEnv, env } from '../config/env.js';
import { ProductMaster, TableMaster, User, Zone } from '../models/index.js';
import * as auditService from '../services/audit.service.js';
import { SYSTEM_ACTOR } from '../utils/actor.js';
import { logger } from '../utils/logger.js';

/**
 * One-off migration for managed zones and soft delete.
 *
 *   npm run migrate:zones                 — dry run: prints the plan, writes nothing
 *   npm run migrate:zones -- --apply      — does it
 *
 * Run it BEFORE deploying the backend that reads `zoneId`. Everything it does
 * is additive, so the release still running keeps working afterwards:
 *
 *   1. Makes a Zone for every zone name the tables use today ("Left", "Lawn"…),
 *      in floor order, and audits each one as `system`.
 *   2. Points each table at its zone (`zoneId`). The old `zone` text is left on
 *      the table, unread, so rolling back to the previous release still works.
 *   3. Writes `isDeleted: false` on every table, product and staff account.
 *      The unique indexes on table code, product code and phone only cover
 *      records that carry it.
 *   4. Rebuilds the indexes: drops the old all-records unique indexes and
 *      builds the live-records-only ones (see models/softDelete.ts).
 *
 * Safe to run twice: the second run finds nothing to do. Safe against a table
 * created by the old release between this run and the deploy — run it again.
 */

const APPLY = process.argv.includes('--apply');

/** "Left" before "Lawn": the seed's floor order first, anything else after, A–Z. */
function floorOrder(a: string, b: string): number {
  const rank = (name: string) => {
    const index = (DEFAULT_ZONE_NAMES as readonly string[]).indexOf(name);
    return index === -1 ? DEFAULT_ZONE_NAMES.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

async function planAndApplyZones(): Promise<void> {
  // The raw collection, because the schema no longer declares `zone`.
  const tables = await TableMaster.collection
    .find({}, { projection: { code: 1, zone: 1, zoneId: 1, isDeleted: 1 } })
    .toArray();

  const unlinked = tables.filter((table) => !table.zoneId);
  logger.info(`Tables: ${tables.length} total, ${unlinked.length} without a zoneId`);

  const orphans = unlinked.filter((table) => typeof table.zone !== 'string' || !table.zone.trim());
  if (orphans.length > 0) {
    // Nothing to link them to. They will show with a blank zone until an admin
    // edits them; listed so that is a decision, not a surprise.
    logger.warn(
      `No zone name at all on: ${orphans.map((table) => String(table.code)).join(', ')} — set it on the Tables page after the deploy`,
    );
  }

  const names = [
    ...new Set(
      unlinked
        .map((table) => (typeof table.zone === 'string' ? table.zone.trim() : ''))
        .filter(Boolean),
    ),
  ].sort(floorOrder);

  // Existing live zones, matched without regard to case like the unique index.
  const existing = await Zone.collection
    .find({ isDeleted: { $ne: true } }, { projection: { name: 1, displayOrder: 1 } })
    .toArray();
  const idByName = new Map<string, Types.ObjectId>(
    existing.map((zone) => [String(zone.name).toLowerCase(), zone._id]),
  );
  let nextOrder = Math.max(0, ...existing.map((zone) => Number(zone.displayOrder) || 0)) + 1;

  for (const name of names) {
    if (idByName.has(name.toLowerCase())) {
      logger.info(`  zone "${name}" already exists`);
      continue;
    }
    logger.info(`  ${APPLY ? 'creating' : 'would create'} zone "${name}" (order ${nextOrder})`);
    if (APPLY) {
      const zone = await Zone.create({ name, displayOrder: nextOrder });
      idByName.set(name.toLowerCase(), zone._id);
      await auditService.record({
        entityType: AUDIT_ENTITY.ZONE,
        entityId: zone._id,
        action: AUDIT_ACTION.ZONE_CREATED,
        actor: SYSTEM_ACTOR,
        after: { name: zone.name, displayOrder: zone.displayOrder },
        meta: { script: 'migrate:zones' },
      });
    }
    nextOrder += 1;
  }

  let linked = 0;
  for (const name of names) {
    const codes = unlinked
      .filter((table) => typeof table.zone === 'string' && table.zone.trim() === name)
      .map((t) => String(t.code));
    logger.info(
      `  ${APPLY ? 'linking' : 'would link'} ${codes.length} table(s) to "${name}": ${codes.join(', ')}`,
    );
    if (!APPLY) continue;
    const zoneId = idByName.get(name.toLowerCase());
    const result = await TableMaster.collection.updateMany(
      { zoneId: { $exists: false }, zone: name },
      { $set: { zoneId } },
    );
    linked += result.modifiedCount;
  }
  if (APPLY) logger.info(`Linked ${linked} table(s)`);
}

/** Every record gets `isDeleted: false`, so the partial unique indexes cover it. */
async function backfillSoftDelete(): Promise<void> {
  const fields = { isDeleted: false, deletedAt: null, deletedBy: null, deleteReason: '' };
  const models = [
    ['tables', TableMaster],
    ['products', ProductMaster],
    ['staff accounts', User],
    ['zones', Zone],
  ] as const;

  for (const [label, model] of models) {
    const missing = { isDeleted: { $exists: false } };
    const count = await model.collection.countDocuments(missing);
    if (count === 0) continue;
    logger.info(`  ${APPLY ? 'marking' : 'would mark'} ${count} ${label} as not deleted`);
    if (APPLY) await model.collection.updateMany(missing, { $set: fields });
  }
}

/**
 * Two live records sharing a key would make the new unique index fail to
 * build. The old indexes made that impossible, but it is checked, not assumed.
 */
async function assertNoDuplicates(): Promise<void> {
  const checks = [
    ['table code', TableMaster, '$code'],
    ['product code', ProductMaster, '$productCode'],
    ['phone', User, '$phone'],
  ] as const;

  for (const [label, model, key] of checks) {
    const duplicates = await model.collection
      .aggregate<{ _id: string; count: number }>([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: key, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();
    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate ${label}(s): ${duplicates.map((d) => d._id).join(', ')}. Fix these before migrating.`,
      );
    }
  }
}

async function main(): Promise<void> {
  assertEnv();

  // No automatic index builds or collection creation: a dry run must write
  // nothing at all, and on a real run the indexes are rebuilt explicitly last.
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false,
    autoCreate: false,
  });

  const { host, name } = mongoose.connection;
  logger.info(`${APPLY ? 'APPLYING to' : 'Dry run against'} database "${name}" on ${host}`);

  await assertNoDuplicates();
  await planAndApplyZones();
  await backfillSoftDelete();

  if (APPLY) {
    await syncIndexes();
    logger.info('Migration complete. Now deploy the backend, then the frontend.');
  } else {
    logger.info('Dry run only — nothing was written. Re-run with --apply to do it.');
  }

  await mongoose.disconnect();
}

main().catch(async (error: Error) => {
  logger.error(`Zones migration failed: ${error.message}`, { stack: error.stack });
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
