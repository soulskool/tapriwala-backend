import { Router } from 'express';

import * as kitchenController from '../controllers/kitchen.controller.js';
import { authenticate } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import { kitchenQueueValidation } from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate);

/**
 * Readable by every staff role, not just kitchen: the waiter dashboard and the
 * admin overview both render the same queue.
 */
router.get('/queue', validate(kitchenQueueValidation), kitchenController.getQueue);
router.get('/ready', kitchenController.getUnservedReady);

export default router;
