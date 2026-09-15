const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const API_KEY_STORAGE_KEY = "relay_api_key";

export function getApiKey(): string | null {
  return sessionStorage.getItem(API_KEY_STORAGE_KEY);
}

export function setApiKey(key: string) {
  sessionStorage.setItem(API_KEY_STORAGE_KEY, key);
}

export function clearApiKey() {
  sessionStorage.removeItem(API_KEY_STORAGE_KEY);
}

class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const apiKey = getApiKey();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, `${body?.error?.message ?? res.statusText}${res.headers.get("x-request-id") ? ` (request ${res.headers.get("x-request-id")})` : ""}`, body?.error?.details);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface Subscription {
  id: string;
  targetUrl: string;
  description?: string | null;
  eventTypes: string[];
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  consecutiveFailures: number;
  maxConcurrentDeliveries: number;
  minDeliveryIntervalMs: number;
  createdAt: string;
  secretPreview?: string;
  secret?: string; // present only immediately after creation
}

export interface EventSummary {
  id: string;
  type: string;
  createdAt: string;
  _count: { deliveries: number };
}

export type DeliveryStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "RETRYING";

export interface DeliverySummary {
  id: string;
  status: DeliveryStatus;
  runNumber: number;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  errorMessage: string | null;
  createdAt: string;
  event: { id: string; type: string; createdAt: string };
  subscription: { id: string; targetUrl: string };
}

export interface DeliveryAttempt {
  id: string;
  runNumber: number;
  attemptNumber: number;
  requestedAt: string;
  durationMs: number | null;
  responseStatus: number | null;
  responseBodySnippet: string | null;
  errorMessage: string | null;
}

export interface DeliveryDetail extends DeliverySummary {
  errorMessage: string | null;
  responseBodySnippet: string | null;
  event: { id: string; type: string; createdAt: string; payload: unknown };
  subscription: { id: string; targetUrl: string; description: string | null };
  attempts: DeliveryAttempt[];
}

export interface Operations {
  events: number;
  subscriptions: Record<Subscription["status"], number>;
  deliveries: Record<DeliveryStatus, number>;
  staleProcessing: number;
}

export const api = {
  getOperations: () => request<Operations>("/v1/operations"),
  updateLimits: (id: string, data: { maxConcurrentDeliveries: number; minDeliveryIntervalMs: number }) =>
    request<Subscription>(`/v1/subscriptions/${id}/limits`, { method: "PATCH", body: JSON.stringify(data) }),
  rotateSecret: (id: string) => request<{ secret: string; previousSecretExpiresAt: string }>(`/v1/subscriptions/${id}/rotate-secret`, { method: "POST", body: JSON.stringify({ graceSeconds: 300 }) }),
  listSubscriptions: () => request<Subscription[]>("/v1/subscriptions"),
  createSubscription: (data: { targetUrl: string; description?: string; eventTypes: string[] }) =>
    request<Subscription>("/v1/subscriptions", { method: "POST", body: JSON.stringify(data) }),
  updateSubscriptionStatus: (id: string, status: "ACTIVE" | "PAUSED") =>
    request<Subscription>(`/v1/subscriptions/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  deleteSubscription: (id: string) => request<void>(`/v1/subscriptions/${id}`, { method: "DELETE" }),

  listEvents: () => request<EventSummary[]>("/v1/events"),
  publishEvent: (data: { type: string; payload: unknown }) =>
    request<{ event: EventSummary; deliveryCount: number }>("/v1/events", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  listDeliveries: (params?: { subscriptionId?: string; status?: string; eventId?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<DeliverySummary[]>(`/v1/deliveries${qs ? `?${qs}` : ""}`);
  },
  getDelivery: (id: string) => request<DeliveryDetail>(`/v1/deliveries/${id}`),
  replayDelivery: (id: string) => request<DeliverySummary>(`/v1/deliveries/${id}/replay`, { method: "POST" }),
};

export { ApiError };
