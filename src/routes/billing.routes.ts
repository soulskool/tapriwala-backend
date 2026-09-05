import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as billingController from '../controllers/billing.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import {
  confirmExportValidation,
  dateRangeQuery,
  exportBillValidation,
  listExportsValidation,
  objectIdParam,
  paginationQuery,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate);

/**
 * Reading the bill history is open to waiters; changing anything is not.
 *
 * A waiter genuinely needs "what was M2 billed?" on the floor — to answer a
 * guest disputing a charge without walking them to the counter. Generating a
 * bill, confirming it against the POS or retrying an export stay with the
 * billing role, because those move money and mint a permanent bill number.
 * Admin passes every check either way.
 */
const canReadBills = authorize(ROLES.BILLING, ROLES.WAITER);

router.get(
  '/exports',
  canReadBills,
  validate([...listExportsValidation, ...paginationQuery, ...dateRangeQuery]),
  billingController.listExports,
);

router.get(
  '/exports/:id',
  canReadBills,
  validate([objectIdParam('id', 'Export id')]),
  billingController.getExport,
);

// Everything below this line is the counter's alone.
router.use(authorize(ROLES.BILLING));

/** Tables waiting at the counter. */
router.get('/queue', billingController.queue);

/** Record the legacy POS invoice number / outcome against a bill. */
router.patch(
  '/exports/:id',
  validate([objectIdParam('id', 'Export id'), ...confirmExportValidation]),
  billingController.confirmExport,
);

router.post(
  '/exports/:id/retry',
  validate([objectIdParam('id', 'Export id')]),
  billingController.retryExport,
);

/** The consolidation screen — read-only, safe to poll. */
router.get(
  '/:sessionId/consolidate',
  validate([objectIdParam('sessionId', 'Session id')]),
  billingController.consolidate,
);

router.get(
  '/:sessionId/csv',
  validate([objectIdParam('sessionId', 'Session id')]),
  billingController.downloadCsv,
);

router.post(
  '/:sessionId/export',
  validate([objectIdParam('sessionId', 'Session id'), ...exportBillValidation]),
  billingController.exportBill,
);

export default router;
