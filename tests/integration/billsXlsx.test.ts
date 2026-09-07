import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, serveEverything, waiterOrder, type Harness } from '../helpers/harness.js';

/**
 * GET /billing/exports/xlsx — the Billed screen's Excel export.
 *
 * The behaviour worth pinning down is not the spreadsheet formatting but the
 * things that would quietly hand someone a wrong or incomplete set of numbers:
 * the route resolving at all (it shares a prefix with `/exports/:id`), the
 * paid/unpaid split, the date window, and who is allowed to ask.
 */

let h: Harness;
let paidBill = 0;

/** xlsx is a zip — every valid file starts with the local file header "PK\x03\x04". */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function download(query: string, token: string) {
  const response = await fetch(`${h.ctx.baseUrl}/billing/exports/xlsx${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
}

/** Bills one table end to end, optionally settling it. */
async function billOneTable(tableCode: string, key: string, settle: boolean): Promise<number> {
  const session = await h.api('POST', '/sessions', {
    token: h.tokens.waiter,
    body: { tableId: h.tables[tableCode]!._id },
  });
  const sessionId = session.data._id as string;

  await waiterOrder(h, sessionId, [{ productCode: 'BEV001', quantity: 2 }], key);
  await serveEverything(h, sessionId);

  const exported = await h.api('POST', `/billing/${sessionId}/export`, {
    token: h.tokens.billing,
    body: { method: 'manual_display' },
  });
  const record = exported.data.export;

  if (settle) {
    await h.api('PATCH', `/billing/exports/${record._id}`, {
      token: h.tokens.billing,
      body: { exportStatus: 'confirmed' },
    });
  }
  return record.billNumber as number;
}

beforeAll(async () => {
  h = await createHarness();
  paidBill = await billOneTable('M2', 'xlsx-paid', true);
  await billOneTable('R1', 'xlsx-unpaid', false);
});

afterAll(async () => {
  await h.close();
});

describe('the route itself', () => {
  /*
   * The regression this file exists for. `/exports/xlsx` and `/exports/:id`
   * share a prefix, so if the id route is registered first Express treats
   * "xlsx" as an export id and the ObjectId validator answers 400.
   */
  it('is not swallowed by the /exports/:id route', async () => {
    const result = await download('', h.tokens.billing);
    expect(result.status).toBe(200);
  });

  it('returns a real xlsx file, not JSON', async () => {
    const result = await download('', h.tokens.billing);

    expect(result.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect(result.headers.get('content-disposition')).toContain('.xlsx');
    // A zip container — the one check that proves it is openable at all.
    expect(result.body.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
    expect(result.body.length).toBeGreaterThan(1000);
  });
});

describe('who may export', () => {
  it('lets billing download it', async () => {
    expect((await download('', h.tokens.billing)).status).toBe(200);
  });

  it('lets an admin download it', async () => {
    expect((await download('', h.tokens.admin)).status).toBe(200);
  });

  /*
   * A waiter may read one table's bills — they answer "what was M2 charged?"
   * at the table — but a spreadsheet of every bill and what is still unpaid is
   * a management question.
   */
  it('refuses a waiter', async () => {
    expect((await download('', h.tokens.waiter)).status).toBe(403);
  });

  it('refuses an anonymous request', async () => {
    const response = await fetch(`${h.ctx.baseUrl}/billing/exports/xlsx`);
    expect(response.status).toBe(401);
  });
});

describe('filters', () => {
  it('accepts the paid-only split', async () => {
    const result = await download('?settled=true', h.tokens.billing);
    expect(result.status).toBe(200);
    expect(result.body.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('accepts the unsettled-only split', async () => {
    const result = await download('?settled=false', h.tokens.billing);
    expect(result.status).toBe(200);
  });

  it('accepts a date range', async () => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 86_400_000).toISOString();
    expect((await download(`?from=${from}&to=${to}`, h.tokens.billing)).status).toBe(200);
  });

  it('still produces a workbook when the range matches nothing', async () => {
    // 2001 — long before any bill exists. An empty sheet, not a 404: the
    // counter asked a valid question and the answer is "no bills".
    const result = await download('?from=2001-01-01&to=2001-01-02', h.tokens.billing);
    expect(result.status).toBe(200);
    expect(result.body.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('rejects a non-boolean settled', async () => {
    const result = await download('?settled=maybe', h.tokens.billing);
    expect(result.status).toBe(400);
  });

  it('rejects a malformed date', async () => {
    expect((await download('?from=last-tuesday', h.tokens.billing)).status).toBe(400);
  });
});

describe('the underlying split', () => {
  /*
   * Asserted through the JSON list rather than by parsing the workbook: both
   * read the same `listExports` filter, and the list is the shape a test can
   * make claims about. If this split is wrong the spreadsheet is wrong too.
   */
  it('separates paid from unsettled', async () => {
    const paid = await h.api('GET', '/billing/exports?settled=true&limit=100', {
      token: h.tokens.billing,
    });
    const unpaid = await h.api('GET', '/billing/exports?settled=false&limit=100', {
      token: h.tokens.billing,
    });

    const paidNumbers = (paid.data as any[]).map((b) => b.billNumber);
    const unpaidNumbers = (unpaid.data as any[]).map((b) => b.billNumber);

    expect(paidNumbers).toContain(paidBill);
    expect(unpaidNumbers).not.toContain(paidBill);
    expect((paid.data as any[]).every((b) => b.exportStatus === 'confirmed')).toBe(true);
    expect((unpaid.data as any[]).every((b) => b.exportStatus !== 'confirmed')).toBe(true);
  });
});
