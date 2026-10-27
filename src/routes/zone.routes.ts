import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as zoneController from '../controllers/zone.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import {
  createZoneValidation,
  deleteReasonBody,
  objectIdParam,
  updateZoneValidation,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate);

/** Any staff screen may read the zones; only admins manage them. */
router.get('/', zoneController.list);

router.post('/', authorize(ROLES.ADMIN), validate(createZoneValidation), zoneController.create);

router.patch(
  '/:id',
  authorize(ROLES.ADMIN),
  validate([objectIdParam('id', 'Zone id'), ...updateZoneValidation]),
  zoneController.update,
);

router.delete(
  '/:id',
  authorize(ROLES.ADMIN),
  validate([objectIdParam('id', 'Zone id'), ...deleteReasonBody]),
  zoneController.remove,
);

export default router;
