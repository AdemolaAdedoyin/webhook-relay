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
import { admitDeliveryAttempt } from "../src/queue/subscriptionThroughput";
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
let holdSlow = false;
let slowActive = 0;
let slowPeak = 0;
const slowReleases: Array<() => void> = [];
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
  await prisma.apiKey.create({ data: { tenantId, name: "integration admin", keyHash: tenant.apiKeyHash, scopes: ["admin"] } });
  sink = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    receipts.push({ body: Buffer.concat(chunks).toString(), headers: req.headers });
    const isSlow = req.url === "/slow";
    if (isSlow) { slowActive++; slowPeak = Math.max(slowPeak, slowActive); }
    const finish = () => {
      if (res.writableEnded) return;
      if (isSlow) slowActive--;
      res.writeHead(responseStatus);
      res.end("receiver response");
    };
    if (isSlow && holdSlow) slowReleases.push(finish);
    else if (holdResponse) releaseResponse = finish;
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
  slowReleases.forEach((release) => release());
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
  it("exposes readiness and request correlation while isolating tenant operations", async () => {
    const ready = await fetch(`${apiOrigin}/ready`, { headers: { "X-Request-Id": "integration-probe" } });
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-request-id")).toBe("integration-probe");
    expect(await ready.json()).toEqual({ status: "ready", checks: { postgres: true, redis: true } });
    const invalid = await fetch(`${apiOrigin}/health`, { headers: { "X-Request-Id": "unsafe value" } });
    expect(invalid.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const unauthorized = await fetch(`${apiOrigin}/v1/operations`);
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error.requestId).toBe(unauthorized.headers.get("x-request-id"));
    expect((await fetch(`${apiOrigin}/v1/operations/metrics`)).status).toBe(401);
    const other = await prisma.tenant.create({ data: {
      name: "other tenant", apiKeyHash: randomUUID(),
      events: { create: { type: "private", payload: {} } },
      subscriptions: { create: { targetUrl: "https://example.com", secret: "private-secret", eventTypes: [] } },
    }, include: { events: true, subscriptions: true } });
    try {
      await prisma.delivery.create({ data: { eventId: other.events[0]!.id, subscriptionId: other.subscriptions[0]!.id, status: "SUCCEEDED" } });
      const overview = await (await request("/operations")).json();
      expect(overview.events).toBe(0);
      expect(overview.subscriptions).toEqual({ ACTIVE: 1, PAUSED: 0, DISABLED: 0 });
      expect(Object.values(overview.deliveries)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(overview.staleProcessing).toBe(0);
      const metrics = await request("/operations/metrics");
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      const text = await metrics.text();
      expect(text).toContain('relay_subscriptions{status="ACTIVE"} 1');
      expect(text).toContain("relay_events 0\n");
      expect(text).not.toContain(other.id);
      expect(text).not.toContain("private-secret");
    } finally { await prisma.tenant.delete({ where: { id: other.id } }); }
  });

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
    const overview = await (await request("/operations")).json();
    expect(overview.events).toBe(1);
    expect(overview.deliveries.SUCCEEDED).toBe(1);
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
    expect((await (await request("/operations")).json()).staleProcessing).toBe(1);
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

  it("enforces distributed concurrency and rate admission without consuming deferred attempts", async () => {
    await worker.deliveryWorker.pause();
    const sub = await prisma.subscription.create({ data: {
      tenantId, targetUrl: `${receiver.origin}/admission`, eventTypes: ["admission"], secret,
      maxConcurrentDeliveries: 1, minDeliveryIntervalMs: 0,
    } });
    try {
      const event = await prisma.event.create({ data: { tenantId, type: "admission", payload: {} } });
      const rows = await Promise.all(Array.from({ length: 4 }, () => prisma.delivery.create({ data: { eventId: event.id, subscriptionId: sub.id } })));
      const results = await Promise.all(rows.map((row) => admitDeliveryAttempt(sub.id, row.id, 1, 1)));
      expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.status === "deferred")).toHaveLength(3);
      expect(await prisma.delivery.count({ where: { subscriptionId: sub.id, status: "PROCESSING" } })).toBe(1);
      const deferred = await prisma.delivery.findFirstOrThrow({ where: { subscriptionId: sub.id, status: "PENDING" } });
      expect(deferred.attemptCount).toBe(0);
      expect(await prisma.deliveryAttempt.count({ where: { deliveryId: deferred.id } })).toBe(0);
      // Test rate admission separately with spare concurrency and fresh rows.
      await prisma.delivery.updateMany({ where: { subscriptionId: sub.id, status: "PROCESSING" }, data: { status: "SUCCEEDED" } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { maxConcurrentDeliveries: 10, minDeliveryIntervalMs: 10_000 } });
      const fresh = await Promise.all(Array.from({ length: 2 }, () => prisma.delivery.create({ data: { eventId: event.id, subscriptionId: sub.id } })));
      expect((await admitDeliveryAttempt(sub.id, fresh[0]!.id, 1, 1)).status).toBe("claimed");
      // Plenty of concurrent capacity and no prior nextAttemptAt on this row:
      // only the shared rate gate can defer it.
      const rate = await admitDeliveryAttempt(sub.id, fresh[1]!.id, 1, 1);
      expect(rate.status).toBe("deferred");
      expect((await prisma.delivery.findUniqueOrThrow({ where: { id: fresh[1]!.id } })).attemptCount).toBe(0);
    } finally {
      await prisma.subscription.delete({ where: { id: sub.id } });
      await worker.deliveryWorker.resume();
    }
  });

  it("lets another subscriber progress while a capped subscriber waits and preserves retry budgets", async () => {
    const slow = await prisma.subscription.create({ data: {
      tenantId, targetUrl: `${receiver.origin}/slow`, eventTypes: ["throttle.slow"], secret,
      maxConcurrentDeliveries: 1, minDeliveryIntervalMs: 300,
    } });
    const fast = await prisma.subscription.create({ data: {
      tenantId, targetUrl: `${receiver.origin}/fast`, eventTypes: ["throttle.fast"], secret,
    } });
    holdSlow = true;
    slowPeak = 0;
    try {
      const responses = await Promise.all(Array.from({ length: 3 }, (_, i) => request("/events", { type: "throttle.slow", payload: { i } })));
      expect(responses.every((r) => r.status === 202)).toBe(true);
      await Promise.all(responses.map((r) => r.json()));
      await waitUntil(async () => slowReleases.length > 0);
      await waitUntil(async () => (await prisma.delivery.count({ where: { subscriptionId: slow.id, status: "PENDING", nextAttemptAt: { not: null } } })) === 2);
      const pending = await prisma.delivery.findMany({ where: { subscriptionId: slow.id, status: "PENDING" } });
      expect(pending.map((d) => d.attemptCount)).toEqual([0, 0]);
      const quick = await request("/events", { type: "throttle.fast", payload: {} });
      expect(quick.status).toBe(202);
      await quick.json();
      await waitUntil(async () => (await prisma.delivery.count({ where: { subscriptionId: fast.id, status: "SUCCEEDED" } })) === 1);
      expect(slowActive).toBe(1);
      holdSlow = false;
      slowReleases.forEach((release) => release());
      const rows = await prisma.delivery.findMany({ where: { subscriptionId: slow.id } });
      const completed = await Promise.all(rows.map((r) => settled(r.id)));
      expect(slowPeak).toBe(1);
      expect(completed.map((d) => d.attemptCount)).toEqual([1, 1, 1]);
      expect(completed.every((d) => d.attempts.length === 1)).toBe(true);
      const starts = completed.map((d) => d.lastAttemptAt!.getTime()).sort((a, b) => a - b);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(300);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(300);
    } finally {
      holdSlow = false;
      slowReleases.forEach((release) => release());
      await prisma.subscription.deleteMany({ where: { id: { in: [slow.id, fast.id] } } });
    }
  });

  it("validates throughput updates and refuses another tenant's subscription", async () => {
    async function patch(id: string, body: unknown) {
      return fetch(`${apiOrigin}/v1/subscriptions/${id}/limits`, {
        method: "PATCH", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    for (const invalid of [{}, { maxConcurrentDeliveries: 0 }, { minDeliveryIntervalMs: -1 }, { maxConcurrentDeliveries: 1.5 }]) {
      expect((await patch(subscriptionId, invalid)).status).toBe(422);
    }
    const updated = await patch(subscriptionId, { maxConcurrentDeliveries: 3, minDeliveryIntervalMs: 0 });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.maxConcurrentDeliveries).toBe(3);
    expect(body.secret).toBeUndefined();
    expect(body.nextDeliveryAllowedAt).toBeUndefined();
    const other = await prisma.tenant.create({ data: {
      name: "limits other", apiKeyHash: randomUUID(),
      subscriptions: { create: { targetUrl: "https://example.com", secret, eventTypes: [] } },
    }, include: { subscriptions: true } });
    try {
      expect((await patch(other.subscriptions[0]!.id, { maxConcurrentDeliveries: 5 })).status).toBe(404);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: other.subscriptions[0]!.id } })).maxConcurrentDeliveries).toBe(2);
    } finally { await prisma.tenant.delete({ where: { id: other.id } }); }
  });

  it("enforces scoped keys, expiry and revocation without revealing hashes", async () => {
    const created = await request("/keys", { name: "read only", scopes: ["read"] });
    expect(created.status).toBe(201);
    const key = await created.json();
    expect(key.token).toMatch(/^wrk_/);
    expect(key.keyHash).toBeUndefined();
    async function asKey(path: string, method = "GET", token = key.token) {
      return fetch(`${apiOrigin}/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ type: "forbidden", payload: {} }) } : {}) });
    }
    expect((await asKey("/events")).status).toBe(200);
    expect((await asKey("/events", "POST")).status).toBe(403);
    expect((await asKey("/keys")).status).toBe(403);
    expect((await asKey(`/subscriptions/${subscriptionId}/rotate-secret`, "POST")).status).toBe(403);
    const listed = await (await request("/keys")).json();
    expect(JSON.stringify(listed)).not.toContain(key.token);
    expect(JSON.stringify(listed)).not.toContain("keyHash");
    await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: new Date(0) } });
    expect((await asKey("/events")).status).toBe(401);
    await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: null } });
    const revoked = await fetch(`${apiOrigin}/v1/keys/${key.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } });
    expect(revoked.status).toBe(204);
    expect((await asKey("/events")).status).toBe(401);
    expect((await asKey("/events", "GET", `${apiKey} extra`)).status).toBe(401);
  });

  it("encrypts and rotates signing secrets, preserves grace and redacts nested responses", async () => {
    const created = await request("/subscriptions", { targetUrl: "https://example.com/hook", eventTypes: ["encryption-only"] });
    expect(created.status).toBe(201);
    const sub = await created.json();
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(stored.secret).toMatch(/^enc:v1:/);
    expect(stored.secret).not.toContain(sub.secret);
    const rotated = await request(`/subscriptions/${subscriptionId}/rotate-secret`, { graceSeconds: 60 });
    expect(rotated.status).toBe(200);
    const next = await rotated.json();
    expect((await request(`/subscriptions/${subscriptionId}/rotate-secret`, {})).status).toBe(409);
    const before = receipts.length;
    const id = await publish();
    const delivery = await settled(id);
    const receipt = receipts[before]!;
    expect(verifySignature(receipt.body, secret, String(receipt.headers["webhook-signature"]))).toBe(true);
    expect(verifySignature(receipt.body, next.secret, String(receipt.headers["webhook-signature"]))).toBe(true);
    const detail = await (await request(`/events/${delivery.eventId}`)).json();
    const publicSub = await (await request(`/subscriptions/${subscriptionId}`)).json();
    for (const json of [detail, publicSub]) {
      const text = JSON.stringify(json);
      expect(text).not.toContain(next.secret);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("enc:v1:");
      expect(text).not.toContain("previousSecret");
    }
    await prisma.subscription.update({ where: { id: subscriptionId }, data: { previousSecretExpiresAt: new Date(0) } });
    const later = await publish();
    await settled(later);
    const last = receipts.at(-1)!;
    expect(verifySignature(last.body, next.secret, String(last.headers["webhook-signature"]))).toBe(true);
    expect(verifySignature(last.body, secret, String(last.headers["webhook-signature"]))).toBe(false);
  });

  it("filters old event deliveries in SQL before applying the list limit", async () => {
    const old = await prisma.event.create({ data: { tenantId, type: "old.filtered", payload: {} } });
    const target = await prisma.delivery.create({ data: { eventId: old.id, subscriptionId, status: "SUCCEEDED", createdAt: new Date(0) } });
    const recent = await prisma.event.create({ data: { tenantId, type: "new.filtered", payload: {} } });
    await prisma.delivery.createMany({ data: Array.from({ length: 55 }, () => ({ eventId: recent.id, subscriptionId, status: "SUCCEEDED" as const })) });
    const unfiltered = await (await request("/deliveries")).json();
    expect(unfiltered).toHaveLength(50);
    expect(unfiltered.some((d: { id: string }) => d.id === target.id)).toBe(false);
    const filtered = await (await request(`/deliveries?eventId=${old.id}&status=SUCCEEDED`)).json();
    expect(filtered.map((d: { id: string }) => d.id)).toEqual([target.id]);
    const differentStatus = await (await request(`/deliveries?eventId=${old.id}&status=FAILED`)).json();
    expect(differentStatus).toEqual([]);
  });

  it("holds queued, retrying and newly published work while paused, then resumes without spending attempts", async () => {
    const { updateSubscriptionStatus } = await import("../src/modules/subscriptions/subscription.service");
    const pending = await durable("PENDING");
    const retry = await durable("PENDING");
    await prisma.delivery.update({ where: { id: retry.id }, data: { status: "RETRYING", attemptCount: 1, nextAttemptAt: new Date(Date.now() + 200) } });
    await updateSubscriptionStatus(tenantId, subscriptionId, "PAUSED");
    const before = receipts.length;
    await enqueueDelivery(pending.id, 1, 1);
    await enqueueDelivery(retry.id, 1, 2);
    const fresh = await publish();
    await waitUntil(async () => {
      const counts = await deliveryQueue.getJobCounts("active", "wait", "delayed");
      return Object.values(counts).every((n) => n === 0);
    });
    await reconcilePendingDeliveries();
    expect(receipts.length).toBe(before);
    expect(await prisma.delivery.findUnique({ where: { id: pending.id } })).toMatchObject({ status: "PENDING", attemptCount: 0 });
    expect(await prisma.delivery.findUnique({ where: { id: retry.id } })).toMatchObject({ status: "RETRYING", attemptCount: 1 });
    expect(await prisma.delivery.findUnique({ where: { id: fresh } })).toMatchObject({ status: "PENDING", attemptCount: 0 });
    await updateSubscriptionStatus(tenantId, subscriptionId, "ACTIVE");
    await reconcilePendingDeliveries();
    expect((await settled(pending.id)).attemptCount).toBe(1);
    expect((await settled(retry.id)).attemptCount).toBe(2);
    expect((await settled(fresh)).attemptCount).toBe(1);
    expect(receipts.length).toBe(before + 3);
  });

  it("rejects concurrent overlapping subscriptions, including wildcard selections, without altering existing rows", async () => {
    const targetUrl = `https://example.com/${randomUUID()}`;
    const results = await Promise.all([
      request("/subscriptions", { targetUrl, eventTypes: ["a", "b"] }),
      request("/subscriptions", { targetUrl: targetUrl + "#ignored", eventTypes: ["b", "a", "a"] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await request("/subscriptions", { targetUrl, eventTypes: [] })).status).toBe(409);
    expect((await request("/subscriptions", { targetUrl, eventTypes: ["c"] })).status).toBe(201);
    const rows = await prisma.subscription.findMany({ where: { tenantId, targetUrl } });
    expect(rows).toHaveLength(2);
    await prisma.subscription.deleteMany({ where: { tenantId, targetUrl } });
  });

  it("archives subscriptions without deleting shared events or attempt history and blocks mutations", async () => {
    const { deleteSubscription, updateSubscriptionStatus, updateSubscriptionLimits } = await import("../src/modules/subscriptions/subscription.service");
    const subs = await Promise.all(["a", "b"].map(name => prisma.subscription.create({ data: { tenantId, targetUrl: `https://example.com/archive-${name}`, secret, eventTypes: ["archive.test"] } })));
    const e = await prisma.event.create({ data: { tenantId, type: "archive.test", payload: { kept: true } } });
    const done = await prisma.delivery.create({ data: { eventId: e.id, subscriptionId: subs[0]!.id, status: "SUCCEEDED", attempts: { create: { runNumber: 1, attemptNumber: 1, responseStatus: 200 } } } });
    const pending = await prisma.delivery.create({ data: { eventId: e.id, subscriptionId: subs[1]!.id } });
    await expect(deleteSubscription("other-tenant", subs[0]!.id)).rejects.toMatchObject({ statusCode: 404 });
    await deleteSubscription(tenantId, subs[0]!.id);
    await deleteSubscription(tenantId, subs[0]!.id); // idempotent
    expect((await (await request(`/events/${e.id}`)).json()).historical).toBe(false);
    expect((await request(`/deliveries/${done.id}/replay`, {})).status).toBe(409);
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId: done.id } })).toBe(1);
    await expect(updateSubscriptionStatus(tenantId, subs[0]!.id, "ACTIVE")).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateSubscriptionLimits(tenantId, subs[0]!.id, { maxConcurrentDeliveries: 3 })).rejects.toMatchObject({ statusCode: 404 });
    expect((await request(`/subscriptions/${subs[0]!.id}/rotate-secret`, {})).status).toBe(409);
    await deleteSubscription(tenantId, subs[1]!.id);
    expect(await prisma.delivery.findUnique({ where: { id: pending.id } })).toMatchObject({ status: "CANCELLED", attemptCount: 0 });
    expect((await (await request(`/events/${e.id}`)).json()).historical).toBe(true);
    expect((await (await request("/events")).json()).some((v: any) => v.id === e.id)).toBe(false);
    expect((await (await request("/events?includeHistorical=true")).json()).find((v: any) => v.id === e.id).historical).toBe(true);
    expect((await (await request("/subscriptions")).json()).some((v: any) => v.id === subs[0]!.id)).toBe(false);
    expect((await (await request("/subscriptions?includeArchived=true")).json()).some((v: any) => v.id === subs[0]!.id)).toBe(true);
    const published = await (await request("/events", { type: "archive.test", payload: {} })).json();
    expect(published.deliveryCount).toBe(0);
  });

  it("enforces the final replay slot under concurrency and rejects replay after archiving", async () => {
    const { replayDelivery } = await import("../src/modules/deliveries/delivery.service");
    const { deleteSubscription } = await import("../src/modules/subscriptions/subscription.service");
    const sub = await prisma.subscription.create({ data: { tenantId, targetUrl: "https://example.com/replay-cap", secret, status: "PAUSED" } });
    const e = await prisma.event.create({ data: { tenantId, type: "cap", payload: {} } });
    const d = await prisma.delivery.create({ data: { eventId: e.id, subscriptionId: sub.id, status: "FAILED", runNumber: 5 } });
    const outcomes = await Promise.allSettled([replayDelivery(tenantId, d.id), replayDelivery(tenantId, d.id)]);
    expect(outcomes.filter(v => v.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.delivery.findUnique({ where: { id: d.id } })).toMatchObject({ runNumber: 6 });
    await prisma.delivery.update({ where: { id: d.id }, data: { status: "FAILED" } });
    await expect(replayDelivery(tenantId, d.id)).rejects.toMatchObject({ code: "REPLAY_LIMIT_REACHED" });
    const detail = await (await request(`/deliveries/${d.id}`)).json();
    expect(detail).toMatchObject({ replaysUsed: 5, maxReplays: 5 });
    await deleteSubscription(tenantId, sub.id);
    await expect(replayDelivery(tenantId, d.id)).rejects.toMatchObject({ code: "DELIVERY_ARCHIVED" });
  });

  it("filters multiple delivery states and rejects invalid states", async () => {
    const result = await request("/deliveries?status=SUCCEEDED,CANCELLED&limit=200");
    expect(result.status).toBe(200);
    const rows = await result.json();
    expect(rows.some((d: any) => d.status === "SUCCEEDED")).toBe(true);
    expect(rows.some((d: any) => d.status === "CANCELLED")).toBe(true);
    expect(rows.every((d: any) => ["SUCCEEDED", "CANCELLED"].includes(d.status))).toBe(true);
    expect((await request("/deliveries?status=PENDING,BOGUS")).status).toBe(422);
  });

  it("allows an already-started request to finish after archive without retrying its failure", async () => {
    const { deleteSubscription } = await import("../src/modules/subscriptions/subscription.service");
    const sub = await prisma.subscription.create({ data: { tenantId, targetUrl: `${receiver.origin}/archive-inflight`, eventTypes: ["archive.inflight"], secret } });
    holdResponse = true; responseStatus = 503;
    const before = receipts.length;
    try {
      const d = await publish("archive.inflight");
      await waitUntil(async () => receipts.length === before + 1);
      await deleteSubscription(tenantId, sub.id);
      holdResponse = false; releaseResponse?.(); releaseResponse = undefined;
      const result = await settled(d, "CANCELLED");
      expect(result.attemptCount).toBe(1);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]!.responseStatus).toBe(503);
      expect(result.nextAttemptAt).toBeNull();
      await reconcilePendingDeliveries();
      expect(receipts.length).toBe(before + 1);
    } finally { holdResponse = false; releaseResponse?.(); releaseResponse = undefined; responseStatus = 200; }
  });

  it("serializes publication with archive so no pending work survives for the retired target", async () => {
    const { deleteSubscription } = await import("../src/modules/subscriptions/subscription.service");
    const sub = await prisma.subscription.create({ data: { tenantId, targetUrl: "https://example.com/archive-race", eventTypes: ["archive.race"], secret, status: "PAUSED" } });
    await Promise.all([deleteSubscription(tenantId, sub.id), request("/events", { type: "archive.race", payload: {} })]);
    expect(await prisma.delivery.count({ where: { subscriptionId: sub.id, status: { in: ["PENDING", "PROCESSING", "RETRYING"] } } })).toBe(0);
  });

  it("reports malformed and oversized request bodies as client errors without exposing payloads", async () => {
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const malformed = await fetch(`${apiOrigin}/v1/events`, { method: "POST", headers, body: '{"sensitive":' });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_BODY");
    const large = await fetch(`${apiOrigin}/v1/events`, { method: "POST", headers, body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }) });
    expect(large.status).toBe(413);
    expect(large.headers.get("cache-control")).toBe("no-store");
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
