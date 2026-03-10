import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  // Swagger (OpenAPI) setup – primarily for local development and inspection.
  const config = new DocumentBuilder()
    .setTitle('Postgres-native chat API')
    .setDescription(
      'HTTP API surface for auth, rooms, and message history for the Postgres-native chat app.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const httpServer = app.getHttpServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const chatWsService = app.get(ChatWsService);
  chatWsService.bind(wss);

  await app.listen(port);
  // Log useful URLs on startup.
  // Note: when running behind Nginx, external base URL may differ, but path /docs is stable.
  // eslint-disable-next-line no-console
  console.log(`HTTP server listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log(`Swagger docs available at http://localhost:${port}/docs`);
}
bootstrap();
