import { body, type ValidationChain } from 'express-validator';

const zoneName = () =>
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Zone name is required')
    .isLength({ max: 40 })
    .withMessage('Zone name must be at most 40 characters');

const displayOrder = () =>
  body('displayOrder')
    .optional()
    .isInt({ min: 0, max: 999 })
    .withMessage('displayOrder must be between 0 and 999')
    .toInt();

/** POST /zones */
export const createZoneValidation: ValidationChain[] = [zoneName(), displayOrder()];

/** PATCH /zones/:id */
export const updateZoneValidation: ValidationChain[] = [zoneName().optional(), displayOrder()];
