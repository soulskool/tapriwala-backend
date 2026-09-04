import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise reaches the global error
 * handler instead of hanging the request.
 *
 * Express 5 forwards async rejections on its own, but wrapping keeps behaviour
 * identical if the app is ever downgraded and makes the intent explicit.
 *
 * Accepts sync handlers too — `Promise.resolve` normalises either — so a route
 * with nothing to await does not have to be pointlessly marked `async`.
 */
export const asyncHandler =
  <Req extends Request = Request>(
    handler: (req: Req, res: Response, next: NextFunction) => unknown,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req as Req, res, next)).catch(next);
  };

export default asyncHandler;
