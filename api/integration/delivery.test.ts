import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

const receiver = vi.hoisted(() => ({ origin: "" }));
// Only the test receiver's exact origin bypasses destination validation.
// HTTP, signatures, Prisma, Redis, BullMQ and the worker are all real.
// The production security policy remains unchanged and has its own unit suite.
vi.mock("../src/lib/network", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/network")>();
  return {
    ...actual,
    assertSafeWebhookUrl: (raw: string) => {
      if (receiver.origin && new URL(raw).origin === receiver.origin) return Promise.resolve(new URL(raw));
      return actual.assertSafeWebhookUrl(raw);
    },
  };
});

import { prisma } from "../src/db";
import { createApp } from "../src/app";
import { deliveryQueue, enqueueDelivery } from "../src/queue/deliveryQueue";
import { reconcilePendingDeliveries } from "../src/queue/reconcile";
import { recoverStaleProcessingDeliveries } from "../src/queue/processingRecovery";
import { verifySignature } from "../src/lib/signature";

const apiKey = `integration-${randomUUID()}`;
const secret = `integration-secret-${randomUUID()}`;
const receipts: Array<{ body: string; headers: IncomingHttpHeaders }> = [];
let tenantId: string;
let subscriptionId: string;
let api: Server;
let sink: Server;
let apiOrigin: string;
let worker: typeof import("../src/queue/deliveryWorker");
let responseStatus = 200;
let releaseResponse: (() => void) | undefined;
let holdResponse = false;
const oldSignals = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function request(path: string, body?: unknown, key?: string) {
  return fetch(`${apiOrigin}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function waitUntil(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for delivery state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function settled(id: string, status = "SUCCEEDED", run = 1) {
  await waitUntil(async () => {
    const row = await prisma.delivery.findUniqueOrThrow({ where: { id } });
    return row.status === status && row.runNumber === run;
  });
  await waitUntil(async () => {
    const counts = await deliveryQueue.getJobCounts("active", "wait", "delayed");
    return Object.values(counts).every((n) => n === 0);
  });
  return prisma.delivery.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: [{ runNumber: "asc" }, { attemptNumber: "asc" }] } } });
}
async function publish(type = "order.created", key = randomUUID()) {
  const response = await request("/events", { type, payload: { orderId: key } }, key);
  expect(response.status).toBe(202);
  const result = await response.json();
  const delivery = await prisma.delivery.findFirstOrThrow({ where: { eventId: result.event.id } });
  return delivery.id;
}
async function durable(status: "PENDING" | "PROCESSING", attemptCount = 0, maxAttempts = 8) {
  const event = await prisma.event.create({ data: { tenantId, type: "order.created", payload: { recovery: true } } });
  const stale = new Date(Date.now() - 10_000);
  return prisma.delivery.create({ data: {
    eventId: event.id, subscriptionId, status, attemptCount, maxAttempts,
    ...(status === "PROCESSING" ? { lastAttemptAt: stale, processingHeartbeatAt: stale } : {}),
  } });
}

beforeAll(async () => {
  await prisma.$connect();
  await deliveryQueue.waitUntilReady();
  // Dedicated Redis instance/DB enforced by config. Clear stale test queue jobs.
  await deliveryQueue.obliterate({ force: true });
  const tenant = await prisma.tenant.create({ data: {
    name: "integration", apiKeyHash: createHash("sha256").update(apiKey).digest("hex"),
  } });
  tenantId = tenant.id;
  sink = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    receipts.push({ body: Buffer.concat(chunks).toString(), headers: req.headers });
    const finish = () => {
      if (res.writableEnded) return;
      res.writeHead(responseStatus);
      res.end("receiver response");
    };
    if (holdResponse) releaseResponse = finish;
    else finish();
  });
  receiver.origin = await listen(sink);
  const subscription = await prisma.subscription.create({ data: {
    tenantId, targetUrl: `${receiver.origin}/webhook`, eventTypes: ["order.created"], secret,
  } });
  subscriptionId = subscription.id;
  api = createServer(createApp());
  apiOrigin = await listen(api);
  worker = await import("../src/queue/deliveryWorker");
  await worker.deliveryWorker.waitUntilReady();
});

afterAll(async () => {
  holdResponse = false;
  releaseResponse?.();
  await close(api);
  if (worker) await worker.shutdown("integration teardown");
  else {
    await deliveryQueue.close();
    const { redisConnection } = await import("../src/queue/connection");
    await redisConnection.quit();
  }
  await close(sink);
  // Cascade cleanup is restricted to this run's generated tenant.
  if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!oldSignals[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
});

describe("real delivery pipeline", () => {
  it("publishes concurrently with one durable fan-out, signs HTTP and preserves replay history", async () => {
    const before = receipts.length;
    const key = randomUUID();
    const payload = { type: "order.created", payload: { orderId: key } };
    const responses = await Promise.all(Array.from({ length: 4 }, () => request("/events", payload, key)));
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202]);
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    const rows = await prisma.delivery.findMany({ where: { eventId: results[0].event.id } });
    expect(rows).toHaveLength(1);
    const id = rows[0]!.id;
    await settled(id);
    expect(receipts.length - before).toBe(1);
    const received = receipts[before]!;
    expect(JSON.parse(received.body).data).toEqual(payload.payload);
    expect(verifySignature(received.body, secret, String(received.headers["webhook-signature"]))).toBe(true);
    expect(received.headers["webhook-delivery-id"]).toBe(id);
    expect(received.headers["webhook-delivery-run"]).toBe("1");
    expect((await request("/events", { ...payload, payload: { changed: true } }, key)).status).toBe(409);
    expect((await request(`/deliveries/${id}/replay`, {})).status).toBe(200);
    const replay = await settled(id, "SUCCEEDED", 2);
    expect(replay.attemptCount).toBe(1);
    expect(replay.attempts.map((a) => [a.runNumber, a.attemptNumber])).toEqual([[1, 1], [2, 1]]);
    expect(receipts.length - before).toBe(2);
    expect(receipts.at(-1)!.headers["webhook-delivery-run"]).toBe("2");
    // Project an old job after replay; it must not send or mutate the newer run.
    await enqueueDelivery(id, 1, 1);
    await settled(id, "SUCCEEDED", 2);
    expect(receipts.length - before).toBe(2);
  });

  it("repairs missing Redis work from durable PostgreSQL intent", async () => {
    const row = await durable("PENDING");
    const before = receipts.length;
    await reconcilePendingDeliveries();
    await settled(row.id);
    expect(receipts.length - before).toBe(1);
  });

  it("retries a real HTTP failure with preserved attempt history", async () => {
    responseStatus = 503;
    const id = await publish();
    await waitUntil(async () => (await prisma.delivery.findUniqueOrThrow({ where: { id } })).status === "RETRYING");
    responseStatus = 200;
    const result = await settled(id);
    expect(result.attemptCount).toBe(2);
    expect(result.attempts.map((a) => a.responseStatus)).toEqual([503, 200]);
  });

  it("recovers abandoned claims once across concurrent recovery passes", async () => {
    const row = await durable("PROCESSING", 1);
    const before = receipts.length;
    const passes = await Promise.all([recoverStaleProcessingDeliveries(), recoverStaleProcessingDeliveries()]);
    expect(passes.reduce((n, p) => n + p.recovered, 0)).toBe(1);
    const result = await settled(row.id);
    expect(result.attemptCount).toBe(2);
    expect(receipts.length - before).toBe(1);
    expect(result.attempts.map((a) => a.attemptNumber)).toEqual([2]);
  });

  it("exhausts a stale final attempt without penalizing the subscriber", async () => {
    const row = await durable("PROCESSING", 2, 2);
    const before = receipts.length;
    await recoverStaleProcessingDeliveries();
    await settled(row.id, "FAILED");
    expect(receipts.length).toBe(before);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).consecutiveFailures).toBe(0);
  });

  it("refreshes an active lease and drains an in-flight HTTP request on shutdown", async () => {
    holdResponse = true;
    const before = receipts.length;
    const id = await publish();
    await waitUntil(async () => receipts.length > before);
    const first = await prisma.delivery.findUniqueOrThrow({ where: { id } });
    await waitUntil(async () => {
      const row = await prisma.delivery.findUniqueOrThrow({ where: { id } });
      return row.processingHeartbeatAt!.getTime() > first.processingHeartbeatAt!.getTime();
    });
    let drained = false;
    const stopping = worker.shutdown("integration drain").then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(drained).toBe(false);
    holdResponse = false;
    releaseResponse!();
    await stopping;
    expect(drained).toBe(true);
    const result = await prisma.delivery.findUniqueOrThrow({ where: { id }, include: { attempts: true } });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.processingHeartbeatAt).toBeNull();
    expect(result.attempts).toHaveLength(1);
  });
});
