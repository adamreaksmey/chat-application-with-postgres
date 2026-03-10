import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, Pool } from 'pg';
import { EventEmitter } from 'events';

/**
 * Shape of the payload emitted by the Postgres NOTIFY trigger for new messages.
 */
export interface RoomMessagePayload {
  id: number;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

/**
 * Central Postgres access layer.
 *
 * - Provides a pooled connection for normal queries.
 * - Maintains a dedicated LISTEN connection for real-time notifications.
 * - Re-emits NOTIFY events (room messages, presence, typing) as in-process events.
 */
@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly listenClient: Client;
  private readonly emitter = new EventEmitter();
  private readonly subscribedRoomChannels = new Set<string>();

  /**
   * Construct the service and initialize the query pool and LISTEN client.
   * Throws if DATABASE_URL is missing because the service cannot function without it.
   */
  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. PostgresService requires a connection string.',
      );
    }

    this.pool = new Pool({ connectionString });
    this.listenClient = new Client({ connectionString });
  }

  /**
   * Lifecycle hook invoked by Nest when the module is initialized.
   * Establishes connections, subscribes to global channels, and wires NOTIFY handlers.
   */
  async onModuleInit(): Promise<void> {
    await this.pool.connect();
    await this.listenClient.connect();

    // Global channels for presence and typing.
    await this.listenClient.query('LISTEN "presence"');
    await this.listenClient.query('LISTEN "typing"');

    this.listenClient.on('notification', (msg) => {
      const { channel, payload } = msg;

      if (!payload) {
        return;
      }

      if (channel.startsWith('room:')) {
        const roomId = channel.slice('room:'.length);
        try {
          const data = JSON.parse(payload) as RoomMessagePayload;
          this.emitter.emit('room_message', roomId, data);
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.error('Error parsing room message payload:', err.message);
          }
          // Ignore malformed payloads for now.
        }
        return;
      }

      if (channel === 'presence') {
        try {
          const data = JSON.parse(payload);
          this.emitter.emit('presence', data);
        } catch {
          // ignore
        }
        return;
      }

      if (channel === 'typing') {
        try {
          const data = JSON.parse(payload);
          this.emitter.emit('typing', data);
        } catch {
          // ignore
        }
      }
    });

    // Basic reconnect strategy for listen client.
    this.listenClient.on('error', () => {
      // pg will try to reconnect on next query; in a full implementation we would
      // add more robust reconnection logic here.
    });
  }

  /**
   * Lifecycle hook invoked by Nest when the module is being destroyed.
   * Closes both the LISTEN client and the query pool.
   */
  async onModuleDestroy(): Promise<void> {
    await this.listenClient.end().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
  }

  /**
   * Expose the underlying query pool for normal SQL queries.
   */
  getQueryPool(): Pool {
    return this.pool;
  }

  /**
   * Subscribe to Postgres notifications for a specific room channel.
   * This issues a LISTEN "room:{roomId}" on the dedicated listen connection.
   */
  async subscribeToRoomChannel(roomId: string): Promise<void> {
    const channel = `room:${roomId}`;
    if (this.subscribedRoomChannels.has(channel)) {
      return;
    }

    await this.listenClient.query(`LISTEN "${channel}"`);
    this.subscribedRoomChannels.add(channel);
  }

  /**
   * Register a handler for room message notifications coming from Postgres NOTIFY.
   * Handlers receive the logical room id and the decoded message payload.
   */
  onRoomMessage(
    handler: (roomId: string, payload: RoomMessagePayload) => void,
  ): void {
    this.emitter.on('room_message', handler);
  }

  /**
   * Register a handler for presence change notifications.
   * The payload is the row from the `presence` table as JSON.
   */
  onPresence(handler: (payload: unknown) => void): void {
    this.emitter.on('presence', handler);
  }

  /**
   * Register a handler for typing indicator notifications.
   * The payload is the row from the `typing` table as JSON.
   */
  onTyping(handler: (payload: unknown) => void): void {
    this.emitter.on('typing', handler);
  }
}
