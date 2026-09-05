import { Router } from 'express';

import { ROLES } from '../config/constants.js';
import * as productController from '../controllers/product.controller.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { uploadImage } from '../middlewares/upload.js';
import { validate } from '../middlewares/validate.js';
import {
  bulkUpsertProductsValidation,
  createProductValidation,
  listProductsValidation,
  objectIdParam,
  toggleAvailabilityValidation,
  updateProductValidation,
} from '../middlewares/validators/index.js';

const router = Router();

router.use(authenticate);

/** Reads — any signed-in staff role. */
router.get('/', validate(listProductsValidation), productController.list);
router.get('/menu', productController.menu);
router.get('/categories', productController.categories);
router.get('/audit', authorize(ROLES.ADMIN), productController.auditCatalogue);
router.get('/:id', validate([objectIdParam('id', 'Product id')]), productController.getById);

/**
 * The 86 toggle is kitchen + admin: the cook who ran out of sandwiches must be
 * able to pull it from the menu without finding a manager.
 */
router.patch(
  '/:id/availability',
  authorize(ROLES.KITCHEN, ROLES.BILLING),
  validate([objectIdParam('id', 'Product id'), ...toggleAvailabilityValidation]),
  productController.setAvailability,
);

/** Menu master data is admin-only. */
router.post(
  '/',
  authorize(ROLES.ADMIN),
  validate(createProductValidation),
  productController.create,
);

router.post(
  '/bulk',
  authorize(ROLES.ADMIN),
  validate(bulkUpsertProductsValidation),
  productController.bulkUpsert,
);

router.patch(
  '/:id',
  authorize(ROLES.ADMIN),
  validate([objectIdParam('id', 'Product id'), ...updateProductValidation]),
  productController.update,
);

/**
 * Menu photos. Multipart, field name `image`.
 * `uploadImage` runs before validate() because the body is not JSON.
 */
router.post(
  '/:id/image',
  authorize(ROLES.ADMIN),
  uploadImage,
  validate([objectIdParam('id', 'Product id')]),
  productController.uploadProductImage,
);

router.delete(
  '/:id/image',
  authorize(ROLES.ADMIN),
  validate([objectIdParam('id', 'Product id')]),
  productController.deleteProductImage,
);

export default router;
