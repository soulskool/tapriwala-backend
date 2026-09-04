import { Router } from 'express';

import * as publicController from '../controllers/public.controller.js';
import { resolveTableCode } from '../middlewares/authMiddleware.js';
import { customerLimiter, orderLimiter } from '../middlewares/rateLimiter.js';
import { validate } from '../middlewares/validate.js';
import {
  placeOrderValidation,
  tableCodeParamValidation,
  raiseServiceRequestValidation,
} from '../middlewares/validators/index.js';

/**
 * Tokenless customer routes.
 *
 * `resolveTableCode` runs before every handler and pins the request to one
 * table, so no handler in this router ever takes a tableId from the body.
 */
const router = Router();

router.use(
  '/tables/:tableCode',
  validate(tableCodeParamValidation),
  resolveTableCode,
  customerLimiter,
);

router.get('/tables/:tableCode', publicController.resolveTable);
router.get('/tables/:tableCode/menu', publicController.menu);
router.get('/tables/:tableCode/order-status', publicController.orderStatus);

router.post(
  '/tables/:tableCode/orders',
  orderLimiter,
  validate(placeOrderValidation),
  publicController.placeOrder,
);

router.post(
  '/tables/:tableCode/service-requests',
  validate(raiseServiceRequestValidation),
  publicController.raiseServiceRequest,
);

export default router;
