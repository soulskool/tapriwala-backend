import { Router } from 'express';

import { ROLES, STAFF_MANAGER_ROLES } from '../config/constants.js';
import * as adminController from '../controllers/admin.controller.js';
import { authenticate, authorize, requireRole } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import {
  createUserValidation,
  dailySalesValidation,
  dateRangeQuery,
  itemSalesValidation,
  listAuditValidation,
  objectIdParam,
  paginationQuery,
  updateUserValidation,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate, authorize(ROLES.ADMIN));

/** One read-only screen with the whole floor. */
router.get('/overview', adminController.overview);

/**
 * Day-wise sales — what each day took, from paid bills only.
 *
 * Admin only. The counter already sees each bill; the day's takings are the
 * owner's question.
 */
router.get('/sales/daily', validate(dailySalesValidation), adminController.dailySales);

/**
 * Item-wise sales — every item's quantity and takings, its price variants, its
 * category, and a per-day or per-month breakdown. Same paid-bills rule.
 * `/xlsx` is the same report as a workbook.
 */
router.get('/sales/items', validate(itemSalesValidation), adminController.itemSales);
router.get('/sales/items/xlsx', validate(itemSalesValidation), adminController.itemSalesXlsx);

router.get(
  '/audit',
  validate([...listAuditValidation, ...paginationQuery, ...dateRangeQuery]),
  adminController.listAudit,
);

/**
 * Staff accounts.
 *
 * Every admin can read the list; only a super admin can change it. That
 * includes PINs, roles (making someone super admin, or taking it back) and
 * switching an account off. `requireRole` has no admin bypass, which is the
 * point of using it here instead of `authorize`.
 */
router.get('/users', adminController.listUsers);
router.post(
  '/users',
  requireRole(...STAFF_MANAGER_ROLES),
  validate(createUserValidation),
  adminController.createUser,
);
router.patch(
  '/users/:id',
  requireRole(...STAFF_MANAGER_ROLES),
  validate([objectIdParam('id', 'User id'), ...updateUserValidation]),
  adminController.updateUser,
);

export default router;
