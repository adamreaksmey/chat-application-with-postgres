import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { RoomsController } from './rooms.controller';
import { PostgresModule } from '../postgres/postgres.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PostgresModule, AuthModule],
  providers: [RoomsService],
  controllers: [RoomsController],
  exports: [RoomsService],
})
export class RoomsModule {}
