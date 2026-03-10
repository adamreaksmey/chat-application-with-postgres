import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server as WebSocketServer, WebSocket } from 'ws';
import { ParsedUrlQuery, parse as parseQuery } from 'querystring';
import { IncomingMessage } from 'http';
import {
  ChatService,
  JoinRoomPayload,
  SendMessagePayload,
  TypingPayload,
} from './chat.service';
import { PostgresService } from '../postgres/postgres.service';
import { WsClientEvent, WsServerEvent } from '../common/ws-events';

/** WebSocket with authenticated user id and heartbeat alive flag. */
interface AuthedWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

/** Client message: { event, data }. */
interface IncomingFrame {
  event: string;
  data?: unknown;
}

const PRESENCE_SWEEP_INTERVAL_MS = 60_000;

/**
 * Raw WebSocket server for chat: JWT auth on connect, per-room tracking, and fanout
 * from Postgres NOTIFY to connected clients. Runs heartbeat and presence sweep.
 */
@Injectable()
export class ChatWsService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatWsService.name);
  private heartbeatInterval?: NodeJS.Timeout;
  private presenceSweepInterval?: NodeJS.Timeout;
  private readonly userSockets = new Map<string, Set<AuthedWebSocket>>();
  private readonly roomSockets = new Map<string, Set<AuthedWebSocket>>();

  /** Registers NOTIFY handlers that broadcast new_message, presence, and typing to room sockets. */
  constructor(
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
    private readonly postgres: PostgresService,
  ) {
    this.postgres.onRoomMessage((roomId, payload) => {
      this.broadcastToRoom(roomId, {
        event: WsServerEvent.NewMessage,
        data: payload,
      });
    });

    this.postgres.onPresence((payload) => {
      const { room_id: roomId } = payload as { room_id: string };
      this.broadcastToRoom(roomId, {
        event: WsServerEvent.Presence,
        data: payload,
      });
    });

    this.postgres.onTyping((payload) => {
      const { room_id: roomId } = payload as { room_id: string };
      this.broadcastToRoom(roomId, {
        event: WsServerEvent.Typing,
        data: payload,
      });
    });
  }

  /** Attaches connection handler to the WS server and starts heartbeat and presence sweep. */
  bind(wss: WebSocketServer): void {
    wss.on('connection', (socket: AuthedWebSocket, req: IncomingMessage) => {
      this.handleConnection(socket, req).catch((err) => {
        this.logger.error('WebSocket connection error', err);
        socket.close();
      });
    });

    this.startHeartbeat(wss);
    this.startPresenceSweep();
  }

  /** Clears heartbeat and presence sweep intervals. */
  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.presenceSweepInterval) {
      clearInterval(this.presenceSweepInterval);
    }
  }

  /** Schedules periodic deletion of stale presence rows (e.g. from crashed nodes). */
  private startPresenceSweep(): void {
    this.presenceSweepInterval = setInterval(() => {
      this.chatService
        .sweepStalePresence()
        .catch((err) =>
          this.logger.warn('Presence sweep failed', err as Error),
        );
    }, PRESENCE_SWEEP_INTERVAL_MS);
  }

  /** Authenticates the request, tracks the socket by user and room, and wires message/close/error. */
  private async handleConnection(
    socket: AuthedWebSocket,
    req: IncomingMessage,
  ): Promise<void> {
    const userId = this.authenticate(req);
    if (!userId) {
      socket.close();
      return;
    }

    socket.userId = userId;
    socket.isAlive = true;

    let socketsForUser = this.userSockets.get(userId);
    if (!socketsForUser) {
      socketsForUser = new Set();
      this.userSockets.set(userId, socketsForUser);
    }
    socketsForUser.add(socket);

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', async (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as IncomingFrame;
        await this.handleFrame(socket, frame);
      } catch (err) {
        this.logger.warn('Invalid WS frame received', err as Error);
      }
    });

    socket.on('close', () => {
      this.cleanupSocket(socket);
    });

    socket.on('error', () => {
      this.cleanupSocket(socket);
    });
  }

  /** Reads JWT from query ?token= or Authorization: Bearer; returns user id or null. */
  private authenticate(req: IncomingMessage): string | null {
    const url = req.url ?? '';
    const [, queryString] = url.split('?');
    const query: ParsedUrlQuery = queryString ? parseQuery(queryString) : {};

    let token: string | undefined;

    if (typeof query.token === 'string') {
      token = query.token;
    }

    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice('Bearer '.length);
    }

    if (!token) {
      return null;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      }) as { sub: string };
      return payload.sub;
    } catch {
      return null;
    }
  }

  /** Dispatches incoming JSON frame by event to ChatService and updates room membership. */
  private async handleFrame(
    socket: AuthedWebSocket,
    frame: IncomingFrame,
  ): Promise<void> {
    const userId = socket.userId;
    if (!userId) {
      socket.close();
      return;
    }

    const { event, data } = frame;

    switch (event) {
      case WsClientEvent.JoinRoom: {
        const payload = data as JoinRoomPayload;
        this.addSocketToRoom(payload.room_id, socket);
        await this.chatService.handleJoinRoom(userId, socket, payload);
        break;
      }
      case WsClientEvent.LeaveRoom: {
        const payload = data as JoinRoomPayload;
        this.removeSocketFromRoom(payload.room_id, socket);
        await this.chatService.handleLeaveRoom(userId, payload);
        break;
      }
      case WsClientEvent.SendMessage: {
        const payload = data as SendMessagePayload;
        await this.chatService.handleSendMessage(userId, socket, payload);
        break;
      }
      case WsClientEvent.TypingStart: {
        const payload = data as TypingPayload;
        await this.chatService.handleTypingStart(userId, socket, payload);
        break;
      }
      case WsClientEvent.TypingStop: {
        const payload = data as TypingPayload;
        await this.chatService.handleTypingStop(userId, payload);
        break;
      }
      default:
        break;
    }
  }

  /** Every 30s pings all clients; terminates and cleans up those that don't pong. */
  private startHeartbeat(wss: WebSocketServer): void {
    this.heartbeatInterval = setInterval(() => {
      wss.clients.forEach((client) => {
        const socket = client as AuthedWebSocket;
        if (socket.isAlive === false) {
          this.cleanupSocket(socket);
          socket.terminate();
          return;
        }

        socket.isAlive = false;
        socket.ping();
      });
    }, 30_000);
  }

  /** Adds the socket to this node's set for the room (for broadcast targeting). */
  private addSocketToRoom(roomId: string, socket: AuthedWebSocket): void {
    let sockets = this.roomSockets.get(roomId);
    if (!sockets) {
      sockets = new Set();
      this.roomSockets.set(roomId, sockets);
    }
    sockets.add(socket);
  }

  /**
   * Removes the socket from the room set; unsubscribes from NOTIFY when the room becomes empty.
   * The Set mutation and size check are synchronous with no await between them, so we are safe
   * from double-execution (e.g. two cleanups both calling unsubscribeFromRoomChannel for the same
   * room): only one path can see size 0 and invoke unsubscribe; any ref-count edge case is covered
   * by the rollback logic in PostgresService.
   */
  private removeSocketFromRoom(roomId: string, socket: AuthedWebSocket): void {
    const sockets = this.roomSockets.get(roomId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.roomSockets.delete(roomId);
      this.postgres
        .unsubscribeFromRoomChannel(roomId)
        .catch((err) =>
          this.logger.warn('Unsubscribe room channel failed', err),
        );
    }
  }

  /**
   * Removes the socket from user and room maps and unsubscribes empty rooms from NOTIFY.
   * The Set mutation and size check are synchronous with no await between them, so we are safe
   * from double-execution (e.g. two cleanups both calling unsubscribeFromRoomChannel for the same
   * room): only one path can see size 0 and invoke unsubscribe; any ref-count edge case is covered
   * by the rollback logic in PostgresService.
   */
  private cleanupSocket(socket: AuthedWebSocket): void {
    const userId = socket.userId;
    if (userId) {
      const socketsForUser = this.userSockets.get(userId);
      if (socketsForUser) {
        socketsForUser.delete(socket);
        if (socketsForUser.size === 0) {
          this.userSockets.delete(userId);
        }
      }
    }

    for (const [roomId, sockets] of this.roomSockets.entries()) {
      if (sockets.has(socket)) {
        sockets.delete(socket);
        if (sockets.size === 0) {
          this.roomSockets.delete(roomId);
          this.postgres
            .unsubscribeFromRoomChannel(roomId)
            .catch((err) =>
              this.logger.warn('Unsubscribe room channel failed', err),
            );
        }
      }
    }
  }

  /** Sends the JSON message to every open socket in the room on this node. */
  private broadcastToRoom(
    roomId: string,
    message: { event: string; data: unknown },
  ): void {
    const sockets = this.roomSockets.get(roomId);
    if (!sockets) {
      return;
    }

    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
