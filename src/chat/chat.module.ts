import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatWsService } from './chat-ws.service';
import { ChatController } from './chat.controller';
import { PostgresModule } from '../postgres/postgres.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { RoomsModule } from '../rooms/rooms.module';

@Module({
  imports: [PostgresModule, UsersModule, AuthModule, RoomsModule],
  providers: [ChatService, ChatWsService],
  controllers: [ChatController],
  exports: [ChatWsService],
})
export class ChatModule {}
