import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const { clients } = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock("@twelvedata/twelvedata-node", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeClient extends EventEmitter {
    connect = vi.fn(async () => {});
    disconnect = vi.fn();
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    constructor() {
      super();
      clients.push(this);
    }
  }
  return { TwelvedataWebSocketClient: FakeClient };
});
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = vi.fn();
  },
  BatchWriteItemCommand: class {},
}));

import { StreamFeederService } from "./ws-feeder-service.ts";
import type { RedisSink } from "./redis-sink.ts";

const IDLE_TTL_MS = 600_000;

function setup(maxSymbols = 3, stored: string[] = []) {
  const redisSink = {
    publish: vi.fn(),
    close: vi.fn(),
    addDynamicSymbol: vi.fn(async () => {}),
    removeDynamicSymbol: vi.fn(async () => {}),
    loadDynamicSymbols: vi.fn(async () => stored),
  };
  const feeder = new StreamFeederService({
    symbols: ["AAPL"],
    redisSink: redisSink as unknown as RedisSink,
    maxSymbols,
    idleTtlMs: IDLE_TTL_MS,
  });
  const client = clients.at(-1) as EventEmitter & {
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
  const confirm = (symbol: string, success = true) => {
    const item = { symbol, exchange: "", mic_code: "", country: "", type: "" };
    client.emit("subscribe-status", {
      event: "subscribe-status",
      status: "ok",
      success: success ? [item] : [],
      fails: success ? [] : [item],
    });
  };
  return { feeder, redisSink, client, confirm };
}

describe("StreamFeederService subscriptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("subscribes and persists a confirmed symbol", async () => {
    const { feeder, redisSink, client, confirm } = setup();
    const result = feeder.addSymbol("MSFT");
    confirm("MSFT");
    expect(await result).toEqual({ ok: true });
    expect(client.subscribe).toHaveBeenCalledWith("MSFT");
    expect(redisSink.addDynamicSymbol).toHaveBeenCalledWith("MSFT");
    expect(feeder.getSubscriptions()).toEqual({ pinned: ["AAPL"], dynamic: ["MSFT"] });
  });

  it("rejects with capacity at the limit without evicting", async () => {
    const { feeder, client, confirm } = setup(2);
    const first = feeder.addSymbol("MSFT");
    confirm("MSFT");
    await first;
    expect(await feeder.addSymbol("TSLA")).toEqual({ ok: false, error: "capacity" });
    expect(client.unsubscribe).not.toHaveBeenCalled();
    expect(feeder.getSubscriptions().dynamic).toEqual(["MSFT"]);
  });

  it("is idempotent and refreshes lastRequestedAt", async () => {
    const { feeder, client, confirm } = setup();
    const first = feeder.addSymbol("MSFT");
    confirm("MSFT");
    await first;
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS - 1_000);
    expect(await feeder.addSymbol("MSFT")).toEqual({ ok: true });
    expect(client.subscribe).toHaveBeenCalledTimes(1);

    // Would have been swept without the refresh
    await vi.advanceTimersByTimeAsync(2_000);
    (feeder as any).sweepIdle();
    expect(feeder.getSubscriptions().dynamic).toEqual(["MSFT"]);
  });

  it("returns unsupported and rolls back when the subscribe fails", async () => {
    const { feeder, redisSink, client, confirm } = setup();
    const result = feeder.addSymbol("NOPE");
    confirm("NOPE", false);
    expect(await result).toEqual({ ok: false, error: "unsupported" });
    expect(client.unsubscribe).toHaveBeenCalledWith("NOPE");
    expect(redisSink.addDynamicSymbol).not.toHaveBeenCalled();
    expect(feeder.getSubscriptions().dynamic).toEqual([]);
  });

  it("rolls back and returns unsupported on timeout", async () => {
    const { feeder, client } = setup();
    const result = feeder.addSymbol("SLOW");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual({ ok: false, error: "unsupported" });
    expect(client.unsubscribe).toHaveBeenCalledWith("SLOW");
    expect(feeder.getSubscriptions().dynamic).toEqual([]);
  });

  it("sweeps idle dynamic symbols but never pinned ones", async () => {
    const { feeder, redisSink, client, confirm } = setup();
    await feeder.start();
    const added = feeder.addSymbol("MSFT");
    confirm("MSFT");
    await added;

    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + 60_000);
    expect(client.unsubscribe).toHaveBeenCalledWith("MSFT");
    expect(client.unsubscribe).not.toHaveBeenCalledWith("AAPL");
    expect(redisSink.removeDynamicSymbol).toHaveBeenCalledWith("MSFT");
    expect(feeder.getSubscriptions()).toEqual({ pinned: ["AAPL"], dynamic: [] });
    await feeder.stop();
  });

  it("restores persisted dynamic symbols on start", async () => {
    const { feeder, client } = setup(3, ["MSFT", "AAPL"]);
    await feeder.start();
    expect(client.subscribe).toHaveBeenCalledWith(["MSFT"]);
    expect(feeder.getSubscriptions()).toEqual({ pinned: ["AAPL"], dynamic: ["MSFT"] });
    await feeder.stop();
  });
});
