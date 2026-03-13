import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt.strategy';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JoinLeaveResponseDto, RoomDto } from './dto/room-response.dto';

@ApiTags('rooms')
@ApiBearerAuth('access-token')
@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new room' })
  @ApiBody({ type: CreateRoomDto })
  @ApiOkResponse({ description: 'Created room', type: RoomDto })
  async create(
    @Req() req: Request,
    @Body() dto: CreateRoomDto,
  ): Promise<RoomDto> {
    const user = req.user as JwtPayload;
    return this.roomsService.createRoom(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all rooms' })
  @ApiOkResponse({
    description: 'Array of rooms',
    type: RoomDto,
    isArray: true,
  })
  async list(): Promise<RoomDto[]> {
    return this.roomsService.listRooms();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single room by id' })
  @ApiOkResponse({ description: 'Room details', type: RoomDto })
  async getOne(@Param('id') id: string): Promise<RoomDto> {
    return this.roomsService.getRoom(id);
  }

  @Post(':id/join')
  @ApiOperation({ summary: 'Join a room' })
  @ApiOkResponse({
    description: 'Join success flag',
    type: JoinLeaveResponseDto,
  })
  async join(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<JoinLeaveResponseDto> {
    const user = req.user as JwtPayload;
    await this.roomsService.joinRoom(user.sub, id);
    return { success: true };
  }

  @Post(':id/leave')
  @ApiOperation({ summary: 'Leave a room' })
  @ApiOkResponse({
    description: 'Leave success flag',
    type: JoinLeaveResponseDto,
  })
  async leave(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<JoinLeaveResponseDto> {
    const user = req.user as JwtPayload;
    await this.roomsService.leaveRoom(user.sub, id);
    return { success: true };
  }
}
