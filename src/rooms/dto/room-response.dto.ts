import { ApiProperty } from '@nestjs/swagger';

export class RoomDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  created_by: string | null;

  @ApiProperty()
  created_at: Date;
}

export class JoinLeaveResponseDto {
  @ApiProperty()
  success: boolean;
}
