import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { PostgresService } from '../postgres/postgres.service';
import { WsServerEvent } from '../common/ws-events';

/** Payload sent by the client when joining a room; optional last_seen_id for catch-up history. */
export interface JoinRoomPayload {
  room_id: string;
  last_seen_id?: number;
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
  constructor(private readonly postgres: PostgresService) {}

  /**
   * Handles a client joining a room.
   * Subscribes this node to Postgres NOTIFY for the room, optionally sends missed messages (history)
   * when last_seen_id is provided, and upserts the user into the presence table for this node.
   */
  async handleJoinRoom(
    userId: string,
    socket: WebSocket,
    payload: JoinRoomPayload,
  ): Promise<void> {
    const { room_id: roomId, last_seen_id: lastSeenId } = payload;

    await this.postgres.subscribeToRoomChannel(roomId);

    if (lastSeenId != null) {
      const pool = this.postgres.getQueryPool();
      const result = await pool.query(
        `
          SELECT id, room_id, user_id, content, created_at
          FROM messages
          WHERE room_id = $1 AND id > $2
          ORDER BY created_at ASC
          LIMIT 100
        `,
        [roomId, lastSeenId],
      );

      const messages = result.rows;
      const nextCursor =
        messages.length > 0 ? messages[messages.length - 1].id : lastSeenId;

      socket.send(
        JSON.stringify({
          event: WsServerEvent.History,
          data: { messages, next_cursor: nextCursor },
        }),
      );
    }

    const pool = this.postgres.getQueryPool();
    await pool.query(
      `
        INSERT INTO presence (user_id, room_id, node_id, last_seen)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, room_id)
        DO UPDATE SET node_id = EXCLUDED.node_id, last_seen = NOW()
      `,
      [userId, roomId, process.env.NODE_ID ?? 'node-1'],
    );
  }

  /**
   * Handles a client leaving a room.
   * Removes the user's presence row for that room so other clients stop seeing them as present.
   */
  async handleLeaveRoom(
    userId: string,
    payload: JoinRoomPayload,
  ): Promise<void> {
    const { room_id: roomId } = payload;
    const pool = this.postgres.getQueryPool();
    await pool.query(
      `
        DELETE FROM presence
        WHERE user_id = $1 AND room_id = $2
      `,
      [userId, roomId],
    );
  }

  /**
   * Handles a client sending a message in a room.
   * Inserts into messages; the Postgres trigger then fires NOTIFY so all nodes (including this one)
   * receive the payload and can push it to their connected WebSocket clients in that room.
   */
  async handleSendMessage(
    userId: string,
    payload: SendMessagePayload,
  ): Promise<void> {
    const { room_id: roomId, content } = payload;
    const pool = this.postgres.getQueryPool();
    await pool.query(
      `
        INSERT INTO messages (room_id, user_id, content)
        VALUES ($1, $2, $3)
      `,
      [roomId, userId, content],
    );
  }

  /**
   * Handles the client starting to type in a room.
   * Upserts a row in the typing table; the trigger fires NOTIFY so all nodes can broadcast
   * the typing indicator to other clients in the room.
   */
  async handleTypingStart(
    userId: string,
    payload: TypingPayload,
  ): Promise<void> {
    const { room_id: roomId } = payload;
    const pool = this.postgres.getQueryPool();
    await pool.query(
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
    const pool = this.postgres.getQueryPool();
    await pool.query(
      `
        DELETE FROM typing
        WHERE user_id = $1 AND room_id = $2
      `,
      [userId, roomId],
    );
  }
}
