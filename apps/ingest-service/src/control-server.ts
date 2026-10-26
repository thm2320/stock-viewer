// src/control-server.ts
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isValidSymbol } from "@repo/shared";
import type { SubscribeError, SubscribeResponse } from "@repo/shared";
import type { StreamFeederService } from "./ws-feeder-service.ts";

const MAX_BODY_BYTES = 1_024;

interface ControlServerConfig {
  port: number;
  token: string;
  feeder: StreamFeederService;
}

export class ControlServer {
  private server: Server;
  private config: ControlServerConfig;

  constructor(config: ControlServerConfig) {
    this.config = config;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        console.error("[Control] Request failed:", error);
        if (!res.headersSent) send(res, 500, {});
        else res.end();
      });
    });
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, () => {
        this.server.off("error", reject);
        console.log(`[Control] Listening on port ${this.config.port}.`);
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) return send(res, 401, {});
    if (req.url !== "/subscriptions") return send(res, 404, {});

    if (req.method === "GET") {
      return send(res, 200, this.config.feeder.getSubscriptions());
    }
    if (req.method !== "POST") return send(res, 405, {});

    const body = await readJson(req);
    const symbol = (body as { symbol?: unknown } | null)?.symbol;
    if (!isValidSymbol(symbol)) {
      return send(res, 400, { error: "invalid" } satisfies SubscribeError);
    }

    const result = await this.config.feeder.addSymbol(symbol);
    if (result.ok) {
      return send(res, 200, { symbol } satisfies SubscribeResponse);
    }
    const status = result.error === "capacity" ? 409 : 422;
    send(res, status, { error: result.error } satisfies SubscribeError);
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const given = Buffer.from(String(req.headers["x-ingest-token"] ?? ""));
    const expected = Buffer.from(this.config.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Resolves null for a malformed or oversized body
async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
