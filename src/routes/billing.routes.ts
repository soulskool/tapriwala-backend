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

router.use(authenticate, authorize(ROLES.BILLING));

/** Tables waiting at the counter. */
router.get('/queue', billingController.queue);

router.get(
  '/exports',
  validate([...listExportsValidation, ...paginationQuery, ...dateRangeQuery]),
  billingController.listExports,
);

router.get(
  '/exports/:id',
  validate([objectIdParam('id', 'Export id')]),
  billingController.getExport,
);

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
