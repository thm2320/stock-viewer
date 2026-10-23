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
  try {
    const app = await NestFactory.create(AppModule);
    // No adapter call needed: Nest uses IoAdapter when platform-socket.io is installed
    app.enableShutdownHooks();
    await app.listen(port);
  } catch (error) {
    // Startup failures (e.g. Redis unreachable) are already logged by their source
    console.error(
      `Startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
await bootstrap();
