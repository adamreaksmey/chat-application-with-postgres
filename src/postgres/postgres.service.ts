import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Client, Pool, PoolClient, QueryResult } from 'pg';
import { EventEmitter } from 'events';
import {
  PgNotifyChannel,
  PgEmitterEvent,
  getRoomShardForRoomId,
  getRoomShardNotifyChannel,
  PG_ROOM_SHARD_CHANNEL_PREFIX,
  PG_ROOM_SHARD_COUNT,
} from '../common/postgres-channels';

/**
 * Shape of the payload emitted by the Postgres NOTIFY trigger for new messages.
 * id is the table PK; seq is the per-room monotonic cursor; username is denormalized from users.
 */
export interface RoomMessagePayload {
  id: number;
  seq: number;
  room_id: string;
  user_id: string;
  username: string;
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

const PG_POOL_MAX = Number(process.env.PG_POOL_MAX) || 20;
const PG_POOL_IDLE_TIMEOUT_MS =
  Number(process.env.PG_POOL_IDLE_TIMEOUT_MS) || 30_000;
const PG_CONNECTION_TIMEOUT_MS =
  Number(process.env.PG_CONNECTION_TIMEOUT_MS) || 5_000;
const PG_STATEMENT_TIMEOUT_MS =
  Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 30_000;

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool;
  private listenClient!: Client;
  private readonly connectionString: string;
  private nodeId!: string;
  private readonly emitter = new EventEmitter();
  /** Room id -> subscriber count (logical subscriptions). */
  private readonly roomSubscriptionCounts = new Map<string, number>();
  /** Shard channel name -> subscriber count. LISTEN only when count goes 0→1; UNLISTEN when count reaches 0. */
  private readonly shardChannelCounts = new Map<string, number>();
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

    const poolConfig = {
      connectionString: this.connectionString,
      max: PG_POOL_MAX,
      idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    };

    this.pool = new Pool(poolConfig);
    this.wrapPoolConnectWithStatementTimeout();

    this.listenClient = new Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    });

    this.wireListenClientHandlers(this.listenClient);
    await this.listenClient.connect();
    await this.ensureListenChannels(this.listenClient);
  }

  /** Run SET statement_timeout on each checked-out client so stuck queries don't hold connections. */
  private wrapPoolConnectWithStatementTimeout(): void {
    const pool = this.pool;
    const originalConnect = pool.connect.bind(pool);

    const setStatementTimeout = async (client: PoolClient) => {
      await client.query(
        `SET statement_timeout = ${Math.max(0, PG_STATEMENT_TIMEOUT_MS)}`,
      );
      return client;
    };

    pool.connect = function (
      cb?: (
        err: Error | null,
        client?: PoolClient,
        done?: (err?: Error) => void,
      ) => void,
    ): Promise<PoolClient> {
      if (!cb) {
        return originalConnect().then(setStatementTimeout);
      }

      return originalConnect(
        (err: Error, client?: PoolClient, done?: (err?: Error) => void) => {
          if (err || !client) return cb(err, client, done);

          setStatementTimeout(client)
            .then((c) => cb(null, c, done))
            .catch((e) => cb(e as Error, client, done));
        },
      ) as Promise<PoolClient>;
    };
  }

  /** Unique identity for this process instance (e.g. for presence.node_id). */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Listen client handler for Postgres NOTIFY events.
   * @param client - The Postgres client to wire handlers to.
   */
  private wireListenClientHandlers(client: Client): void {
    client.on('notification', (msg: { channel: string; payload?: string }) => {
      const { channel, payload } = msg;

      if (!payload) return;

      if (channel.startsWith(PG_ROOM_SHARD_CHANNEL_PREFIX)) {
        try {
          const data = JSON.parse(payload) as RoomMessagePayload;
          // We route to the logical room based on payload.room_id (per-room subscriptions preserved).
          this.emitter.emit(PgEmitterEvent.RoomMessage, data.room_id, data);
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
    for (const channel of this.shardChannelCounts.keys()) {
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
   * Subscribe to Postgres notifications for a specific room.
   *
   * Reference-counted at the shard level: LISTEN is issued only when shard count goes 0 → 1.
   * The Map update is safe without a mutex because Node.js is single-threaded
   * and there is no await between the read and the write; the only async
   * failure surface is the LISTEN call itself, which we roll back on error.
   */
  async subscribeToRoomChannel(roomId: string): Promise<void> {
    const roomCount = this.roomSubscriptionCounts.get(roomId) ?? 0;
    this.roomSubscriptionCounts.set(roomId, roomCount + 1);

    const shard = getRoomShardForRoomId(roomId, PG_ROOM_SHARD_COUNT);
    const channel = getRoomShardNotifyChannel(shard);
    const shardCount = this.shardChannelCounts.get(channel) ?? 0;
    const newShardCount = shardCount + 1;
    this.shardChannelCounts.set(channel, newShardCount);

    if (shardCount === 0) {
      try {
        await this.listenClient.query(`LISTEN "${channel}"`);
      } catch (err) {
        // Roll back shard ref count if LISTEN fails so our in-memory state stays consistent.
        const rollbackShardCount = this.shardChannelCounts.get(channel) ?? 0;
        const decrementedShard = rollbackShardCount - 1;
        if (decrementedShard <= 0) {
          this.shardChannelCounts.delete(channel);
        } else {
          this.shardChannelCounts.set(channel, decrementedShard);
        }

        // Also roll back the room subscription count we incremented above.
        const rollbackRoomCount = this.roomSubscriptionCounts.get(roomId) ?? 0;
        const decrementedRoom = rollbackRoomCount - 1;
        if (decrementedRoom <= 0) {
          this.roomSubscriptionCounts.delete(roomId);
        } else {
          this.roomSubscriptionCounts.set(roomId, decrementedRoom);
        }
        throw err;
      }
    }
  }

  /**
   * Unsubscribe from a room.
   *
   * Reference-counted at the shard level: UNLISTEN only when shard count reaches 0.
   * As with subscribe, the Map read-modify-write is synchronous and safe without a mutex;
   * if the UNLISTEN call fails, we restore the previous count before rethrowing.
   */
  async unsubscribeFromRoomChannel(roomId: string): Promise<void> {
    const roomCount = this.roomSubscriptionCounts.get(roomId) ?? 0;
    if (roomCount === 0) return;

    const newRoomCount = roomCount - 1;
    if (newRoomCount <= 0) {
      this.roomSubscriptionCounts.delete(roomId);
    } else {
      this.roomSubscriptionCounts.set(roomId, newRoomCount);
    }

    const shard = getRoomShardForRoomId(roomId, PG_ROOM_SHARD_COUNT);
    const channel = getRoomShardNotifyChannel(shard);
    const shardCount = this.shardChannelCounts.get(channel) ?? 0;
    if (shardCount === 0) return;

    const newShardCount = shardCount - 1;
    if (newShardCount === 0) {
      this.shardChannelCounts.delete(channel);
      try {
        await this.listenClient.query(`UNLISTEN "${channel}"`);
      } catch (err) {
        // Restore previous count if UNLISTEN fails so we do not lose the subscription.
        const existing = this.shardChannelCounts.get(channel) ?? 0;
        this.shardChannelCounts.set(channel, existing + 1);
        throw err;
      }
    } else {
      this.shardChannelCounts.set(channel, newShardCount);
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
