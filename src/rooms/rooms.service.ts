import { Injectable, NotFoundException } from '@nestjs/common';
import { PostgresService } from '../postgres/postgres.service';
import { CreateRoomDto } from './dto/create-room.dto';

export interface Room {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: Date;
}

@Injectable()
export class RoomsService {
  constructor(private readonly postgres: PostgresService) {}

  async createRoom(userId: string, dto: CreateRoomDto): Promise<Room> {
    const result = await this.postgres.query<Room>(
      `
        INSERT INTO rooms (name, description, created_by)
        VALUES ($1, $2, $3)
        RETURNING id, name, description, created_by, created_at
      `,
      [dto.name, dto.description ?? null, userId],
    );
    return result.rows[0];
  }

  async listRooms(): Promise<Room[]> {
    const result = await this.postgres.query<Room>(
      `SELECT id, name, description, created_by, created_at FROM rooms ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  async getRoom(id: string): Promise<Room> {
    const result = await this.postgres.query<Room>(
      `SELECT id, name, description, created_by, created_at FROM rooms WHERE id = $1`,
      [id],
    );
    const room = result.rows[0];
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    return room;
  }

  async joinRoom(userId: string, roomId: string): Promise<void> {
    await this.getRoom(roomId);
    await this.postgres.query(
      `
        INSERT INTO room_members (room_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT (room_id, user_id) DO NOTHING
      `,
      [roomId, userId],
    );
  }

  async leaveRoom(userId: string, roomId: string): Promise<void> {
    await this.postgres.query(
      `DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId],
    );
  }

  async isMember(userId: string, roomId: string): Promise<boolean> {
    const result = await this.postgres.query<{ n: number }>(
      `SELECT 1 AS n FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId],
    );
    return result.rows.length > 0;
  }
}
