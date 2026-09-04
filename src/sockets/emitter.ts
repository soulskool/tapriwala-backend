import type { Server } from 'socket.io';

import {
  ROLES,
  SOCKET_EVENTS,
  SOCKET_ROOMS,
  STAFF_ROLE_ROOMS,
  type Role,
  type SocketEvent,
} from '../config/constants.js';
import { logger } from '../utils/logger.js';

/**
 * Socket broadcast surface.
 *
 * Services call these instead of touching `io` directly, which keeps the
 * business layer free of transport concerns and means an un-initialised socket
 * server (unit tests, scripts, seed) degrades to a no-op instead of crashing.
 */

let io: Server | null = null;

export function registerSocketServer(server: Server): void {
  io = server;
}

export function getSocketServer(): Server | null {
  return io;
}

function emitTo(rooms: string[], event: SocketEvent, payload: unknown): void {
  if (!io) {
    logger.debug?.(`Socket server not ready, dropped ${event}`);
    return;
  }
  if (rooms.length === 0) return;
  io.to(rooms).emit(event, payload);
}

/** Everyone on staff: waiter, kitchen, billing, admin. */
export function emitToStaff(event: SocketEvent, payload: unknown): void {
  emitTo(STAFF_ROLE_ROOMS.map(SOCKET_ROOMS.role), event, payload);
}

/**
 * Every connected client, staff and customer phones alike.
 *
 * Reserved for changes that are not scoped to a table — menu availability is
 * the real case: when the kitchen 86s the last sandwich, every phone in the
 * café must drop it from the menu, and those phones are in table rooms, not
 * role rooms, so a staff-only broadcast would silently miss all of them.
 */
export function emitToAll(event: SocketEvent, payload: unknown): void {
  if (!io) {
    logger.debug?.(`Socket server not ready, dropped ${event}`);
    return;
  }
  io.emit(event, payload);
}

/** A specific set of staff roles (admin is added automatically — ops visibility). */
export function emitToRoles(roles: Role[], event: SocketEvent, payload: unknown): void {
  const unique = Array.from(new Set<Role>([...roles, ROLES.ADMIN]));
  emitTo(unique.map(SOCKET_ROOMS.role), event, payload);
}

/** The customer phones currently on a table, plus anyone watching that session. */
export function emitToTable(
  tableId: string,
  sessionId: string | null,
  event: SocketEvent,
  payload: unknown,
): void {
  const rooms = [SOCKET_ROOMS.table(tableId)];
  if (sessionId) rooms.push(SOCKET_ROOMS.session(sessionId));
  emitTo(rooms, event, payload);
}

/**
 * The common case: a change that both the table and every staff screen needs.
 * One call so no code path can remember the kitchen and forget the customer.
 */
export function broadcast(
  event: SocketEvent,
  payload: unknown,
  target: { tableId?: string | null; sessionId?: string | null; roles?: Role[] } = {},
): void {
  const rooms = new Set<string>();

  const roles = target.roles ?? STAFF_ROLE_ROOMS;
  roles.forEach((role) => rooms.add(SOCKET_ROOMS.role(role)));
  if (!roles.includes('admin')) rooms.add(SOCKET_ROOMS.role('admin'));

  if (target.tableId) rooms.add(SOCKET_ROOMS.table(target.tableId));
  if (target.sessionId) rooms.add(SOCKET_ROOMS.session(target.sessionId));

  emitTo(Array.from(rooms), event, payload);
}

export { SOCKET_EVENTS };
