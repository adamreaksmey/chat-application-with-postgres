/**
 * WebSocket event names used by the chat layer.
 * Centralized so client and server stay in sync and refactors are safe.
 */

/** Events sent by the client to the server (incoming frames). */
export enum WsClientEvent {
  JoinRoom = 'join_room',
  LeaveRoom = 'leave_room',
  SendMessage = 'send_message',
  TypingStart = 'typing_start',
  TypingStop = 'typing_stop',
}

/** Events sent by the server to the client (outgoing frames). */
export enum WsServerEvent {
  NewMessage = 'new_message',
  UserJoined = 'user_joined',
  UserLeft = 'user_left',
  Presence = 'presence',
  Typing = 'typing',
  History = 'history',
  Error = 'error',
}
