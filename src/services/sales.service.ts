import ExcelJS from 'exceljs';

import {
  BUSINESS_TIMEZONE,
  EXPORT_STATUS,
  ORDER_TYPE,
  ORDER_TYPE_VALUES,
  SALES_PERIOD,
  type OrderType,
  type SalesPeriod,
} from '../config/constants.js';
import { BillingExport, ProductMaster } from '../models/index.js';
import { round2 } from '../utils/helpers.js';
import { dayStart, resolveSalesRange, shiftDay, type SalesDay } from './billing.service.js';

/**
 * Item-wise sales — how much of each thing the café sold, and when.
 *
 * Built from the same rows as day-wise sales: **paid bills only**, booked to
 * the café day each bill was generated on. See `dailySales` for why. So the
 * two screens never disagree about which bills happened.
 *
 * Read from the bill's frozen line items, not from `OrderRound`, because the
 * bill is what was charged: cancelled items are already out, prices are the
 * ones the guest paid, and a later menu price change leaves history alone.
 */

/** Shown for a code no longer in the menu — sold once, deleted since. */
export const UNCATEGORISED = 'Uncategorised';

/** One price an item was sold at. Dining and parcel can be priced differently. */
export interface ItemPriceRow {
  unitPrice: number;
  orderType: OrderType;
  quantity: number;
  amount: number;
  tax: number;
}

export interface ItemPeriodCell {
  quantity: number;
  amount: number;
}

export interface ItemSalesRow {
  productCode: string;
  /** The POS name on the most recent bill — what the counter knows it as. */
  name: string;
  /** Today's category from the menu. Bills do not snapshot it. */
  category: string;
  quantity: number;
  /** Before tax. */
  amount: number;
  tax: number;
  /** amount + tax. Bill-level round off is not shared out across items. */
  total: number;
  /** Most sold first. */
  prices: ItemPriceRow[];
  /** Only the periods it sold in, keyed like `periods`. */
  byPeriod: Record<string, ItemPeriodCell>;
}

export interface CategorySalesRow {
  category: string;
  itemCount: number;
  quantity: number;
  amount: number;
  tax: number;
  total: number;
}

export interface ItemSalesReport {
  from: SalesDay;
  to: SalesDay;
  timezone: string;
  period: SalesPeriod;
  /** Every period in the range, oldest first — `YYYY-MM-DD` or `YYYY-MM`. */
  periods: string[];
  /** Highest takings first. */
  items: ItemSalesRow[];
  /** Highest takings first. */
  categories: CategorySalesRow[];
  totals: { bills: number; quantity: number; amount: number; tax: number; total: number };
}

/** Every bucket from `from` to `to`, oldest first, including the empty ones. */
function listPeriods(from: SalesDay, to: SalesDay, period: SalesPeriod): string[] {
  const periods: string[] = [];
  if (period === SALES_PERIOD.DAY) {
    for (let day = from; day <= to; day = shiftDay(day, 1)) periods.push(day);
    return periods;
  }
  let [year, month] = from.split('-').map(Number) as [number, number];
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    periods.push(key);
    if (key >= last) return periods;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

interface GroupedLine {
  _id: { productCode: string; unitPrice: number; orderType: OrderType | null; period: string };
  name: string;
  quantity: number;
  amount: number;
  tax: number;
}

export async function itemSales(options: {
  from?: SalesDay;
  to?: SalesDay;
  period?: SalesPeriod;
}): Promise<ItemSalesReport> {
  const { from, to } = resolveSalesRange(options);
  const period = options.period ?? SALES_PERIOD.DAY;

  const match = {
    exportStatus: EXPORT_STATUS.CONFIRMED,
    generatedAt: { $gte: dayStart(from), $lt: dayStart(shiftDay(to, 1)) },
  };

  const [grouped, bills] = await Promise.all([
    BillingExport.aggregate<GroupedLine>([
      { $match: match },
      // Oldest first, so `$last` below is the newest name for the code.
      { $sort: { generatedAt: 1 } },
      { $project: { generatedAt: 1, lineItems: 1 } },
      { $unwind: '$lineItems' },
      {
        $group: {
          _id: {
            productCode: '$lineItems.productCode',
            unitPrice: '$lineItems.unitPrice',
            orderType: '$lineItems.orderType',
            period: {
              $dateToString: {
                format: period === SALES_PERIOD.DAY ? '%Y-%m-%d' : '%Y-%m',
                date: '$generatedAt',
                timezone: BUSINESS_TIMEZONE,
              },
            },
          },
          name: { $last: '$lineItems.posName' },
          quantity: { $sum: '$lineItems.quantity' },
          amount: { $sum: '$lineItems.amount' },
          tax: { $sum: '$lineItems.taxAmount' },
        },
      },
    ]),
    BillingExport.countDocuments(match),
  ]);

  const codes = [...new Set(grouped.map((row) => row._id.productCode))];
  // Deleted items too, so they keep their category in the report. Sorted so
  // a live item that reused a code overwrites the deleted one in the map.
  const products = await ProductMaster.find({ productCode: { $in: codes } })
    .select('productCode category')
    .sort({ isDeleted: -1 })
    .lean();
  const categoryOf = new Map(products.map((p) => [p.productCode, p.category]));

  const byCode = new Map<string, ItemSalesRow>();
  for (const row of grouped) {
    const { productCode, unitPrice, period: key } = row._id;
    // Bills saved before order types existed were all dining.
    const orderType = row._id.orderType ?? ORDER_TYPE.DINING;

    let item = byCode.get(productCode);
    if (!item) {
      item = {
        productCode,
        name: row.name,
        category: categoryOf.get(productCode) ?? UNCATEGORISED,
        quantity: 0,
        amount: 0,
        tax: 0,
        total: 0,
        prices: [],
        byPeriod: {},
      };
      byCode.set(productCode, item);
    }
    item.quantity += row.quantity;
    item.amount += row.amount;
    item.tax += row.tax;

    const price = item.prices.find((p) => p.unitPrice === unitPrice && p.orderType === orderType);
    if (price) {
      price.quantity += row.quantity;
      price.amount += row.amount;
      price.tax += row.tax;
    } else {
      item.prices.push({
        unitPrice,
        orderType,
        quantity: row.quantity,
        amount: row.amount,
        tax: row.tax,
      });
    }

    const cell = (item.byPeriod[key] ??= { quantity: 0, amount: 0 });
    cell.quantity += row.quantity;
    cell.amount += row.amount;
  }

  // Summed as doubles in Mongo and here, so every figure is re-rounded once.
  const items = [...byCode.values()].map((item) => {
    const amount = round2(item.amount);
    const tax = round2(item.tax);
    return {
      ...item,
      amount,
      tax,
      total: round2(amount + tax),
      prices: item.prices
        .map((p) => ({ ...p, amount: round2(p.amount), tax: round2(p.tax) }))
        .sort(
          (a, b) =>
            b.quantity - a.quantity ||
            ORDER_TYPE_VALUES.indexOf(a.orderType) - ORDER_TYPE_VALUES.indexOf(b.orderType) ||
            a.unitPrice - b.unitPrice,
        ),
      byPeriod: Object.fromEntries(
        Object.entries(item.byPeriod).map(([key, cell]) => [
          key,
          { quantity: cell.quantity, amount: round2(cell.amount) },
        ]),
      ),
    };
  });
  items.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const byCategory = new Map<string, CategorySalesRow>();
  for (const item of items) {
    const row = byCategory.get(item.category) ?? {
      category: item.category,
      itemCount: 0,
      quantity: 0,
      amount: 0,
      tax: 0,
      total: 0,
    };
    row.itemCount += 1;
    row.quantity += item.quantity;
    row.amount += item.amount;
    row.tax += item.tax;
    byCategory.set(item.category, row);
  }
  const categories = [...byCategory.values()]
    .map((row) => {
      const amount = round2(row.amount);
      const tax = round2(row.tax);
      return { ...row, amount, tax, total: round2(amount + tax) };
    })
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  const amount = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const tax = round2(items.reduce((sum, item) => sum + item.tax, 0));

  return {
    from,
    to,
    timezone: BUSINESS_TIMEZONE,
    period,
    periods: listPeriods(from, to, period),
    items,
    categories,
    totals: {
      bills,
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      amount,
      tax,
      total: round2(amount + tax),
    },
  };
}

/**
 * The same report as a workbook, one sheet per view on the Sales screen, so
 * what the owner forwards to an accountant is what they were looking at.
 */
export async function buildItemSalesWorkbook(options: {
  from?: SalesDay;
  to?: SalesDay;
  period?: SalesPeriod;
}): Promise<{ buffer: Buffer; report: ItemSalesReport }> {
  const report = await itemSales(options);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tapriwala by Treatmeets';
  // Fixed, like the bills workbook: same range in, byte-identical file out.
  workbook.created = dayStart(report.to);

  const money = '#,##0.00';

  const itemSheet = workbook.addWorksheet('Item wise');
  itemSheet.columns = [
    { header: 'No', key: 'no', width: 6 },
    { header: 'Item', key: 'name', width: 30 },
    { header: 'Code', key: 'productCode', width: 10 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Qty', key: 'quantity', width: 8 },
    { header: 'Amount', key: 'amount', width: 12, style: { numFmt: money } },
    { header: 'Tax', key: 'tax', width: 10, style: { numFmt: money } },
    { header: 'Total', key: 'total', width: 12, style: { numFmt: money } },
  ];
  report.items.forEach((item, index) => itemSheet.addRow({ no: index + 1, ...item }));

  const priceSheet = workbook.addWorksheet('Item wise (multi price)');
  priceSheet.columns = [
    { header: 'Item', key: 'name', width: 30 },
    { header: 'Code', key: 'productCode', width: 10 },
    { header: 'Order type', key: 'orderType', width: 12 },
    { header: 'Rate', key: 'unitPrice', width: 10, style: { numFmt: money } },
    { header: 'Qty', key: 'quantity', width: 8 },
    { header: 'Amount', key: 'amount', width: 12, style: { numFmt: money } },
    { header: 'Tax', key: 'tax', width: 10, style: { numFmt: money } },
  ];
  for (const item of report.items) {
    for (const price of item.prices) {
      priceSheet.addRow({ name: item.name, productCode: item.productCode, ...price });
    }
  }

  const categorySheet = workbook.addWorksheet('Category wise');
  categorySheet.columns = [
    { header: 'Category', key: 'category', width: 24 },
    { header: 'Items', key: 'itemCount', width: 8 },
    { header: 'Qty', key: 'quantity', width: 8 },
    { header: 'Amount', key: 'amount', width: 12, style: { numFmt: money } },
    { header: 'Tax', key: 'tax', width: 10, style: { numFmt: money } },
    { header: 'Total', key: 'total', width: 12, style: { numFmt: money } },
  ];
  for (const row of report.categories) categorySheet.addRow(row);

  const trendSheet = workbook.addWorksheet(
    report.period === SALES_PERIOD.DAY ? 'Qty by day' : 'Qty by month',
  );
  trendSheet.columns = [
    { header: 'Item', key: 'name', width: 30 },
    { header: 'Code', key: 'productCode', width: 10 },
    ...report.periods.map((key) => ({ header: key, key, width: 11 })),
    { header: 'Total qty', key: 'quantity', width: 10 },
  ];
  for (const item of report.items) {
    const row: Record<string, string | number> = {
      name: item.name,
      productCode: item.productCode,
      quantity: item.quantity,
    };
    for (const key of report.periods) row[key] = item.byPeriod[key]?.quantity ?? 0;
    trendSheet.addRow(row);
  }

  const sheets = [itemSheet, priceSheet, categorySheet, trendSheet];
  for (const sheet of sheets) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // Totals rows, so the number an owner needs is on the sheet.
  if (report.items.length > 0) {
    itemSheet.addRow({ name: 'TOTAL', ...report.totals }).font = { bold: true };
    categorySheet.addRow({ category: 'TOTAL', ...report.totals }).font = { bold: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), report };
}
