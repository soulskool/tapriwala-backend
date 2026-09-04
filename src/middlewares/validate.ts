import type { RequestHandler } from 'express';
import { validationResult, type ValidationChain } from 'express-validator';

import { ApiError } from '../utils/ApiError.js';

/**
 * One entry in the `error.details` array of a 400 response.
 * The frontends index into this to mark the offending input red.
 */
export interface ValidationDetail {
  field: string;
  message: string;
  value: unknown;
}

/**
 * Runs a set of express-validator chains and turns any failures into a single
 * 400 with a field-keyed details array — the shape the frontends render next to
 * their inputs.
 *
 *   router.post('/', validate(placeOrderValidation), controller.placeOrder)
 */
export const validate =
  (validations: ValidationChain[]): RequestHandler =>
  async (req, _res, next) => {
    try {
      await Promise.all(validations.map((validation) => validation.run(req)));

      const result = validationResult(req);
      if (result.isEmpty()) {
        next();
        return;
      }

      const details: ValidationDetail[] = result.array().map((error) => ({
        field: error.type === 'field' ? error.path : error.type,
        message: typeof error.msg === 'string' ? error.msg : 'Invalid value',
        value: error.type === 'field' ? (error.value as unknown) : undefined,
      }));

      next(ApiError.badRequest('Validation failed', details));
    } catch (error) {
      next(error);
    }
  };

export default validate;
