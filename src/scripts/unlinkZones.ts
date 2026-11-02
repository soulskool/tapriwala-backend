import mongoose from 'mongoose';

import { AUDIT_ACTION, AUDIT_ENTITY } from '../config/constants.js';
import { assertEnv, env } from '../config/env.js';
import { NOT_DELETED, TableMaster, Zone } from '../models/index.js';
import * as auditService from '../services/audit.service.js';
import { SYSTEM_ACTOR } from '../utils/actor.js';
import { logger } from '../utils/logger.js';

/**
 * TEMPORARY — a demo reset, the exact reverse of `migrate:zones`.
 *
 *   npm run zones:unlink                 — dry run: prints the plan, writes nothing
 *   npm run zones:unlink -- --apply      — does it
 *
 * Takes every table out of its zone and deletes the zones, so the owner sees
 * the Tables page as it would be with no zones set up: add zones first, then
 * assign each table by hand.
 *
 * To put everything back in one step:
 *
 *   npm run migrate:zones -- --apply
 *
 * That works because each table still carries its original zone name as text
 * (the `zone` field the migration left in place), and this script never
 * touches it. Zones the owner created in the meantime are reused by name, and
 * tables the owner already assigned are left exactly as they are.
 *
 * Nothing is removed: zones are soft-deleted and each is audit-logged as
 * `system`, like any other delete. Orders, sessions and bills are not touched.
 *
 * Delete this script once the demo is over.
 */

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  assertEnv();
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false,
    autoCreate: false,
  });

  const { host, name } = mongoose.connection;
  logger.info(`${APPLY ? 'APPLYING to' : 'Dry run against'} database "${name}" on ${host}`);

  const tables = await TableMaster.collection
    .find(
      { isDeleted: { $ne: true }, zoneId: { $exists: true } },
      { projection: { code: 1, zone: 1 } },
    )
    .toArray();
  const zones = await Zone.find(NOT_DELETED).sort({ displayOrder: 1 });

  // The restore reads this text. A table without it would come back zoneless.
  const noText = tables.filter((table) => typeof table.zone !== 'string' || !table.zone.trim());
  if (noText.length > 0) {
    logger.warn(
      `These tables have no original zone name, so migrate:zones cannot put them back automatically: ${noText.map((t) => String(t.code)).join(', ')}`,
    );
  }

  logger.info(
    `  ${APPLY ? 'removing' : 'would remove'} the zone from ${tables.length} table(s): ${tables.map((t) => String(t.code)).join(', ')}`,
  );
  logger.info(
    `  ${APPLY ? 'deleting' : 'would delete'} ${zones.length} zone(s): ${zones.map((z) => z.name).join(', ')}`,
  );

  if (!APPLY) {
    logger.info('Dry run only — nothing was written. Re-run with --apply to do it.');
    await mongoose.disconnect();
    return;
  }

  await TableMaster.collection.updateMany(
    { isDeleted: { $ne: true }, zoneId: { $exists: true } },
    { $unset: { zoneId: '' } },
  );

  for (const zone of zones) {
    zone.isDeleted = true;
    zone.deletedAt = new Date();
    zone.deletedBy = { role: SYSTEM_ACTOR.role, userId: null, name: SYSTEM_ACTOR.name };
    zone.deleteReason = 'zones:unlink demo reset';
    await zone.save();
    await auditService.record({
      entityType: AUDIT_ENTITY.ZONE,
      entityId: zone._id,
      action: AUDIT_ACTION.ZONE_DELETED,
      actor: SYSTEM_ACTOR,
      before: { name: zone.name, displayOrder: zone.displayOrder },
      meta: { reason: 'zones:unlink demo reset', script: 'zones:unlink' },
    });
  }

  logger.info('Done. To put every table back in its zone: npm run migrate:zones -- --apply');
  await mongoose.disconnect();
}

main().catch(async (error: Error) => {
  logger.error(`zones:unlink failed: ${error.message}`, { stack: error.stack });
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
