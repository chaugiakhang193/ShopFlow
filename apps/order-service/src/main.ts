import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const port = Number(
    app.get(ConfigService).getOrThrow<string>('ORDER_SERVICE_PORT'),
  );
  await app.listen(port, '127.0.0.1');
  Logger.log(
    `order-service listening on http://127.0.0.1:${port}`,
    'Bootstrap',
  );
}

await bootstrap();
