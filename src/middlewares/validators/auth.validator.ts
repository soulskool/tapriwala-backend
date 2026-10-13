import { body, type ValidationChain } from 'express-validator';

import { APP_CONSTANTS, ROLE_VALUES } from '../../config/constants.js';

/** POST /auth/login — shared-device PIN login. */
export const loginValidation: ValidationChain[] = [
  // `.not().isArray()` first: express-validator checks an array element by
  // element, so `["9999999999"]` would pass the regex below and reach Mongo,
  // which reads an array as `$in`. One phone, one PIN, as plain strings.
  body('phone')
    .not()
    .isArray()
    .withMessage('Phone must be a 10 digit number')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('Phone is required')
    .matches(/^\d{10}$/)
    .withMessage('Phone must be a 10 digit number'),

  body('pin')
    .not()
    .isArray()
    .withMessage(`PIN must be ${APP_CONSTANTS.PIN_LENGTH} digits`)
    .bail()
    .trim()
    .notEmpty()
    .withMessage('PIN is required')
    .isLength({ min: APP_CONSTANTS.PIN_LENGTH, max: APP_CONSTANTS.PIN_LENGTH })
    .withMessage(`PIN must be ${APP_CONSTANTS.PIN_LENGTH} digits`)
    .isNumeric()
    .withMessage('PIN must contain digits only'),
];

/** POST /admin/users — create a staff account. */
export const createUserValidation: ValidationChain[] = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 80 })
    .withMessage('Name must be 2–80 characters'),

  body('phone')
    .trim()
    .matches(/^\d{10}$/)
    .withMessage('Phone must be a 10 digit number'),

  body('role')
    .isIn(ROLE_VALUES)
    .withMessage(`role must be one of: ${ROLE_VALUES.join(', ')}`),

  body('pin')
    .trim()
    .isLength({ min: APP_CONSTANTS.PIN_LENGTH, max: APP_CONSTANTS.PIN_LENGTH })
    .withMessage(`PIN must be ${APP_CONSTANTS.PIN_LENGTH} digits`)
    .isNumeric()
    .withMessage('PIN must contain digits only'),
];

/** PATCH /admin/users/:id — every field optional, but at least one must change. */
export const updateUserValidation: ValidationChain[] = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('Name must be 2–80 characters'),
  body('phone')
    .optional()
    .trim()
    .matches(/^\d{10}$/)
    .withMessage('Phone must be a 10 digit number'),
  body('role')
    .optional()
    .isIn(ROLE_VALUES)
    .withMessage(`role must be one of: ${ROLE_VALUES.join(', ')}`),
  body('pin')
    .optional()
    .trim()
    .isLength({ min: APP_CONSTANTS.PIN_LENGTH, max: APP_CONSTANTS.PIN_LENGTH })
    .withMessage(`PIN must be ${APP_CONSTANTS.PIN_LENGTH} digits`)
    .isNumeric()
    .withMessage('PIN must contain digits only'),
  body('isActive').optional().isBoolean().withMessage('isActive must be a boolean').toBoolean(),
];
