import { ApiProperty } from '@nestjs/swagger';

export class MessageDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  seq: number;

  @ApiProperty()
  room_id: string;

  @ApiProperty()
  user_id: string;

  @ApiProperty()
  content: string;

  @ApiProperty()
  created_at: Date;
}

export class PaginatedMessagesDto {
  @ApiProperty({ type: () => MessageDto, isArray: true })
  messages: MessageDto[];

  @ApiProperty({ nullable: true })
  next_cursor: number | null;
}
