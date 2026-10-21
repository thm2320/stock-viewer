import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

async function bootstrap() {
  // Fail fast with a clean message before Nest builds the module graph
  let port: number;
  try {
    ({ port } = loadConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(port);
}
await bootstrap();
