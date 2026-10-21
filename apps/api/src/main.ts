import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
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
    app.useWebSocketAdapter(new WsAdapter(app));
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
