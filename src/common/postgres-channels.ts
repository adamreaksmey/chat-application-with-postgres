/**
 * Postgres NOTIFY channel names and internal emitter event names.
 */
import * as crypto from 'crypto';

/** Global NOTIFY channel names (used in LISTEN/UNLISTEN). */
export enum PgNotifyChannel {
  Presence = 'presence',
  Typing = 'typing',
}

/**
 * Prefix for hash-sharded room message NOTIFY channels.
 * Full channel is `room_shard:{shard}` where shard is 0..(N-1).
 */
export const PG_ROOM_SHARD_CHANNEL_PREFIX = 'room_shard:';

/** Default number of room shards. Keep in sync with DB migration. */
export const PG_ROOM_SHARD_COUNT = 4;

/** Build the NOTIFY channel name for a room shard. */
export function getRoomShardNotifyChannel(shard: number): string {
  return `${PG_ROOM_SHARD_CHANNEL_PREFIX}${shard}`;
}

/**
 * Deterministic shard function based on roomId.
 * Must match the implementation in the Postgres `notify_new_message()` trigger function.
 */
export function getRoomShardForRoomId(
  roomId: string,
  shardCount: number = PG_ROOM_SHARD_COUNT,
): number {
  if (!roomId) {
    return 0;
  }

  // md5(roomId) first 8 hex chars => 32-bit number (0..2^32-1)
  // mod shardCount to pick the shard.
  const hex = crypto.createHash('md5').update(roomId).digest('hex').slice(0, 8);
  const n = parseInt(hex, 16);
  return (
    (((Number.isFinite(n) ? n : 0) % shardCount) + shardCount) % shardCount
  );
}

/** Internal EventEmitter event names (in-process, not wire protocol). */
export enum PgEmitterEvent {
  RoomMessage = 'room_message',
  Presence = 'presence',
  Typing = 'typing',
}
