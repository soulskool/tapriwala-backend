import mongoose from 'mongoose';

import { ROLES, ROLE_VALUES, TABLE_ZONES } from '../config/constants.js';
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
  hashPin,
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
    zone: TABLE_ZONES.LEFT,
    displayOrder: index + 1,
    seatingCapacity: 4,
  })),
  ...['M1', 'M2', 'M3', 'M4'].map((code, index) => ({
    code,
    zone: TABLE_ZONES.MIDDLE,
    displayOrder: index + 1,
    seatingCapacity: 4,
  })),
  ...['R1', 'R2', 'R3', 'R4'].map((code, index) => ({
    code,
    zone: TABLE_ZONES.RIGHT,
    displayOrder: index + 1,
    seatingCapacity: 4,
  })),
  ...['V1', 'V2', 'V3'].map((code, index) => ({
    code,
    zone: TABLE_ZONES.VERANDA,
    displayOrder: index + 1,
    seatingCapacity: 6,
  })),
  ...['O1', 'O2', 'O3', 'O4'].map((code, index) => ({
    code,
    zone: TABLE_ZONES.LAWN,
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
  { name: 'Cafe Admin', phone: env.seedAdminPhone, role: ROLES.ADMIN, pin: env.seedAdminPin },
  { name: 'Waiter One', phone: '9000000001', role: ROLES.WAITER, pin: '1111' },
  { name: 'Kitchen Display', phone: '9000000002', role: ROLES.KITCHEN, pin: '2222' },
  { name: 'Billing Counter', phone: '9000000003', role: ROLES.BILLING, pin: '3333' },
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

async function reset(): Promise<void> {
  if (env.isProduction) {
    throw new Error('Refusing to reset data with NODE_ENV=production');
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

async function seedTables(): Promise<void> {
  for (const table of TABLES) {
    // Upsert by code so re-running never duplicates a table or rotates a QR
    // token that is already printed and stuck to a table.
    await TableMaster.updateOne(
      { code: table.code },
      { $set: table, $setOnInsert: { isActive: true } },
      { upsert: true },
    );
  }
  logger.info(`Seeded ${TABLES.length} tables`);
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
    const existing = await User.findOne({ phone: user.phone }).select('_id').lean();
    if (existing) continue;
    await User.create({
      name: user.name,
      phone: user.phone,
      role: user.role,
      pinHash: await hashPin(user.pin),
    });
    logger.info(`Created ${user.role}: ${user.name} (${user.phone} / PIN ${user.pin})`);
  }
}

async function printQrSheet(): Promise<void> {
  const tables = await TableMaster.find({ isActive: true })
    .sort({ zone: 1, displayOrder: 1 })
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

  await seedTables();
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
