import type { Server as HttpServer } from 'node:http';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';

import { ROLE_VALUES, SOCKET_EVENTS, SOCKET_ROOMS, type Role } from '../config/constants.js';
import { env } from '../config/env.js';
import { TableMaster, TableSession } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { verifyToken } from '../utils/jwt.js';
import { registerSocketServer } from './emitter.js';

/**
 * Socket.IO server.
 *
 * Rooms, not broadcasts: a kitchen tablet only receives kitchen traffic, and a
 * customer phone only receives its own table. Staff sockets must present the
 * same JWT they use for REST; customer sockets present their table QR token.
 *
 * Sockets are for *notification*. On (re)connect a client re-fetches state over
 * REST — a kitchen tablet that was offline for two minutes must never rely on
 * replaying missed events.
 */

interface SocketAuth {
  token?: string;
  tableCode?: string;
}

/**
 * Pulls the staff session token out of the handshake's cookie header.
 *
 * Necessary because the cookie is `httpOnly`: the browser app cannot read it to
 * put it in `socket.handshake.auth`, so the socket authenticates the same way
 * every REST call does — by the cookie the browser attaches automatically.
 * (Requires `withCredentials: true` on the client.)
 */
function tokenFromCookies(header: string | undefined): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== env.cookieName) continue;
    return decodeURIComponent(part.slice(separator + 1).trim()) || null;
  }
  return null;
}

/**
 * What the handshake attaches to each socket.
 *
 * Declared as Socket.IO's `SocketData` generic rather than assigned onto an
 * untyped `socket.data`, so a typo like `socket.data.tabelId` is a build error
 * instead of a silently undefined room name at 8pm on a Friday.
 */
export interface CafeSocketData {
  role: Role | 'customer';
  userId?: string;
  name?: string;
  tableId?: string;
  tableCode?: string;
}

/**
 * Server/socket typed on the 4th generic only.
 *
 * The event maps stay `DefaultEventsMap` because event names come from the
 * `SOCKET_EVENTS` constant at runtime; pinning them here would buy nothing and
 * would force every `emit` payload through a second declaration.
 */
export type CafeSocketServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  CafeSocketData
>;

type CafeSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, CafeSocketData>;

export function initSocketServer(httpServer: HttpServer): CafeSocketServer {
  const io: CafeSocketServer = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
    },
    // Floor Wi-Fi drops; give a reconnecting client a grace window.
    pingTimeout: 25_000,
    pingInterval: 20_000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },
  });

  /** Identify the socket once, at handshake, rather than on every event. */
  io.use(async (socket, next) => {
    const auth = (socket.handshake.auth ?? {}) as SocketAuth;

    // Browser apps send nothing in `auth` and rely on the httpOnly cookie;
    // native clients that have no cookie jar pass the token explicitly.
    const staffToken = auth.token ?? tokenFromCookies(socket.handshake.headers.cookie);

    try {
      // A table code is checked first, and deliberately so: a staff member who
      // scans a table sticker on their own phone still carries a valid session
      // cookie, and they must land in that table's room as a guest rather than
      // being silently upgraded to a staff socket that never hears about M2.
      if (auth.tableCode) {
        const table = await TableMaster.findOne({
          code: auth.tableCode.trim().toUpperCase(),
          isActive: true,
        })
          .select('_id code')
          .lean();
        if (!table) {
          next(new Error('Unknown table code'));
          return;
        }
        socket.data.role = 'customer';
        socket.data.tableId = String(table._id);
        socket.data.tableCode = table.code;
        next();
        return;
      }

      if (staffToken) {
        const payload = verifyToken(staffToken);
        socket.data.role = payload.role;
        socket.data.userId = payload.sub;
        socket.data.name = payload.name;
        next();
        return;
      }

      next(new Error('Authentication required'));
    } catch (error) {
      logger.warn(`Socket handshake rejected: ${(error as Error).message}`);
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    void onConnection(socket);
  });

  registerSocketServer(io);
  logger.info('Socket.IO server initialised');
  return io;
}

async function onConnection(socket: CafeSocket): Promise<void> {
  const { role, tableId, tableCode, name } = socket.data;

  if (role === 'customer' && tableId) {
    // Customers are pinned to their own table room at handshake — they cannot
    // join another table's room even if they ask for it.
    await socket.join(SOCKET_ROOMS.table(tableId));

    const session = await TableSession.findOne({ tableId, isActive: true }).select('_id').lean();
    if (session) await socket.join(SOCKET_ROOMS.session(String(session._id)));

    socket.emit(SOCKET_EVENTS.JOINED, {
      role,
      tableCode,
      sessionId: session ? String(session._id) : null,
    });
    logger.info(`Customer socket connected for table ${tableCode}`);
  } else if (role && ROLE_VALUES.includes(role as Role)) {
    await socket.join(SOCKET_ROOMS.role(role as Role));
    socket.emit(SOCKET_EVENTS.JOINED, { role });
    logger.info(`Staff socket connected: ${role} (${name ?? 'unknown'})`);
  }

  /** Staff screens can additionally watch one table/session at a time. */
  socket.on(SOCKET_EVENTS.JOIN_TABLE, async (payload: { tableId?: string }) => {
    if (role === 'customer') return; // pinned at handshake
    if (!payload?.tableId) return;
    await socket.join(SOCKET_ROOMS.table(payload.tableId));
  });

  socket.on(SOCKET_EVENTS.JOIN_SESSION, async (payload: { sessionId?: string }) => {
    if (!payload?.sessionId) return;
    if (role === 'customer') {
      // A customer may only follow the session live on their own table.
      const session = await TableSession.findById(payload.sessionId).select('tableId').lean();
      if (!session || String(session.tableId) !== tableId) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Not your table' });
        return;
      }
    }
    await socket.join(SOCKET_ROOMS.session(payload.sessionId));
  });

  socket.on(SOCKET_EVENTS.LEAVE_SESSION, async (payload: { sessionId?: string }) => {
    if (!payload?.sessionId) return;
    await socket.leave(SOCKET_ROOMS.session(payload.sessionId));
  });

  socket.on('disconnect', (reason) => {
    logger.debug?.(`Socket disconnected (${role ?? 'unknown'}): ${reason}`);
  });
}

export {
  registerSocketServer,
  getSocketServer,
  broadcast,
  emitToAll,
  emitToStaff,
  emitToRoles,
  emitToTable,
} from './emitter.js';
export default initSocketServer;
