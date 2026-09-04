import mongoose from 'mongoose';

import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * MongoDB connection lifecycle.
 *
 * Mongoose buffers commands until the connection is up, so the app never has to
 * guard every query — but we still connect before binding the HTTP port so a
 * bad URI fails at boot instead of on the first customer order.
 */

mongoose.set('strictQuery', true);

export async function connectDB(): Promise<typeof mongoose> {
  mongoose.connection.on('connected', () => {
    logger.info(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
  });

  mongoose.connection.on('error', (error: Error) => {
    logger.error(`MongoDB connection error: ${error.message}`, { stack: error.stack });
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — mongoose will retry automatically');
  });

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: !env.isProduction,
  });

  if (env.isProduction) {
    // In production indexes are built once, explicitly, rather than on every
    // model registration — keeps boot fast and index creation observable.
    await syncIndexes();
  }

  return mongoose;
}

/**
 * Brings every registered model's indexes in line with its schema.
 *
 * `syncIndexes()` rather than `createIndexes()`, because `createIndexes()` only
 * ever adds: it cannot replace an index whose *name* still matches but whose
 * keys have changed, and it fails outright when it tries.
 *
 * That is not hypothetical. `uniq_idempotency_key` started life as a global
 * unique index on `{ idempotencyKey }` and is now scoped to
 * `{ sessionId, idempotencyKey }`. Any database created before that change
 * still carries the old one, and `createIndexes()` throws instead of fixing it
 * — leaving the database quietly enforcing the *old*, buggy rule.
 *
 * `syncIndexes()` drops what the schema no longer declares, then builds what it
 * does. Safe to call repeatedly. It is the only place indexes are managed, so
 * nothing else can be dropped by surprise.
 */
export async function syncIndexes(): Promise<void> {
  const names = Object.keys(mongoose.models);

  await Promise.all(
    names.map(async (name) => {
      const model = mongoose.models[name];
      if (!model) return;

      const dropped = await model.syncIndexes();
      // Worth a line in the log: an index disappearing is the kind of thing
      // you want to find in yesterday's output, not by bisecting a slow query.
      if (dropped.length > 0) {
        logger.warn(`Replaced stale index(es) on ${name}: ${dropped.join(', ')}`);
      }
    }),
  );

  logger.info(`Indexes synced for ${names.length} models`);
}

export async function disconnectDB(): Promise<void> {
  await mongoose.connection.close();
  logger.info('MongoDB connection closed');
}

export default connectDB;
