import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

// Feature modules (to be implemented in later phases)
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { RoomsModule } from './rooms/rooms.module';
import { UsersModule } from './users/users.module';
import { PostgresModule } from './postgres/postgres.module';

@Module({
  imports: [AuthModule, ChatModule, RoomsModule, UsersModule, PostgresModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
