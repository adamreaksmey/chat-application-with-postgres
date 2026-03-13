import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Client, Pool, PoolClient, QueryResult } from 'pg';
import { EventEmitter } from 'events';
import {
  PgNotifyChannel,
  PgEmitterEvent,
  getRoomNotifyChannel,
  PG_ROOM_CHANNEL_PREFIX,
} from '../common/postgres-channels';

/**
 * Shape of the payload emitted by the Postgres NOTIFY trigger for new messages.
 * id is the table PK; seq is the per-room monotonic cursor.
 */
export interface RoomMessagePayload {
  id: number;
  seq: number;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

/**
 * Central Postgres access layer.
 *
 * - Provides a private pool for queries; use query() and transaction() only.
 * - Maintains a dedicated LISTEN connection for real-time notifications.
 * - Re-emits NOTIFY events (room messages, presence, typing) as in-process events.
 */
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool;
  private listenClient!: Client;
  private readonly connectionString: string;
  private nodeId!: string;
  private readonly emitter = new EventEmitter();
  /** Room channel name -> subscriber count. LISTEN only when count goes 0→1; UNLISTEN when count reaches 0. */
  private readonly roomChannelCounts = new Map<string, number>();
  private destroyed = false;
  private reconnectBackoffMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Construct the service. Pool and listen client are created in onModuleInit.
   * Throws if DATABASE_URL is missing because the service cannot function without it.
   */
  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. PostgresService requires a connection string.',
      );
    }

    this.connectionString = connectionString;
  }

  /**
   * Lifecycle hook invoked by Nest when the module is initialized.
   * Creates the query pool and LISTEN client, subscribes to global channels, wires NOTIFY handlers.
   */
  async onModuleInit(): Promise<void> {
    this.nodeId = randomUUID();
    this.pool = new Pool({ connectionString: this.connectionString });
    this.listenClient = new Client({
      connectionString: this.connectionString,
    });
    this.wireListenClientHandlers(this.listenClient);
    await this.listenClient.connect();
    await this.ensureListenChannels(this.listenClient);
  }

  /** Unique identity for this process instance (e.g. for presence.node_id). */
  getNodeId(): string {
    return this.nodeId;
  }

  private wireListenClientHandlers(client: Client): void {
    client.on('notification', (msg: { channel: string; payload?: string }) => {
      const { channel, payload } = msg;

      if (!payload) {
        return;
      }

      if (channel.startsWith(PG_ROOM_CHANNEL_PREFIX)) {
        const roomId = channel.slice(PG_ROOM_CHANNEL_PREFIX.length);
        try {
          const data = JSON.parse(payload) as RoomMessagePayload;
          this.emitter.emit(PgEmitterEvent.RoomMessage, roomId, data);
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.error('Error parsing room message payload:', err.message);
          }
        }
        return;
      }

      if (channel === PgNotifyChannel.Presence) {
        try {
          const data = JSON.parse(payload);
          this.emitter.emit(PgEmitterEvent.Presence, data);
        } catch {
          // ignore
        }
        return;
      }

      if (channel === PgNotifyChannel.Typing) {
        try {
          const data = JSON.parse(payload);
          this.emitter.emit(PgEmitterEvent.Typing, data);
        } catch {
          // ignore
        }
      }
    });

    client.on('error', () => {
      this.scheduleReconnect();
    });
  }

  private async ensureListenChannels(client: Client): Promise<void> {
    await client.query(`LISTEN "${PgNotifyChannel.Presence}"`);
    await client.query(`LISTEN "${PgNotifyChannel.Typing}"`);
    for (const channel of this.roomChannelCounts.keys()) {
      await client.query(`LISTEN "${channel}"`);
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;

    const delay = this.reconnectBackoffMs;
    this.reconnectBackoffMs = Math.min(
      this.reconnectBackoffMs * 2,
      MAX_RECONNECT_MS,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doReconnect().catch(() => {});
    }, delay);
  }

  private async doReconnect(): Promise<void> {
    if (this.destroyed) return;

    const old = this.listenClient;
    old.removeAllListeners();
    await old.end().catch(() => undefined);

    try {
      this.listenClient = new Client({
        connectionString: this.connectionString,
      });
      this.wireListenClientHandlers(this.listenClient);
      await this.listenClient.connect();
      await this.ensureListenChannels(this.listenClient);
      this.reconnectBackoffMs = INITIAL_RECONNECT_MS;
    } catch {
      this.scheduleReconnect();
    }
  }

  /**
   * Lifecycle hook invoked by Nest when the module is being destroyed.
   * Stops reconnect loop, removes event listeners, closes LISTEN client and query pool.
   */
  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.emitter.removeAllListeners();
    await this.listenClient?.end().catch(() => undefined);
    await this.pool?.end().catch(() => undefined);
  }

  /**
   * Run a single parameterized query. Use this for all one-off reads/writes.
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query(sql, params);
  }

  /**
   * Run multiple statements in a transaction. The client is committed on success and rolled back on throw.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Subscribe to Postgres notifications for a specific room channel.
   *
   * Reference-counted: LISTEN is issued only when subscriber count goes 0 → 1.
   * The Map update is safe without a mutex because Node.js is single-threaded
   * and there is no await between the read and the write; the only async
   * failure surface is the LISTEN call itself, which we roll back on error.
   */
  async subscribeToRoomChannel(roomId: string): Promise<void> {
    const channel = getRoomNotifyChannel(roomId);
    const count = this.roomChannelCounts.get(channel) ?? 0;
    const newCount = count + 1;
    this.roomChannelCounts.set(channel, newCount);

    if (count === 0) {
      try {
        await this.listenClient.query(`LISTEN "${channel}"`);
      } catch (err) {
        // Roll back ref count if LISTEN fails so our in-memory state stays consistent.
        const rollbackCount = this.roomChannelCounts.get(channel) ?? 0;
        const decremented = rollbackCount - 1;
        if (decremented <= 0) {
          this.roomChannelCounts.delete(channel);
        } else {
          this.roomChannelCounts.set(channel, decremented);
        }
        throw err;
      }
    }
  }

  /**
   * Unsubscribe from a room channel.
   *
   * Reference-counted: UNLISTEN only when count reaches 0. As with subscribe,
   * the Map read-modify-write is synchronous and safe without a mutex; if the
   * UNLISTEN call fails, we restore the previous count before rethrowing.
   */
  async unsubscribeFromRoomChannel(roomId: string): Promise<void> {
    const channel = getRoomNotifyChannel(roomId);
    const count = this.roomChannelCounts.get(channel) ?? 0;
    if (count === 0) return;

    const newCount = count - 1;
    if (newCount === 0) {
      this.roomChannelCounts.delete(channel);
      try {
        await this.listenClient.query(`UNLISTEN "${channel}"`);
      } catch (err) {
        // Restore previous count if UNLISTEN fails so we do not lose the subscription.
        const existing = this.roomChannelCounts.get(channel) ?? 0;
        this.roomChannelCounts.set(channel, existing + 1);
        throw err;
      }
    } else {
      this.roomChannelCounts.set(channel, newCount);
    }
  }

  /**
   * Register a handler for room message notifications coming from Postgres NOTIFY.
   * Handlers receive the logical room id and the decoded message payload.
   */
  onRoomMessage(
    handler: (roomId: string, payload: RoomMessagePayload) => void,
  ): void {
    this.emitter.on(PgEmitterEvent.RoomMessage, handler);
  }

  /**
   * Register a handler for presence change notifications.
   * The payload is the row from the `presence` table as JSON.
   */
  onPresence(handler: (payload: unknown) => void): void {
    this.emitter.on(PgEmitterEvent.Presence, handler);
  }

  /**
   * Register a handler for typing indicator notifications.
   * The payload is the row from the `typing` table as JSON.
   */
  onTyping(handler: (payload: unknown) => void): void {
    this.emitter.on(PgEmitterEvent.Typing, handler);
  }
}
