import mongoose from 'mongoose';

import { DEFAULT_ZONE_NAMES, ROLES, ROLE_VALUES } from '../config/constants.js';
import { connectDB, disconnectDB, syncIndexes } from '../config/db.js';
import { assertEnv, env } from '../config/env.js';
import {
  AuditLog,
  BillingExport,
  Counter,
  OrderRound,
  ProductMaster,
  ServiceRequest,
  TableMaster,
  TableSession,
  User,
  Zone,
  hashPin,
  NOT_DELETED,
} from '../models/index.js';
import { logger } from '../utils/logger.js';
import { qrUrl } from '../services/table.service.js';

/**
 * Development seed.
 *
 *   npm run seed          — create anything missing, leave existing data alone
 *   npm run seed:reset    — wipe operational data first (never run in prod)
 *
 * Table codes follow the floor plan in the master plan (L/M/R/Veranda/Outdoor).
 * Veranda codes are placeholders until the final naming is confirmed.
 */

const TABLES = [
  ...['L1', 'L2', 'L3', 'L4', 'L5'].map((code, index) => ({
    code,
    zone: 'Left',
    displayOrder: index + 1,
    seatingCapacity: 4,
  })),
  ...['M1', 'M2', 'M3', 'M4'].map((code, index) => ({
    code,
    zone: 'Middle',
    displayOrder: index + 1,
    seatingCapacity: 4,
  })),
  ...['R1', 'R2', 'R3', 'R4'].map((code, index) => ({
    code,
    zone: 'Right',
    displayOrder: index + 1,
    seatingCapacity: 4,
  })),
  ...['V1', 'V2', 'V3'].map((code, index) => ({
    code,
    zone: 'Veranda',
    displayOrder: index + 1,
    seatingCapacity: 6,
  })),
  ...['O1', 'O2', 'O3', 'O4'].map((code, index) => ({
    code,
    zone: 'Lawn',
    displayOrder: index + 1,
    seatingCapacity: 6,
  })),
];

/**
 * One login per role, so every screen is reachable straight after seeding.
 *
 * The assertion below is the point: if a fifth role is ever added to ROLE_VALUES
 * (a manager, a barista) and nobody adds a seed user for it, the seed fails
 * loudly rather than leaving that role untestable.
 */
const USERS = [
  // The owner's own login, from .env, is the super admin: on a fresh database
  // somebody has to be able to create the rest of the staff. On a database
  // that already has this phone, the seed changes nothing (see seedUsers).
  {
    name: 'Cafe Admin',
    phone: env.seedAdminPhone,
    role: ROLES.SUPER_ADMIN,
    pin: env.seedAdminPin,
  },
  { name: 'Waiter One', phone: '9000000001', role: ROLES.WAITER, pin: '1111' },
  { name: 'Kitchen Display', phone: '9000000002', role: ROLES.KITCHEN, pin: '2222' },
  { name: 'Billing Counter', phone: '9000000003', role: ROLES.BILLING, pin: '3333' },
  { name: 'Manager', phone: '9000000004', role: ROLES.ADMIN, pin: '4444' },
  { name: 'Owner View', phone: '9000000005', role: ROLES.ADMIN_VIEWER, pin: '5555' },
];

function assertEveryRoleSeeded(): void {
  const seeded = new Set(USERS.map((user) => user.role));
  const missing = ROLE_VALUES.filter((role) => !seeded.has(role));

  if (missing.length > 0) {
    throw new Error(
      `No seed user for role(s): ${missing.join(', ')}. Add one to USERS in src/scripts/seed.ts.`,
    );
  }
}

/**
 * True when MONGO_URI points at this machine. NODE_ENV alone is not enough of
 * a guard: a laptop .env with NODE_ENV=development and a copied production
 * MONGO_URI would otherwise wipe the live café with one command.
 */
function isLocalDatabase(uri: string): boolean {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  const hosts = (match?.[1] ?? '').split(',').map((host) => host.replace(/:\d+$/, ''));
  return (
    hosts.length > 0 &&
    hosts.every((host) => ['localhost', '127.0.0.1', '::1', '[::1]', 'mongo'].includes(host))
  );
}

async function reset(): Promise<void> {
  if (env.isProduction) {
    throw new Error('Refusing to reset data with NODE_ENV=production');
  }
  if (!isLocalDatabase(env.mongoUri) && process.env.ALLOW_REMOTE_RESET !== 'true') {
    throw new Error(
      'Refusing to reset a database that is not on this machine. MONGO_URI points at a remote ' +
        'host. Set ALLOW_REMOTE_RESET=true for this one command if you really mean it.',
    );
  }
  logger.warn('Resetting operational collections');
  // BillingExport and AuditLog must go with the counters: bill numbers are a
  // forever-unique sequence, so rewinding the counter while old bills remain
  // would collide on the next export.
  await Promise.all([
    OrderRound.deleteMany({}),
    TableSession.deleteMany({}),
    ServiceRequest.deleteMany({}),
    BillingExport.deleteMany({}),
    AuditLog.deleteMany({}),
    Counter.deleteMany({}),
  ]);
}

/**
 * The default zones, only on a database that has none. Once an admin has
 * renamed or deleted one, re-running the seed must not bring it back.
 */
async function seedZones(): Promise<Map<string, mongoose.Types.ObjectId>> {
  if ((await Zone.countDocuments(NOT_DELETED)) === 0) {
    await Zone.insertMany(
      DEFAULT_ZONE_NAMES.map((name, index) => ({ name, displayOrder: index + 1 })),
    );
    logger.info(`Seeded ${DEFAULT_ZONE_NAMES.length} zones`);
  }
  const zones = await Zone.find(NOT_DELETED).select('name').lean();
  return new Map(zones.map((zone) => [zone.name, zone._id]));
}

async function seedTables(zoneIds: Map<string, mongoose.Types.ObjectId>): Promise<void> {
  let created = 0;
  for (const { zone, ...table } of TABLES) {
    const zoneId = zoneIds.get(zone);
    if (!zoneId) continue; // the admin deleted or renamed this default zone
    // Insert-only, by live code: re-running never duplicates a table and never
    // undoes an admin's edit to one.
    const result = await TableMaster.updateOne(
      { code: table.code, ...NOT_DELETED },
      { $setOnInsert: { ...table, zoneId, isActive: true } },
      { upsert: true },
    );
    created += result.upsertedCount;
  }
  logger.info(`Seeded ${created} new tables (${TABLES.length} in the plan)`);
}

/**
 * The menu is NOT seeded.
 *
 * It comes from the café's own POS item sheet via `npm run import:products`,
 * which is the only place the real 300+ products, their prices and their tax
 * rates exist. Seeding a placeholder menu here used to quietly re-create ten
 * fake products every time somebody ran the seed, which then showed up on a
 * guest's phone next to the real ones.
 */
async function warnIfMenuEmpty(): Promise<void> {
  const count = await ProductMaster.countDocuments({ isActive: true });
  if (count > 0) {
    logger.info(`Menu has ${count} active products`);
    return;
  }
  logger.warn('No products in the menu. Import the POS sheet:');
  logger.warn('  npm run import:products -- --file "<item sheet>.xlsx" --dry-run');
}

async function seedUsers(): Promise<void> {
  for (const user of USERS) {
    const existing = await User.findOne({ phone: user.phone, ...NOT_DELETED })
      .select('_id')
      .lean();
    if (existing) continue;
    await User.create({
      name: user.name,
      phone: user.phone,
      role: user.role,
      pinHash: await hashPin(user.pin),
    });
    logger.info(`Created ${user.role}: ${user.name} (${user.phone})`);
    // The PIN goes to the terminal of whoever ran the seed, never into the
    // log files, which outlive the session and get copied around.
    process.stdout.write(
      `    PIN for ${user.phone}: ${user.pin}  <- change it before going live\n`,
    );
  }
}

async function printQrSheet(): Promise<void> {
  const tables = await TableMaster.find({ isActive: true, ...NOT_DELETED })
    .sort({ code: 1 })
    .lean();
  logger.info('QR URLs to print:');
  for (const table of tables) {
    logger.info(`  ${table.code.padEnd(4)} ${qrUrl(table.code)}`);
  }
}

async function main(): Promise<void> {
  assertEnv();
  assertEveryRoleSeeded();
  await connectDB();
  await syncIndexes();

  if (process.argv.includes('--reset')) await reset();

  await seedTables(await seedZones());
  await warnIfMenuEmpty();
  await seedUsers();
  await printQrSheet();

  logger.info('Seed complete');
  await disconnectDB();
  await mongoose.disconnect();
}

main().catch((error: Error) => {
  logger.error(`Seed failed: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
