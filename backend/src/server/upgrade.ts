/**
 * Shared WebSocket-upgrade plumbing for the media bridges.
 *
 * Node emits `upgrade` to EVERY listener in registration order, so:
 *
 *  - a bridge must not 404 a path it does not own (it would kill the other
 *    bridge's connections) — it claims only its own pathname and returns
 *    silently otherwise, marking the request as claimed when it does;
 *  - the fallback listener, registered LAST, closes anything no bridge claimed
 *    with a real 404, so an unknown path still fails fast instead of hanging;
 *  - the fallback never touches a claimed socket (a bridge is answering it),
 *    and never writes twice to a socket a bridge has already ended.
 */
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const CLAIMED = Symbol.for('uws.upgrade.claimed');

/** Called by a bridge the moment it recognises its own pathname. */
export function markUpgradeClaimed(req: IncomingMessage): void {
  (req as unknown as Record<symbol, boolean>)[CLAIMED] = true;
}

export function isUpgradeClaimed(req: IncomingMessage): boolean {
  return (req as unknown as Record<symbol, boolean | undefined>)[CLAIMED] === true;
}

export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  // `writableEnded` matters: when a bridge has already answered an upgrade the
  // fallback listener still fires for the same socket, and writing again would
  // throw ERR_STREAM_WRITE_AFTER_END inside the server.
  if (socket.destroyed || socket.writableEnded || socket.writable === false) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.end();
}

/** Register after every bridge: 404s any upgrade no bridge claimed. */
export function attachUpgradeFallback(server: Server): void {
  server.on('upgrade', (req, socket) => {
    if (isUpgradeClaimed(req)) return;
    rejectUpgrade(socket as unknown as Duplex, 404, 'Not Found');
  });
}
