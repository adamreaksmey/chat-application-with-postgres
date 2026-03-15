import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt.strategy';
import { PostgresService } from '../postgres/postgres.service';
import { RoomsService } from '../rooms/rooms.service';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { MessageDto, PaginatedMessagesDto } from './dto/message-response.dto';
import { MAX_MESSAGE_LENGTH } from '../common/chat-limits';

class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_LENGTH)
  content: string;
}

@ApiTags('chat')
@ApiBearerAuth('access-token')
@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly postgres: PostgresService,
    private readonly roomsService: RoomsService,
  ) {}

  @Get(':id/messages')
  @ApiOperation({ summary: 'Get paginated message history for a room' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Seq cursor; returns messages with seq < cursor when provided',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max number of messages to return (default 50, max 100)',
  })
  @ApiOkResponse({
    description: 'Messages and next_cursor for pagination',
    type: PaginatedMessagesDto,
  })
  async getMessages(
    @Req() req: Request,
    @Param('id') roomId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
  ): Promise<PaginatedMessagesDto> {
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
          SELECT id, seq, room_id, user_id, content, created_at
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
          SELECT id, seq, room_id, user_id, content, created_at
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

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Send a message to a room via HTTP (in addition to WebSocket)',
  })
  @ApiBody({ type: SendMessageDto })
  @ApiOkResponse({
    description:
      'Created message (id, seq, room_id, user_id, content, created_at)',
    type: MessageDto,
  })
  async postMessage(
    @Req() req: Request,
    @Param('id') roomId: string,
    @Body() body: SendMessageDto,
  ): Promise<MessageDto> {
    const user = req.user as JwtPayload;
    const isMember = await this.roomsService.isMember(user.sub, roomId);
    if (!isMember) {
      throw new ForbiddenException('Not a member of this room');
    }

    const result = await this.postgres.query<MessageDto>(
      `
        INSERT INTO messages (room_id, user_id, content)
        VALUES ($1, $2, $3)
        RETURNING id, seq, room_id, user_id, content, created_at
      `,
      [roomId, user.sub, body.content],
    );

    return result.rows[0];
  }
}
