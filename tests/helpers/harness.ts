import {
  loginAll,
  makeApi,
  seedFixtures,
  startTestServer,
  type ApiResult,
  type TestContext,
} from './server.js';

/**
 * One-call setup for an integration file.
 *
 * Every integration test file boots its own server and re-seeds, so files are
 * independent and can be read (or run) in isolation:
 *
 *   const h = await createHarness();
 *   await h.close();
 *
 * Vitest runs them sequentially (maxWorkers: 1) because they share one database.
 */

export interface Harness {
  ctx: TestContext;
  api: ReturnType<typeof makeApi>;
  tokens: { admin: string; waiter: string; kitchen: string; billing: string };
  /** Table master rows, keyed by code — saves a lookup in every test. */
  tables: Record<string, { _id: string; code: string }>;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const ctx = await startTestServer();
  const api = makeApi(ctx.baseUrl);
  await seedFixtures();
  const tokens = await loginAll(api);

  const master = await api('GET', '/tables/master', { token: tokens.admin });
  const tables: Harness['tables'] = {};
  for (const table of master.data as { _id: string; code: string }[]) {
    tables[table.code] = table;
  }

  return { ctx, api, tokens, tables, close: ctx.close };
}

// ─── Scenario builders ───────────────────────────────────────────────────────

export interface OrderLine {
  productCode: string;
  quantity: number;
  specialInstructions?: string;
}

/** Places a customer order through the QR flow and returns the response. */
export function customerOrder(
  h: Harness,
  tableCode: string,
  items: OrderLine[],
  idempotencyKey?: string,
): Promise<ApiResult> {
  return h.api('POST', `/public/tables/${tableCode}/orders`, {
    body: { items, ...(idempotencyKey ? { idempotencyKey } : {}) },
  });
}

/**
 * Places a staff order on an existing session.
 *
 * `orderType` is omitted by default so every existing caller keeps exercising
 * the "absent means dining" path.
 */
export function waiterOrder(
  h: Harness,
  sessionId: string,
  items: OrderLine[],
  idempotencyKey?: string,
  orderType?: 'dining' | 'parcel',
): Promise<ApiResult> {
  return h.api('POST', `/sessions/${sessionId}/rounds`, {
    token: h.tokens.waiter,
    body: {
      items,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(orderType ? { orderType } : {}),
    },
  });
}

/** Finds the live KDS ticket for a session. */
export async function findTicket(h: Harness, sessionId: string) {
  const queue = await h.api('GET', '/kitchen/queue', { token: h.tokens.kitchen });
  return queue.data.tickets.find((ticket: any) => ticket.sessionId === sessionId);
}

/** Moves one item to a status as the kitchen. */
export function setItemStatus(
  h: Harness,
  roundId: string,
  itemId: string,
  status: string,
  token?: string,
  reason?: string,
): Promise<ApiResult> {
  return h.api('PATCH', `/rounds/${roundId}/items/${itemId}`, {
    token: token ?? h.tokens.kitchen,
    body: { status, ...(reason ? { reason } : {}) },
  });
}

/** Reads one tile off the live table grid. */
export async function tile(h: Harness, tableCode: string) {
  const grid = await h.api('GET', '/tables', { token: h.tokens.waiter });
  return grid.data.tables.find((entry: any) => entry.code === tableCode);
}

/** Drives a session all the way to "everything served", ready to bill. */
export async function serveEverything(h: Harness, sessionId: string): Promise<void> {
  const rounds = await h.api('GET', `/sessions/${sessionId}/rounds`, { token: h.tokens.waiter });
  for (const round of rounds.data as any[]) {
    for (const item of round.items) {
      if (item.status === 'cancelled' || item.status === 'served') continue;
      await setItemStatus(h, round._id, item._id, 'ready');
      await setItemStatus(h, round._id, item._id, 'served', h.tokens.waiter);
    }
  }
}

export type { ApiResult };
