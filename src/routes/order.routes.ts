import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as orderController from '../controllers/order.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import {
  objectIdParam,
  updateItemStatusValidation,
  updateRoundStatusValidation,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate);

router.get('/:roundId', validate([objectIdParam('roundId', 'Round id')]), orderController.getRound);

/**
 * Item-level status is the KDS's main write. Kitchen is restricted to
 * accepted/preparing/ready inside the service; waiters mark served and staff
 * cancel with a reason.
 */
router.patch(
  '/:roundId/items/:itemId',
  authorize(ROLES.KITCHEN, ROLES.WAITER, ROLES.BILLING),
  validate([
    objectIdParam('roundId', 'Round id'),
    objectIdParam('itemId', 'Item id'),
    ...updateItemStatusValidation,
  ]),
  orderController.updateItemStatus,
);

/** "All ready" / "all served" on a whole ticket. */
router.patch(
  '/:roundId/status',
  authorize(ROLES.KITCHEN, ROLES.WAITER, ROLES.BILLING),
  validate([objectIdParam('roundId', 'Round id'), ...updateRoundStatusValidation]),
  orderController.updateRoundStatus,
);

export default router;
