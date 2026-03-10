import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, Pool } from 'pg';
import { EventEmitter } from 'events';

export interface RoomMessagePayload {
  id: number;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly listenClient: Client;
  private readonly emitter = new EventEmitter();
  private readonly subscribedRoomChannels = new Set<string>();

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

  onRoomMessage(
    handler: (roomId: string, payload: RoomMessagePayload) => void,
  ): void {
    this.emitter.on('room_message', handler);
  }

  onPresence(handler: (payload: unknown) => void): void {
    this.emitter.on('presence', handler);
  }

  onTyping(handler: (payload: unknown) => void): void {
    this.emitter.on('typing', handler);
  }
}
