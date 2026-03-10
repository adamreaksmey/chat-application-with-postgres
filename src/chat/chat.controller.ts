import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt.strategy';
import { PostgresService } from '../postgres/postgres.service';
import { RoomsService } from '../rooms/rooms.service';

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly postgres: PostgresService,
    private readonly roomsService: RoomsService,
  ) {}

  @Get(':id/messages')
  async getMessages(
    @Req() req: Request,
    @Param('id') roomId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
  ) {
    const user = req.user as JwtPayload;
    const isMember = await this.roomsService.isMember(user.sub, roomId);
    if (!isMember) {
      throw new ForbiddenException('Not a member of this room');
    }

    const limit = Math.min(
      Math.max(parseInt(limitStr ?? '50', 10) || 50, 1),
      100,
    );
    const cursorSeq = cursor ? parseInt(cursor, 10) : null;

    if (cursorSeq != null && (Number.isNaN(cursorSeq) || cursorSeq < 1)) {
      throw new ForbiddenException('Invalid cursor');
    }

    let result;
    if (cursorSeq != null) {
      result = await this.postgres.query(
        `
          SELECT seq, room_id, user_id, content, created_at
          FROM messages
          WHERE room_id = $1 AND seq < $2
          ORDER BY seq DESC
          LIMIT $3
        `,
        [roomId, cursorSeq, limit],
      );
    } else {
      result = await this.postgres.query(
        `
          SELECT seq, room_id, user_id, content, created_at
          FROM messages
          WHERE room_id = $1
          ORDER BY seq DESC
          LIMIT $2
        `,
        [roomId, limit],
      );
    }

    const messages = result.rows;
    const nextCursor =
      messages.length === limit && messages.length > 0
        ? messages[messages.length - 1].seq
        : null;

    return {
      messages,
      next_cursor: nextCursor,
    };
  }
}
