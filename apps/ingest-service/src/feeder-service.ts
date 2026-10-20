// src/feeder-service.ts
import {
  MarketDataApi,
  CreateConfig,
  TwelvedataApiError,
} from "@twelvedata/twelvedata-node";
import type { GetQuote200Response } from "@twelvedata/twelvedata-node";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { normalize } from "./types.ts";

interface PollingFeederConfig {
  symbols: string[];
  pollIntervalMs: number;
}

export class StockFeederService {
  private isRunning = false;
  private isPolling = false;
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
      `[PollingFeeder] Service started. Fetching ${this.config.symbols.join(", ")} every ${this.config.pollIntervalMs / 1000}s...`,
    );

    // Run immediately on start, then loop
    this.runCycle();

    this.timer = setInterval(() => {
      this.runCycle();
    }, this.config.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[PollingFeeder] Service stopped gracefully.");
  }

  // Skip the tick if the previous cycle is still running
  private async runCycle(): Promise<void> {
    if (this.isPolling) {
      console.warn("[PollingFeeder] Previous cycle still running, skipping.");
      return;
    }
    this.isPolling = true;
    try {
      await this.pollSymbols();
    } catch (error) {
      console.error("[PollingFeeder] Poll cycle failed:", error);
    } finally {
      this.isPolling = false;
    }
  }

  private async pollSymbols(): Promise<void> {
    console.log(
      `[PollingFeeder] Starting poll cycle for symbols: ${this.config.symbols.join(", ")}`,
    );

    const ingestedAt = Date.now();

    // Fetch symbols in parallel
    const quotes = await Promise.all(
      this.config.symbols.map((symbol) => this.fetchSymbolQuote(symbol)),
    );
    const batch = quotes.filter(
      (quote): quote is GetQuote200Response => quote !== undefined,
    );

    if (batch.length > 0) {
      await this.processBatch(batch, ingestedAt);
    }
  }

  private async fetchSymbolQuote(
    symbol: string,
  ): Promise<GetQuote200Response | undefined> {
    try {
      return await this.api.getQuote({
        interval: "1min",
        symbol,
      });
    } catch (error) {
      if (error instanceof TwelvedataApiError) {
        console.error(`[PollingFeeder] API error for ${symbol}:`, error);
      } else {
        console.error(`[PollingFeeder] Unexpected error for ${symbol}:`, error);
      }
    }
  }

  private async processBatch(
    batch: GetQuote200Response[],
    ingestedAt: number,
  ): Promise<void> {
    const results = await Promise.allSettled(
      batch.map((quote) =>
        this.dynamoDb.send(
          new PutItemCommand({
            TableName: process.env.DYNAMODB_TABLE_NAME,
            Item: marshall(normalize(quote, ingestedAt), {
              removeUndefinedValues: true,
            }),
          }),
        ),
      ),
    );

    let written = 0;
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        written++;
      } else {
        console.error(
          `[Sink] Failed to write ${batch[i]!.symbol}:`,
          result.reason,
        );
      }
    });
    console.log(`[Sink] Wrote ${written}/${batch.length} quotes.`);
  }
}
