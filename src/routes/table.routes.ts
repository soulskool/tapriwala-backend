import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as tableController from '../controllers/table.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import {
  createTableValidation,
  listTablesValidation,
  objectIdParam,
  updateTableValidation,
} from '../middlewares/validators/index.js';

const router = Router();

// Every staff role needs the live grid, so only authentication is required.
router.use(authenticate);

/** The live table screen. */
router.get('/', validate(listTablesValidation), tableController.getLiveGrid);
router.get('/master', validate(listTablesValidation), tableController.list);
router.get('/qr-sheet', authorize(ROLES.ADMIN), tableController.qrSheet);
router.get('/:id', validate([objectIdParam('id', 'Table id')]), tableController.getById);

/** Table master data is admin-only. */
router.post('/', authorize(ROLES.ADMIN), validate(createTableValidation), tableController.create);

router.patch(
  '/:id',
  authorize(ROLES.ADMIN),
  validate([objectIdParam('id', 'Table id'), ...updateTableValidation]),
  tableController.update,
);

export default router;
