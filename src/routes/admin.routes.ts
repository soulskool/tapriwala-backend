import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as adminController from '../controllers/admin.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validate.js';
import {
  createUserValidation,
  dateRangeQuery,
  objectIdParam,
  paginationQuery,
  updateUserValidation,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate, authorize(ROLES.ADMIN));

/** One read-only screen with the whole floor. */
router.get('/overview', adminController.overview);

router.get(
  '/audit',
  validate([...paginationQuery, ...dateRangeQuery]),
  adminController.listAudit,
);

router.get('/users', adminController.listUsers);
router.post('/users', validate(createUserValidation), adminController.createUser);
router.patch(
  '/users/:id',
  validate([objectIdParam('id', 'User id'), ...updateUserValidation]),
  adminController.updateUser,
);

export default router;
