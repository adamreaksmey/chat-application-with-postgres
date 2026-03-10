import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { Server as WebSocketServer } from 'ws';
import { AppModule } from './app.module';
import { ChatWsService } from './chat/chat-ws.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: true,
    credentials: true,
  });

  app.use(cookieParser());

  const port = Number(process.env.PORT) || 3000;

  const httpServer = app.getHttpServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const chatWsService = app.get(ChatWsService);
  chatWsService.bind(wss);

  await app.listen(port);
}
bootstrap();
