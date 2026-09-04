import { existsSync } from 'node:fs';

import ExcelJS from 'exceljs';
import mongoose from 'mongoose';

import { KITCHEN_STATIONS, type KitchenStation } from '../config/constants.js';
import { connectDB, disconnectDB, syncIndexes } from '../config/db.js';
import { assertEnv } from '../config/env.js';
import { OrderRound, ProductMaster } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { SYSTEM_ACTOR } from '../utils/actor.js';
import * as auditService from '../services/audit.service.js';
import { AUDIT_ACTION, AUDIT_ENTITY } from '../config/constants.js';

/**
 * Imports the real Product Master from the POS item sheet.
 *
 *   npm run menu:check      — report what would change, write nothing
 *   npm run menu:import     — apply it
 *   npm run menu:import -- --purge          — also delete never-ordered strays
 *   npm run menu:import -- --file "<other.xlsx>"   — a sheet from somewhere else
 *
 * With no --file it reads `backend/data/menu.xlsx`, so updating the menu means
 * replacing that one file and running the command again.
 *
 * Written to be re-run. The POS sheet is the source of truth for price and tax,
 * so when the café re-prices, you export a fresh sheet and run this again: every
 * matched `productCode` is updated in place, and history is untouched because
 * rounds snapshot their own price at order time.
 *
 * `--dry-run` prints the full report and writes nothing. Run it first, every
 * time — this replaces the entire menu, and the source sheet has real data
 * problems in it (see the WARNINGS section of the report).
 */

// ─── Column contract ─────────────────────────────────────────────────────────

/**
 * Read by header name, not by position, so a re-exported sheet with columns in
 * a different order still imports rather than silently loading prices into the
 * tax field.
 */
const COLUMNS = {
  name: 'Product Name',
  price: 'Default Price',
  category: 'Category Name',
  categoryNo: 'Category No',
  tax: 'Tax',
  searchCode: 'Search Code',
} as const;

// ─── Mapping rules ───────────────────────────────────────────────────────────

/**
 * Which station cooks a category.
 *
 * Anything not listed here goes to the Kitchen, which is the safe default: a
 * ticket appearing on the wrong board is a nuisance, a ticket appearing on no
 * board is a lost order.
 */
const BEVERAGE_CATEGORIES = new Set([
  'OUR SPECIAL TEA',
  'HOT BEVERAGES',
  'COLD BEVERAGES',
  'MILK SHAKES',
  'ICED TEA',
  'WANNA AVOID MILK',
  'REFRESHING COOLERS',
]);

/** Items nobody cooks — packaging and counter lines. */
const NON_COOKED_ITEMS = new Set(['PACKAGE', 'WATER', 'BONI SALE']);

/**
 * Expansions for the POS sheet's truncated names, used to build the customer-
 * facing `displayName`.
 *
 * Deliberately conservative: only tokens whose meaning is unambiguous from the
 * sheet itself. "C C", "CB", "PP" and friends are left alone and reported in
 * the review list instead — a wrong guess on a menu a guest reads is worse than
 * an abbreviation the admin fixes once in the products screen.
 *
 * Extend this map rather than hand-editing 300 products.
 */
const ABBREVIATIONS: Record<string, string> = {
  TW: 'Tapriwala',
  CUTT: 'Cutting',
  CUTTG: 'Cutting',
  CUT: 'Cutting',
  FUL: 'Full',
  SW: 'Sandwich',
  SWPLAIN: 'Sandwich Plain',
  SWPLAI: 'Sandwich Plain',
  SWPLA: 'Sandwich Plain',
  SWGRILL: 'Sandwich Grilled',
  SWGRIL: 'Sandwich Grilled',
  SWTOAS: 'Sandwich Toast',
  BBUTTER: 'Bread Butter',
  CHES: 'Cheese',
  CHESSE: 'Cheese',
  GRIL: 'Grilled',
  GRILL: 'Grilled',
  GRI: 'Grilled',
  TOAS: 'Toast',
  TOA: 'Toast',
  PLAI: 'Plain',
  PLA: 'Plain',
  FLAV: 'Flavour',
  FLA: 'Flavour',
  LGRASS: 'Lemongrass',
  CINN: 'Cinnamon',
  SPL: 'Special',
  BREA: 'Bread',
  EXOT: 'Exotic',
  SK: 'Shake',
  CHOC: 'Chocolate',
  CHOCHLATE: 'Chocolate',
  VEL: 'Velvet',
  KES: 'Kesar',
  GAR: 'Garlic',
  CAP: 'Capsicum',
  MURK: 'Murukku',
  MURUK: 'Murukku',
  CHE: 'Cheese',
  MAK: 'Makhani',
  IC: 'Ice Cream',
  TURMER: 'Turmeric',
  BUTER: 'Butter',
  CHUTNY: 'Chutney',
  CAPCICUM: 'Capsicum',
  PIZZ: 'Pizza',
  IN: 'Inch',
  '9IN': '9 Inch',
  '9INCH': '9 Inch',
  '12IN': '12 Inch',
  '12INCH': '12 Inch',
};

/** Tokens that are already words — never flagged as cryptic in the review list. */
const KNOWN_WORDS = new Set([
  'TEA',
  'PAV',
  'JAM',
  'HOT',
  'ICE',
  'RED',
  'NUT',
  'OAT',
  'DAL',
  'SEV',
  'PC',
  'ADD',
  'ALL',
  'ONE',
  'THE',
  'AND',
  'WITH',
  'IN',
  'MAC',
  'MEX',
  'BOM',
  'TAN',
  'PAN',
  'DAHI',
  'JAIN',
  'VEG',
  'FF',
  'IT',
  'TS',
  'CC',
  'CB',
  'PP',
  'BM',
  'BUN',
  'POP',
  'KIT',
  'KAT',
  'SUB',
  'CUP',
  'MAS',
  'N',
  'G',
  'M',
]);

// ─── Name shaping ────────────────────────────────────────────────────────────

/** Title-cases one token, expanding it first if the map knows it. */
function shapeToken(token: string): string {
  const upper = token.toUpperCase();
  const expanded = ABBREVIATIONS[upper];
  if (expanded) return expanded;
  if (/^\d/.test(token)) return upper;
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

/**
 * Builds the name a guest reads from the name the POS stores.
 *
 * `posName` keeps the sheet's exact text because that is what the counter has
 * to match in the billing software; this is the other half of that trade.
 */
function toDisplayName(posName: string): string {
  return posName.split(/\s+/).filter(Boolean).map(shapeToken).join(' ');
}

/** Categories are shouted in the sheet; the menu should not shout back. */
function toCategoryName(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word === '&' ? '&' : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(' ');
}

function stationFor(category: string, posName: string): KitchenStation {
  if (NON_COOKED_ITEMS.has(posName)) return KITCHEN_STATIONS.OTHER;
  if (BEVERAGE_CATEGORIES.has(category)) return KITCHEN_STATIONS.BEVERAGE;
  return KITCHEN_STATIONS.KITCHEN;
}

// ─── Sheet reading ───────────────────────────────────────────────────────────

interface SheetRow {
  rowNumber: number;
  posName: string;
  displayName: string;
  category: string;
  rawCategory: string;
  categoryNo: number;
  price: number;
  taxPercent: number;
  searchCode: string;
}

interface ImportPlan {
  rows: (SheetRow & { productCode: string; displayOrder: number })[];
  warnings: string[];
  review: string[];
}

/**
 * Flattens any cell to plain text.
 *
 * A sheet exported from a POS is rarely all plain strings: prices arrive as
 * numbers, edited names as rich text, and a re-saved sheet can turn a column
 * into formulas. Each shape is unwrapped explicitly rather than coerced,
 * because `String(someObject)` would quietly import "[object Object]" as a
 * product name.
 */
function cellText(row: ExcelJS.Row, column: number): string {
  const value: ExcelJS.CellValue = row.getCell(column).value;

  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();

  if ('richText' in value)
    return value.richText
      .map((run) => run.text)
      .join('')
      .trim();
  if ('formula' in value || 'sharedFormula' in value) {
    const cached: unknown = value.result;
    if (cached === null || cached === undefined) return '';
    if (typeof cached === 'string') return cached.trim();
    if (typeof cached === 'number' || typeof cached === 'boolean') return String(cached);
    return '';
  }
  if ('text' in value) return value.text.trim();

  // Hyperlink and error cells have no sensible text form for an import.
  return '';
}

function cellNumber(row: ExcelJS.Row, column: number): number {
  const text = cellText(row, column).replace(/,/g, '');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function readSheet(file: string): Promise<ImportPlan> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`No worksheet found in ${file}`);

  // Header → column index, so the sheet can be re-exported with columns moved.
  const header = sheet.getRow(1);
  const columnOf = new Map<string, number>();
  header.eachCell((_cell, index) => {
    const label = cellText(header, index);
    if (label) columnOf.set(label, index);
  });

  const missing = Object.values(COLUMNS).filter((label) => !columnOf.has(label));
  if (missing.length > 0) {
    throw new Error(
      `Sheet is missing expected column(s): ${missing.join(', ')}. ` +
        `Found: ${[...columnOf.keys()].join(', ')}`,
    );
  }

  const col = (key: keyof typeof COLUMNS): number => columnOf.get(COLUMNS[key])!;

  const rows: SheetRow[] = [];
  const warnings: string[] = [];
  const review: string[] = [];

  for (let n = 2; n <= sheet.rowCount; n += 1) {
    const row = sheet.getRow(n);
    const posName = cellText(row, col('name')).toUpperCase().replace(/\s+/g, ' ');
    if (!posName) continue;

    const price = cellNumber(row, col('price'));
    const taxPercent = cellNumber(row, col('tax'));
    const rawCategory = cellText(row, col('category')).toUpperCase();
    const categoryNo = cellNumber(row, col('categoryNo'));
    const searchCodeRaw = cellNumber(row, col('searchCode'));

    if (!Number.isFinite(price) || price < 0) {
      warnings.push(`row ${n}: "${posName}" has no usable price — SKIPPED`);
      continue;
    }
    if (!rawCategory) {
      warnings.push(`row ${n}: "${posName}" has no category — SKIPPED`);
      continue;
    }

    // A four-figure café item is nearly always a typo or a book-keeping line.
    if (price >= 1000) {
      warnings.push(`row ${n}: "${posName}" is priced ${price} — check this is real`);
    }
    if (!Number.isFinite(taxPercent) || taxPercent !== 5) {
      warnings.push(
        `row ${n}: "${posName}" has tax ${cellText(row, col('tax'))}% while the rest of the ` +
          `sheet is 5% — imported as-is, verify before billing`,
      );
    }

    // The POS truncates at 16 characters, so a name landing exactly there was
    // very likely cut short and should be re-typed in the admin screen.
    if (posName.length === 16) {
      review.push(`"${posName}" — looks truncated by the POS (exactly 16 chars)`);
    } else {
      const cryptic = posName
        .split(' ')
        .filter(
          (t) => t.length <= 3 && /^[A-Z]+$/.test(t) && !KNOWN_WORDS.has(t) && !ABBREVIATIONS[t],
        );
      if (cryptic.length > 0) {
        review.push(`"${posName}" — unexpanded: ${cryptic.join(', ')}`);
      }
    }

    rows.push({
      rowNumber: n,
      posName,
      displayName: toDisplayName(posName),
      category: toCategoryName(rawCategory),
      rawCategory,
      categoryNo: Number.isFinite(categoryNo) ? categoryNo : 999,
      price,
      taxPercent: Number.isFinite(taxPercent) ? taxPercent : 5,
      searchCode: Number.isFinite(searchCodeRaw) ? String(Math.round(searchCodeRaw)) : '',
    });
  }

  // ── Product codes ──────────────────────────────────────────────────────────
  // The POS search code is the natural key: it is what the counter types into
  // the billing software, which is exactly what `productCode` is for. It is not
  // actually unique in the source sheet, so collisions get a suffix and are
  // reported — the duplicate is a real problem in the POS, not something to
  // paper over here.
  const usedCodes = new Map<string, number>();
  const planned = rows.map((row) => {
    const base = row.searchCode || `X${row.rowNumber}`;
    const seen = usedCodes.get(base) ?? 0;
    usedCodes.set(base, seen + 1);

    if (seen > 0) {
      warnings.push(
        `row ${row.rowNumber}: "${row.posName}" reuses POS search code ${base} — ` +
          `imported as ${base}-${seen + 1}; fix the duplicate in the POS`,
      );
    }
    return { ...row, productCode: seen === 0 ? base : `${base}-${seen + 1}` };
  });

  // Menu order within a category follows the sheet. Categories themselves render
  // alphabetically — `getMenu` sorts by category name, so Category No cannot
  // drive their order without a schema change.
  const perCategory = new Map<string, number>();
  const withOrder = planned.map((row) => {
    const index = (perCategory.get(row.category) ?? 0) + 1;
    perCategory.set(row.category, index);
    return { ...row, displayOrder: index };
  });

  // Same item entered twice under one name is a menu bug the guest will see.
  const byName = new Map<string, SheetRow[]>();
  for (const row of withOrder) {
    byName.set(row.posName, [...(byName.get(row.posName) ?? []), row]);
  }
  for (const [name, group] of byName) {
    if (group.length > 1) {
      warnings.push(
        `"${name}" appears ${group.length}× (rows ${group.map((g) => g.rowNumber).join(', ')}; ` +
          `prices ${group.map((g) => g.price).join(', ')}) — both imported, delete the wrong one`,
      );
    }
  }

  return { rows: withOrder, warnings, review };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

interface ApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  retired: string[];
  purged: string[];
}

async function apply(plan: ImportPlan, options: { purge: boolean }): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, unchanged: 0, retired: [], purged: [] };

  for (const row of plan.rows) {
    const existing = await ProductMaster.findOne({ productCode: row.productCode });

    const fields = {
      posName: row.posName,
      displayName: row.displayName,
      category: row.category,
      price: row.price,
      taxPercent: row.taxPercent,
      kitchenStation: stationFor(row.rawCategory, row.posName),
      displayOrder: row.displayOrder,
      isActive: true,
    };

    if (!existing) {
      const created = await ProductMaster.create({
        productCode: row.productCode,
        ...fields,
        // Images are left empty on purpose — the admin adds them later, and an
        // import must never wipe a photo somebody already uploaded.
        isAvailable: true,
      });
      result.created += 1;
      await auditService.record({
        entityType: AUDIT_ENTITY.PRODUCT,
        entityId: created._id,
        action: AUDIT_ACTION.PRODUCT_CREATED,
        actor: SYSTEM_ACTOR,
        after: created.toObject(),
        meta: { source: 'pos_sheet_import' },
      });
      continue;
    }

    const before = existing.toObject();
    existing.set(fields);
    if (!existing.isModified()) {
      result.unchanged += 1;
      continue;
    }

    await existing.save();
    result.updated += 1;
    await auditService.record({
      entityType: AUDIT_ENTITY.PRODUCT,
      entityId: existing._id,
      action: AUDIT_ACTION.PRODUCT_UPDATED,
      actor: SYSTEM_ACTOR,
      before,
      after: existing.toObject(),
      meta: { source: 'pos_sheet_import' },
    });
  }

  // ── Everything the sheet does not mention ──────────────────────────────────
  // Retired, not deleted: `isActive: false` is the model's documented way to
  // take an item off the menu permanently, and it keeps old bills readable.
  // `--purge` hard-deletes, but only items no round has ever referenced.
  const sheetCodes = plan.rows.map((row) => row.productCode);
  const strays = await ProductMaster.find({ productCode: { $nin: sheetCodes } });

  for (const stray of strays) {
    if (options.purge) {
      const ordered = await OrderRound.countDocuments({ 'items.productCode': stray.productCode });
      if (ordered === 0) {
        await ProductMaster.deleteOne({ _id: stray._id });
        result.purged.push(stray.productCode);
        continue;
      }
    }

    if (stray.isActive) {
      stray.isActive = false;
      await stray.save();
      result.retired.push(stray.productCode);
    }
  }

  return result;
}

// ─── Report ──────────────────────────────────────────────────────────────────

function report(plan: ImportPlan): void {
  const byCategory = new Map<string, number>();
  const byStation = new Map<string, number>();
  for (const row of plan.rows) {
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
    const station = stationFor(row.rawCategory, row.posName);
    byStation.set(station, (byStation.get(station) ?? 0) + 1);
  }

  logger.info(`Parsed ${plan.rows.length} products from the sheet`);

  logger.info('Categories (menu renders these alphabetically):');
  for (const [category, count] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    logger.info(`  ${category.padEnd(22)} ${String(count).padStart(3)}`);
  }

  logger.info('Kitchen stations:');
  for (const [station, count] of byStation) {
    logger.info(`  ${station.padEnd(10)} ${String(count).padStart(3)}`);
  }

  if (plan.warnings.length > 0) {
    logger.warn(`WARNINGS — ${plan.warnings.length} thing(s) to check in the source sheet:`);
    for (const warning of plan.warnings) logger.warn(`  ! ${warning}`);
  }

  if (plan.review.length > 0) {
    logger.info(
      `REVIEW — ${plan.review.length} name(s) a guest may not understand. ` +
        `Fix them in Admin → Products, or extend ABBREVIATIONS and re-run:`,
    );
    for (const item of plan.review) logger.info(`  ? ${item}`);
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Where the menu sheet lives when nobody passes `--file`.
 *
 * Keeping a copy in the repo is the point: the import then runs like the seed
 * does, with no path to type and no dependence on one person's Downloads
 * folder. To update the menu, drop the newer export over this file and run the
 * command again.
 */
const DEFAULT_SHEET = 'data/menu.xlsx';

async function main(): Promise<void> {
  const file = argValue('--file') ?? DEFAULT_SHEET;

  if (!existsSync(file)) {
    logger.error(`Cannot find the menu sheet: ${file}`);
    logger.error(`Put the POS export at backend/${DEFAULT_SHEET}, or pass --file "<path>".`);
    process.exit(1);
  }

  logger.info(`Reading ${file}`);

  const dryRun = process.argv.includes('--dry-run');
  const purge = process.argv.includes('--purge');

  const plan = await readSheet(file);
  report(plan);

  if (dryRun) {
    logger.info('Dry run — nothing was written. Re-run without --dry-run to apply.');
    return;
  }

  assertEnv();
  await connectDB();
  await syncIndexes();

  const result = await apply(plan, { purge });

  logger.info(
    `Import complete: ${result.created} created, ${result.updated} updated, ` +
      `${result.unchanged} unchanged`,
  );
  if (result.retired.length > 0) {
    logger.info(`Retired ${result.retired.length} product(s): ${result.retired.join(', ')}`);
  }
  if (result.purged.length > 0) {
    logger.info(
      `Deleted ${result.purged.length} never-ordered product(s): ${result.purged.join(', ')}`,
    );
  }

  await disconnectDB();
  await mongoose.disconnect();
}

main().catch((error: Error) => {
  logger.error(`Product import failed: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
