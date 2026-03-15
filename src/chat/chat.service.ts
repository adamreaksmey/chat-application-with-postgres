import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { PostgresService } from '../postgres/postgres.service';
import { WsServerEvent } from '../common/ws-events';
import { MAX_MESSAGE_LENGTH } from '../common/chat-limits';

/** Payload sent by the client when joining a room; optional last_seen_seq for catch-up history. */
export interface JoinRoomPayload {
  room_id: string;
  last_seen_seq?: number;
}

/** Payload sent by the client when posting a new message in a room. */
export interface SendMessagePayload {
  room_id: string;
  content: string;
}

/** Payload sent by the client for typing_start / typing_stop events. */
export interface TypingPayload {
  room_id: string;
}

/**
 * Handles chat business logic driven by WebSocket events: join/leave room, send message, typing.
 * All persistence goes through Postgres; real-time fanout is done via LISTEN/NOTIFY in PostgresService.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(private readonly postgres: PostgresService) {}

  /**
   * Handles a client joining a room.
   * Verifies membership, then subscribes to NOTIFY, optionally sends history, and upserts presence.
   * If the user is not a member, sends an error frame and returns (no throw).
   */
  async handleJoinRoom(
    userId: string,
    socket: WebSocket,
    payload: JoinRoomPayload,
  ): Promise<void> {
    const { room_id: roomId, last_seen_seq: lastSeenSeq } = payload;

    const memberResult = await this.postgres.query<{ n: number }>(
      'SELECT 1 AS n FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    if (memberResult.rows.length === 0) {
      socket.send(
        JSON.stringify({
          event: WsServerEvent.Error,
          data: { message: 'Not a member of this room' },
        }),
      );
      return;
    }

    await this.postgres.subscribeToRoomChannel(roomId);

    if (lastSeenSeq != null) {
      const result = await this.postgres.query(
        `
          SELECT id, seq, room_id, user_id, content, created_at
          FROM messages
          WHERE room_id = $1 AND seq > $2
          ORDER BY seq ASC
          LIMIT 100
        `,
        [roomId, lastSeenSeq],
      );

      const messages = result.rows;
      const nextCursor =
        messages.length > 0 ? messages[messages.length - 1].seq : lastSeenSeq;

      socket.send(
        JSON.stringify({
          event: WsServerEvent.History,
          data: { messages, next_cursor: nextCursor },
        }),
      );
    }

    await this.postgres.query(
      `
        INSERT INTO presence (user_id, room_id, node_id, last_seen)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, room_id)
        DO UPDATE SET node_id = EXCLUDED.node_id, last_seen = NOW()
      `,
      [userId, roomId, this.postgres.getNodeId()],
    );

    socket.send(
      JSON.stringify({
        event: WsServerEvent.JoinedRoom,
        data: { room_id: roomId },
      }),
    );
  }

  /**
   * Handles a client leaving a room.
   * Removes the user's presence row and unsubscribes from the room NOTIFY channel.
   */
  async handleLeaveRoom(
    userId: string,
    payload: JoinRoomPayload,
  ): Promise<void> {
    const { room_id: roomId } = payload;
    await this.postgres.query(
      `DELETE FROM presence WHERE user_id = $1 AND room_id = $2`,
      [userId, roomId],
    );
    await this.postgres.unsubscribeFromRoomChannel(roomId);
  }

  /**
   * Deletes presence rows older than 1 minute. Rows from crashed nodes (which never update
   * last_seen again) are removed regardless of node_id.
   */
  async sweepStalePresence(): Promise<void> {
    await this.postgres.query(
      `DELETE FROM presence WHERE last_seen < NOW() - INTERVAL '1 minute'`,
    );
  }

  /**
   * Handles a client sending a message in a room.
   * Verifies membership; if not a member, sends an error frame and returns.
   * Otherwise inserts into messages; the Postgres trigger fires NOTIFY to all nodes.
   */
  async handleSendMessage(
    userId: string,
    socket: WebSocket,
    payload: SendMessagePayload,
  ): Promise<void> {
    const { room_id: roomId, content } = payload;
    this.logger.log(`handleSendMessage room=${roomId} user=${userId}`);

    if (content.length > MAX_MESSAGE_LENGTH) {
      socket.send(
        JSON.stringify({
          event: WsServerEvent.Error,
          data: {
            message: `content must not exceed ${MAX_MESSAGE_LENGTH} characters`,
            code: 'message_too_long',
          },
        }),
      );
      return;
    }

    const memberResult = await this.postgres.query<{ n: number }>(
      'SELECT 1 AS n FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    if (memberResult.rows.length === 0) {
      this.logger.warn(
        `send_message rejected: user=${userId} not in room=${roomId}`,
      );
      socket.send(
        JSON.stringify({
          event: WsServerEvent.Error,
          data: { message: 'Not a member of this room' },
        }),
      );
      return;
    }

    this.logger.log(`inserting message room=${roomId} user=${userId}`);
    await this.postgres.query(
      `
        INSERT INTO messages (room_id, user_id, content)
        VALUES ($1, $2, $3)
      `,
      [roomId, userId, content],
    );
  }

  /**
   * Handles the client starting to type in a room.
   * Verifies membership; if not a member, sends an error frame and returns.
   * Otherwise upserts into the typing table; the trigger fires NOTIFY to all nodes.
   */
  async handleTypingStart(
    userId: string,
    socket: WebSocket,
    payload: TypingPayload,
  ): Promise<void> {
    const { room_id: roomId } = payload;

    const memberResult = await this.postgres.query<{ n: number }>(
      'SELECT 1 AS n FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    if (memberResult.rows.length === 0) {
      socket.send(
        JSON.stringify({
          event: WsServerEvent.Error,
          data: { message: 'Not a member of this room' },
        }),
      );
      return;
    }

    await this.postgres.query(
      `
        INSERT INTO typing (user_id, room_id, started_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id, room_id)
        DO UPDATE SET started_at = NOW()
      `,
      [userId, roomId],
    );
  }

  /**
   * Handles the client stopping typing in a room.
   * Deletes the typing row so NOTIFY (or downstream logic) can signal that the user is no longer typing.
   */
  async handleTypingStop(
    userId: string,
    payload: TypingPayload,
  ): Promise<void> {
    const { room_id: roomId } = payload;
    await this.postgres.query(
      `
        DELETE FROM typing
        WHERE user_id = $1 AND room_id = $2
      `,
      [userId, roomId],
    );
  }
}
