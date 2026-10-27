import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { ControlServer } from "./control-server.ts";
import type { StreamFeederService } from "./ws-feeder-service.ts";

const TOKEN = "test-token";

describe("ControlServer", () => {
  let server: ControlServer;
  let base: string;
  const feeder = {
    getSubscriptions: vi.fn(() => ({ pinned: ["AAPL"], dynamic: [] })),
    addSymbol: vi.fn(async () => ({ ok: true as const })),
  };

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    server = new ControlServer({
      port: 0,
      token: TOKEN,
      feeder: feeder as unknown as StreamFeederService,
    });
    await server.start();
    // port 0 picks a free port; read it back from the underlying server
    const { port } = (
      server as unknown as { server: { address(): AddressInfo } }
    ).server.address();
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    vi.restoreAllMocks();
  });

  it("serves GET /health without a token", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("keeps /subscriptions behind the token", async () => {
    expect((await fetch(`${base}/subscriptions`)).status).toBe(401);
    const wrong = await fetch(`${base}/subscriptions`, {
      headers: { "x-ingest-token": "nope" },
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/subscriptions`, {
      headers: { "x-ingest-token": TOKEN },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ pinned: ["AAPL"], dynamic: [] });
  });

  it("rejects POST /subscriptions without the token", async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: "POST",
      body: JSON.stringify({ symbol: "NVDA" }),
    });
    expect(res.status).toBe(401);
    expect(feeder.addSymbol).not.toHaveBeenCalled();
  });

  it("accepts POST /subscriptions with the token", async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: "POST",
      headers: { "x-ingest-token": TOKEN },
      body: JSON.stringify({ symbol: "NVDA" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ symbol: "NVDA" });
  });

  it("does not expose other routes without the token", async () => {
    expect((await fetch(`${base}/health/extra`)).status).toBe(401);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(
      401,
    );
  });
});
