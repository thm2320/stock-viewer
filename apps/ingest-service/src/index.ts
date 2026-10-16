// src/index.ts
// import dotenv from 'dotenv';
// import { StockFeederService } from './FeederService';
// import { FeederConfig } from './types';

import { StockFeederService } from "./feeder-service.ts";


// dotenv.config();

// const config: FeederConfig = {
//   // Replace with your provider's WebSocket endpoint (e.g., Finnhub, Polygon.io, Alpaca)
//   websocketUrl: process.env.WS_FEED_URL || 'wss://ws.finnHub.io', 
//   apiKey: process.env.API_KEY || 'YOUR_API_KEY',
//   symbols: ['AAPL', 'TSLA', 'MSFT', 'AMZN', 'GOOGL'],
//   batchSize: 100,            // Flush when 100 items accumulate
//   flushIntervalMs: 1000,     // Or flush every 1 second max
// };

// const feeder = new StockFeederService(config);
const feeder = new StockFeederService({
    symbols:['AAPL'],
    // symbols:['SMGB'],
    pollIntervalMs:10000
});

console.log('Starting Stock Market Feeder Ingest Service...');
feeder.start();

// Handle graceful shutdown on signals
process.on('SIGINT', () => {
  console.log('\nStopping service due to SIGINT...');
  feeder.stop();
  process.exit(0);
});