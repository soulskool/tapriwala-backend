import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimiter.js';
import { requestLogger } from './middlewares/requestLogger.js';
import routes from './routes/index.js';
import { getStorageDriver } from './services/storage/index.js';

/**
 * Express application.
 *
 * Exported without listening so `server.ts` can attach Socket.IO to the same
 * HTTP server, and so tests can mount the app without opening a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind nginx/Caddy on the VPS — needed for correct client IPs in rate
  // limiting and audit logs.
  if (env.isProduction) app.set('trust proxy', 1);

  app.disable('x-powered-by');

  app.use(
    helmet({
      // Menu images are loaded by the Next.js frontends on a different origin.
      // Helmet's default `same-origin` policy would block them.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(compression());

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin, curl and native apps send no Origin header.
        if (!origin || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
      exposedHeaders: ['x-request-id'],
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // Single request log: method, path, status, duration, requestId and actor.
  // (No morgan — it would emit a second, less useful line for every request.)
  app.use(requestLogger);

  app.use(apiLimiter);

  /**
   * Menu images, only when files actually live on this disk.
   *
   * Asks the storage module rather than reading the env string, so the route
   * and the driver can never disagree — with Bunny, images are served by the
   * CDN and this route must not exist.
   *
   * Long cache: filenames are content-random, so a changed image is a new URL.
   */
  if (getStorageDriver().name === 'local') {
    app.use(
      env.uploadUrlPath,
      express.static(env.uploadDir, {
        maxAge: '30d',
        immutable: true,
        index: false,
        dotfiles: 'ignore',
        // Never let an uploaded file be interpreted as markup by a browser.
        setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
      }),
    );
  }

  app.get('/', (_req, res) => {
    res.json({
      service: 'ACD Cafe API',
      status: 'running',
      docs: `${env.apiPrefix}/health`,
    });
  });

  app.use(env.apiPrefix, routes);

  // Order matters: unmatched route first, then the single error writer.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
