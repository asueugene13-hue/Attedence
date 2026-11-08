import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { loadLocalEnvFile } from './config/load-env-file.js';
import { configureApp } from './configure-app.js';

async function bootstrap(): Promise<void> {
  loadLocalEnvFile();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const config = app.get(AppConfig);
  await app.listen(config.port);
  app.get(Logger).log(`AttendSure API listening on port ${config.port} (${config.nodeEnv})`);
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (for example, when configuration is invalid), so write to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
