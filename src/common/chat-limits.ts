/** Max message content length (characters) for HTTP and WebSocket. */
export const MAX_MESSAGE_LENGTH = 64 * 1024; // 64 KB

/** Skip sending to a WebSocket when its send buffer exceeds this (bytes). */
export const WS_BACKPRESSURE_THRESHOLD_BYTES = 256 * 1024; // 256 KB
