import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatWsService } from './chat-ws.service';
import { PostgresModule } from '../postgres/postgres.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PostgresModule, UsersModule, AuthModule],
  providers: [ChatService, ChatWsService],
  exports: [ChatWsService],
})
export class ChatModule {}
