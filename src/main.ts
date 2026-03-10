import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { Server as WebSocketServer, WebSocket } from 'ws';
import { AppModule } from './app.module';

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

  // Attach a raw WebSocket server to the underlying HTTP server.
  const httpServer = app.getHttpServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Placeholder connection handler; real logic will live in a dedicated WS/chat service.
  wss.on('connection', (socket: WebSocket) => {
    // For now, immediately close the socket until the auth and chat layers are implemented.
    socket.close();
  });

  await app.listen(port);
}
bootstrap();
