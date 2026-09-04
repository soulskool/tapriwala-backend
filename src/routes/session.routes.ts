import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as orderController from '../controllers/order.controller.js';
import * as sessionController from '../controllers/session.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { orderLimiter } from '../middlewares/rateLimiter.js';
import { validate } from '../middlewares/validate.js';
import {
  closeSessionValidation,
  dateRangeQuery,
  listSessionsValidation,
  objectIdParam,
  openSessionValidation,
  paginationQuery,
  placeOrderValidation,
  reviewSessionValidation,
  transferSessionValidation,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate);

router.get(
  '/',
  validate([...listSessionsValidation, ...paginationQuery, ...dateRangeQuery]),
  sessionController.list,
);

router.get('/:id', validate([objectIdParam('id', 'Session id')]), sessionController.getDetail);

router.get(
  '/:id/rounds',
  validate([objectIdParam('id', 'Session id')]),
  sessionController.getRounds,
);

/** Waiters open tables; billing/admin can too (covered by authorize + admin bypass). */
router.post(
  '/',
  authorize(ROLES.WAITER, ROLES.BILLING),
  validate(openSessionValidation),
  sessionController.open,
);

/** Place an order round on a running session. */
router.post(
  '/:id/rounds',
  authorize(ROLES.WAITER, ROLES.BILLING),
  orderLimiter,
  validate([objectIdParam('id', 'Session id'), ...placeOrderValidation]),
  orderController.placeRound,
);

/** Closing a session is a billing action — it is what frees the table. */
router.post(
  '/:id/close',
  authorize(ROLES.BILLING),
  validate([objectIdParam('id', 'Session id'), ...closeSessionValidation]),
  sessionController.close,
);

/** Moving a running session between tables needs a reason and is audit-logged. */
router.post(
  '/:id/transfer',
  authorize(ROLES.BILLING),
  validate([objectIdParam('id', 'Session id'), ...transferSessionValidation]),
  sessionController.transfer,
);

router.patch(
  '/:id/review',
  authorize(ROLES.BILLING),
  validate([objectIdParam('id', 'Session id'), ...reviewSessionValidation]),
  sessionController.setReview,
);

export default router;
