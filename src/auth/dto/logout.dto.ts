import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class LogoutDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sessionId?: string;
}
