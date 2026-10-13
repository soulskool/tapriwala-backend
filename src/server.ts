import http from 'node:http';

import { createApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { assertEnv, env } from './config/env.js';
import { findAccountsWithSeedPins } from './services/auth.service.js';
import { initSocketServer } from './sockets/index.js';
import { logger } from './utils/logger.js';

/**
 * Entry point.
 *
 * Boot order matters: validate config, connect the database, then bind the
 * port. A café that opens at 8am should find out at boot that MONGO_URI is
 * wrong — not when the first customer scans a QR code.
 */
async function bootstrap(): Promise<void> {
  assertEnv();

  await connectDB();

  const app = createApp();
  const server = http.createServer(app);

  // REST and WebSocket share one process and one port, which is the whole
  // reason the backend is a standalone Express service rather than Next.js
  // API routes: serverless functions cannot hold a socket open.
  initSocketServer(server);

  server.listen(env.port, () => {
    logger.info(`Tapriwala by Treatmeets API listening on port ${env.port} [${env.nodeEnv}]`);
    logger.info(`REST base: http://localhost:${env.port}${env.apiPrefix}`);
    void warnAboutSeedPins();
  });

  registerShutdown(server);
}

/**
 * Logs, after boot, every staff account still on a published seed PIN.
 * Never blocks or fails startup: a warning, not a gate.
 */
async function warnAboutSeedPins(): Promise<void> {
  try {
    const exposed = await findAccountsWithSeedPins();
    for (const account of exposed) {
      logger.warn(`SECURITY: ${account} still uses the published seed PIN. Change it now.`);
    }
  } catch (error) {
    logger.warn(`Seed-PIN check skipped: ${(error as Error).message}`);
  }
}

/** Drains in-flight requests before exiting, so a deploy never truncates an order. */
function registerShutdown(server: http.Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);

    server.close(() => logger.info('HTTP server closed'));

    // Hard stop if something refuses to let go.
    const timer = setTimeout(() => {
      logger.error('Forced shutdown after 10s');
      process.exit(1);
    }, 10_000);
    timer.unref();

    try {
      await disconnectDB();
      process.exit(0);
    } catch (error) {
      logger.error(`Error during shutdown: ${(error as Error).message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${String(reason)}`);
  });

  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}`, { stack: error.stack });
    void shutdown('uncaughtException');
  });
}

bootstrap().catch((error: Error) => {
  logger.error(`Failed to start server: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
