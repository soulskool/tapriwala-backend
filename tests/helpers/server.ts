import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';

import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { KITCHEN_STATIONS, ROLES } from '../../src/config/constants.js';
import {
  AuditLog,
  BillingExport,
  Counter,
  OrderRound,
  ProductMaster,
  ServiceRequest,
  TableMaster,
  Zone,
  TableSession,
  User,
  hashPin,
} from '../../src/models/index.js';
import { initSocketServer } from '../../src/sockets/index.js';

/**
 * Boots the real server (HTTP + Socket.IO) on an ephemeral port against a
 * dedicated test database, then tears it down.
 *
 * Nothing is stubbed. These tests exercise the same code path a waiter's phone
 * does, which is the only way to prove things like "five simultaneous table
 * opens create exactly one session" — that guarantee lives in a MongoDB index,
 * not in application code.
 */

// `||` not `??`: an empty MONGO_URI_TEST must fall back, not be used.
const configuredTestUri = process.env.MONGO_URI_TEST?.trim();
const TEST_URI =
  configuredTestUri && configuredTestUri.length > 0
    ? configuredTestUri
    : 'mongodb://127.0.0.1:27017/acd_cafe_test';

/**
 * Refuses to run against anything not obviously a test database.
 * These helpers call deleteMany({}) — pointing them at the live café database
 * would erase the day's trading.
 */
function assertSafeTestUri(uri: string): void {
  const dbName = uri.split('/').pop()?.split('?')[0] ?? '';
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${dbName}" — the test database name must end with "_test". ` +
        `Set MONGO_URI_TEST (currently: ${uri}).`,
    );
  }
}

export interface TestContext {
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestContext> {
  assertSafeTestUri(TEST_URI);

  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 10_000 });

  const app = createApp();
  const server = http.createServer(app);
  const io = initSocketServer(server);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  // The local driver builds absolute image URLs from publicBaseUrl; point it at
  // the ephemeral port so an uploaded image is genuinely fetchable here.
  (env as unknown as Record<string, unknown>).publicBaseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    wsUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await io.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    },
  };
}

/** Wipes every collection. Called between suites so tests never inherit state. */
export async function resetDatabase(): Promise<void> {
  await Promise.all([
    OrderRound.deleteMany({}),
    TableSession.deleteMany({}),
    ServiceRequest.deleteMany({}),
    BillingExport.deleteMany({}),
    AuditLog.deleteMany({}),
    Counter.deleteMany({}),
    ProductMaster.deleteMany({}),
    TableMaster.deleteMany({}),
    User.deleteMany({}),
    Zone.deleteMany({}),
  ]);
}

export const TEST_USERS = {
  admin: { name: 'Test Admin', phone: '9999999999', role: ROLES.ADMIN, pin: '1234' },
  waiter: { name: 'Test Waiter', phone: '9000000001', role: ROLES.WAITER, pin: '1111' },
  kitchen: { name: 'Test Kitchen', phone: '9000000002', role: ROLES.KITCHEN, pin: '2222' },
  billing: { name: 'Test Billing', phone: '9000000003', role: ROLES.BILLING, pin: '3333' },
  superAdmin: {
    name: 'Test Super Admin',
    phone: '9000000007',
    role: ROLES.SUPER_ADMIN,
    pin: '7777',
  },
  viewer: { name: 'Test Viewer', phone: '9000000008', role: ROLES.ADMIN_VIEWER, pin: '8888' },
} as const;

export type TestUserKey = keyof typeof TEST_USERS;

/** Minimal fixture set: enough tables to test transfers, enough menu to test billing. */
export async function seedFixtures(): Promise<void> {
  await resetDatabase();
  // Indexes must exist before the concurrency tests run — they are the thing
  // under test.
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));

  const zones = await Zone.insertMany(
    ['Left', 'Middle', 'Right', 'Veranda'].map((name, index) => ({
      name,
      displayOrder: index + 1,
    })),
  );
  const zoneId = (name: string) => zones.find((zone) => zone.name === name)!._id;

  const tables = [
    { code: 'M1', zoneId: zoneId('Middle'), displayOrder: 1 },
    { code: 'M2', zoneId: zoneId('Middle'), displayOrder: 2 },
    { code: 'R1', zoneId: zoneId('Right'), displayOrder: 1 },
    { code: 'R4', zoneId: zoneId('Right'), displayOrder: 4 },
    { code: 'L5', zoneId: zoneId('Left'), displayOrder: 5 },
    { code: 'V1', zoneId: zoneId('Veranda'), displayOrder: 1 },
  ];
  await TableMaster.insertMany(tables.map((table) => ({ ...table, seatingCapacity: 4 })));

  await ProductMaster.insertMany([
    {
      productCode: 'BEV001',
      posName: 'TEA',
      displayName: 'Masala Tea',
      category: 'Beverages',
      price: 30,
      taxPercent: 5,
      kitchenStation: KITCHEN_STATIONS.BEVERAGE,
    },
    {
      productCode: 'BEV002',
      posName: 'COFFEE',
      displayName: 'Filter Coffee',
      category: 'Beverages',
      price: 50,
      taxPercent: 5,
      kitchenStation: KITCHEN_STATIONS.BEVERAGE,
    },
    {
      productCode: 'BEV003',
      posName: 'COLD COFFEE',
      displayName: 'Cold Coffee',
      category: 'Beverages',
      price: 120,
      taxPercent: 5,
      kitchenStation: KITCHEN_STATIONS.BEVERAGE,
    },
    {
      productCode: 'SNK001',
      posName: 'VEG SANDWICH',
      displayName: 'Grilled Veg Sandwich',
      category: 'Snacks',
      price: 140,
      taxPercent: 5,
      kitchenStation: KITCHEN_STATIONS.KITCHEN,
    },
    {
      productCode: 'DST001',
      posName: 'CHOCO BROWNIE',
      displayName: 'Chocolate Brownie',
      category: 'Desserts',
      price: 150,
      taxPercent: 5,
      kitchenStation: KITCHEN_STATIONS.KITCHEN,
    },
  ]);

  for (const user of Object.values(TEST_USERS)) {
    await User.create({
      name: user.name,
      phone: user.phone,
      role: user.role,
      pinHash: await hashPin(user.pin),
    });
  }
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

export interface ApiOptions {
  token?: string;
  body?: unknown;
  tableCode?: string;
}

export interface ApiResult {
  status: number;
  success?: boolean;
  message?: string;
  data?: any;
  meta?: { pagination?: Record<string, number | boolean> };
  error?: { code: string; message: string; details?: any };
}

/** Thin fetch wrapper mirroring how the frontends will call the API. */
export function makeApi(baseUrl: string) {
  return async function api(
    method: string,
    path: string,
    options: ApiOptions = {},
  ): Promise<ApiResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.tableCode) headers['x-table-code'] = options.tableCode;

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const json = (await response.json().catch(() => ({}))) as Omit<ApiResult, 'status'>;
    return { status: response.status, ...json };
  };
}

/** Logs in every test user — one per role — and returns their tokens. */
export async function loginAll(api: ReturnType<typeof makeApi>) {
  const tokens: Record<string, string> = {};
  for (const [key, user] of Object.entries(TEST_USERS)) {
    const result = await api('POST', '/auth/login', {
      body: { phone: user.phone, pin: user.pin },
    });
    tokens[key] = result.data.token as string;
  }
  return tokens as Record<TestUserKey, string>;
}
