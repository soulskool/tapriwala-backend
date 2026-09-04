import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as serviceRequestController from '../controllers/serviceRequest.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import {
  dateRangeQuery,
  listServiceRequestsValidation,
  objectIdParam,
  paginationQuery,
  raiseServiceRequestForTableValidation,
  updateServiceRequestValidation,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate);

/** The waiter dashboard feed — oldest first, escalation flagged. */
router.get('/queue', serviceRequestController.queue);

router.get(
  '/',
  validate([...listServiceRequestsValidation, ...paginationQuery, ...dateRangeQuery]),
  serviceRequestController.list,
);

/** Staff raising a request on a guest's behalf (phone call, verbal ask). */
router.post(
  '/',
  authorize(ROLES.WAITER, ROLES.BILLING),
  validate(raiseServiceRequestForTableValidation),
  serviceRequestController.raise,
);

router.patch(
  '/:id',
  authorize(ROLES.WAITER, ROLES.BILLING),
  validate([objectIdParam('id', 'Request id'), ...updateServiceRequestValidation]),
  serviceRequestController.update,
);

export default router;
