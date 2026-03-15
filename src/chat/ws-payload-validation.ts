import {
  JoinRoomPayload,
  SendMessagePayload,
  TypingPayload,
} from './chat.service';
import { MAX_MESSAGE_LENGTH } from '../common/chat-limits';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isOptionalNumber(v: unknown): v is number | undefined | null {
  return (
    v === undefined || v === null || (typeof v === 'number' && !Number.isNaN(v))
  );
}

/** Invalid branch of ValidationResult; use when sending error frames. */
export type ValidationError = {
  valid: false;
  message: string;
  code?: string;
};

export type ValidationResult<T> = { valid: true; payload: T } | ValidationError;

export function validateJoinRoomPayload(
  data: unknown,
): ValidationResult<JoinRoomPayload> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      message: 'Payload must be an object',
      code: 'invalid_payload',
    };
  }
  const o = data as Record<string, unknown>;
  const room_id = o.room_id;
  if (!isNonEmptyString(room_id)) {
    return {
      valid: false,
      message: 'room_id is required and must be a non-empty string',
      code: 'invalid_payload',
    };
  }
  const last_seen_seq = o.last_seen_seq;
  if (!isOptionalNumber(last_seen_seq)) {
    return {
      valid: false,
      message: 'last_seen_seq must be a number if present',
      code: 'invalid_payload',
    };
  }
  return {
    valid: true,
    payload: {
      room_id: room_id.trim(),
      last_seen_seq:
        typeof last_seen_seq === 'number' ? last_seen_seq : undefined,
    },
  };
}

export function validateLeaveRoomPayload(
  data: unknown,
): ValidationResult<JoinRoomPayload> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      message: 'Payload must be an object',
      code: 'invalid_payload',
    };
  }
  const o = data as Record<string, unknown>;
  const room_id = o.room_id;
  if (!isNonEmptyString(room_id)) {
    return {
      valid: false,
      message: 'room_id is required and must be a non-empty string',
      code: 'invalid_payload',
    };
  }
  return { valid: true, payload: { room_id: room_id.trim() } };
}

export function validateSendMessagePayload(
  data: unknown,
): ValidationResult<SendMessagePayload> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      message: 'Payload must be an object',
      code: 'invalid_payload',
    };
  }
  const o = data as Record<string, unknown>;
  const room_id = o.room_id;
  if (!isNonEmptyString(room_id)) {
    return {
      valid: false,
      message: 'room_id is required and must be a non-empty string',
      code: 'invalid_payload',
    };
  }
  const content = o.content;
  if (typeof content !== 'string') {
    return {
      valid: false,
      message: 'content is required and must be a string',
      code: 'invalid_payload',
    };
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    return {
      valid: false,
      message: `content must not exceed ${MAX_MESSAGE_LENGTH} characters`,
      code: 'message_too_long',
    };
  }
  return {
    valid: true,
    payload: { room_id: room_id.trim(), content },
  };
}

export function validateTypingPayload(
  data: unknown,
): ValidationResult<TypingPayload> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      message: 'Payload must be an object',
      code: 'invalid_payload',
    };
  }
  const o = data as Record<string, unknown>;
  const room_id = o.room_id;
  if (!isNonEmptyString(room_id)) {
    return {
      valid: false,
      message: 'room_id is required and must be a non-empty string',
      code: 'invalid_payload',
    };
  }
  return { valid: true, payload: { room_id: room_id.trim() } };
}
