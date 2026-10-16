// src/PollingFeederService.ts
// import { PollingFeederConfig, NormalizedTick, RawQuoteResponse } from './types';
import {
  MarketDataApi,
  CreateConfig,
  TwelvedataApiError,
} from "@twelvedata/twelvedata-node";
import type { GetQuote200Response } from "@twelvedata/twelvedata-node";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
// import { TweleveDataQuote } from "./types.ts";

interface PollingFeederConfig {
  symbols: string[];
  pollIntervalMs: number;
}

export class StockFeederService {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private config: PollingFeederConfig;
  private apiKey: string = process.env.TWELVEDATA_API_KEY!;
  private api: MarketDataApi;
  private dynamoDb: DynamoDBClient;

  constructor(config: PollingFeederConfig) {
    this.config = config;
    this.api = new MarketDataApi(CreateConfig(this.apiKey));
    this.dynamoDb = new DynamoDBClient({
      region: process.env.AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL,
    });
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(
      `[PollingFeeder] Service started. Fetching every ${this.config.pollIntervalMs / 1000}s...`,
    );

    // Run immediately on start, then loop
    this.pollSymbols();

    this.timer = setInterval(() => {
      this.pollSymbols();
    }, this.config?.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[PollingFeeder] Service stopped gracefully.");
  }

  private async pollSymbols(): Promise<void> {
    // console.log(`[PollingFeeder] Starting poll cycle for symbols: ${this.config.symbols.join(', ')}`);
    console.log(`[PollingFeeder] Starting poll cycle for symbols: `);

    const timestamp = Date.now();

    // Fetch symbols in parallel
    const promises = this.config.symbols.map((symbol) =>
      this.fetchSymbolQuote(symbol, timestamp),
    );
    const records = await Promise.all(promises);
    // console.log(results);

    // const batch: NormalizedTick[] = [];

    // for (const result of results) {
    //   if (result.status === 'fulfilled' && result.value) {
    //     batch.push(result.value);
    //   }
    // }

    if (records.length > 0) {
      this.processBatch(records);
    }
  }

  //   private async fetchSymbolQuote(symbol: string, ingestTimestamp: number): Promise<NormalizedTick | null> {
  private async fetchSymbolQuote(
    symbol: string,
    ingestTimestamp: number,
  ): Promise<GetQuote200Response | undefined> {
    try {
      const response: GetQuote200Response = await this.api.getQuote({
        interval: "1day",
        symbol,
        // outputsize: 50,
      });
      return response;
    } catch (error) {
      if (error instanceof TwelvedataApiError) {
        console.error("API error:", error);
      } else {
        console.error("Unexpected error:", error);
      }
    }
  }

  //   private normalize(symbol: string, raw: RawQuoteResponse, ingestTimestamp: number): NormalizedTick {
  //     return {
  //       symbol,
  //       price: raw.c,
  //       high: raw.h,
  //       low: raw.l,
  //       open: raw.o,
  //       previousClose: raw.pc,
  //       exchangeTimestamp: raw.t ? raw.t * 1000 : ingestTimestamp, // Convert seconds to ms if needed
  //       ingestTimestamp,
  //       type: 'quote',
  //     };
  //   }

  private async processBatch(
    batch: (GetQuote200Response | undefined)[],
  ): Promise<void> {
    // Downstream sink logic (e.g., insert into DB, write to file, push to queue)
    console.log(`[Sink] Processed batch of ${batch.length} quotes:`);
    for (const tick of batch) {
      if (tick) {
        const command = new PutItemCommand({
          TableName: process.env.DYNAMODB_TABLE_NAME,
          Item: {
            symbol:{
                S: tick.symbol
            },
            timestamp: {
                N: `${tick.timestamp}`
            },
          },
        });
        this.dynamoDb.send(command);
      }
      // console.log(` -> ${tick.symbol}: $${tick.price} (High: $${tick.high}, Low: $${tick.low})`);
    }
  }
}
