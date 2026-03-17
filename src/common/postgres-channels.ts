/**
 * Postgres NOTIFY channel names and internal emitter event names.
 */

/** Global NOTIFY channel names (used in LISTEN/UNLISTEN). */
export enum PgNotifyChannel {
  Presence = 'presence',
  Typing = 'typing',
}

/** Prefix for per-room message NOTIFY channels (channel is `room:{roomId}`). */
export const PG_ROOM_CHANNEL_PREFIX = 'room:';

/** Build the NOTIFY channel name for a room. */
export function getRoomNotifyChannel(roomId: string): string {
  return `${PG_ROOM_CHANNEL_PREFIX}${roomId}`;
}

/** Internal EventEmitter event names (in-process, not wire protocol). */
export enum PgEmitterEvent {
  RoomMessage = 'room_message',
  Presence = 'presence',
  Typing = 'typing',
}
