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

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateRoomDto) {
    const user = req.user as JwtPayload;
    return this.roomsService.createRoom(user.sub, dto);
  }

  @Get()
  async list() {
    return this.roomsService.listRooms();
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return this.roomsService.getRoom(id);
  }

  @Post(':id/join')
  async join(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as JwtPayload;
    await this.roomsService.joinRoom(user.sub, id);
    return { success: true };
  }

  @Post(':id/leave')
  async leave(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as JwtPayload;
    await this.roomsService.leaveRoom(user.sub, id);
    return { success: true };
  }
}
