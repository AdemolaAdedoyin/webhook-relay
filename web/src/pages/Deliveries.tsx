import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api, DeliveryDetail, DeliverySummary } from "../api/client";
import StatusPill from "../components/StatusPill";

export default function Deliveries() {
  const [params] = useSearchParams();
  const eventId = params.get("eventId") ?? undefined;

  const [deliveries, setDeliveries] = useState<DeliverySummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function refresh() {
    const all = await api.listDeliveries();
    setDeliveries(eventId ? all.filter((d) => d.event.id === eventId) : all);
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000); // poll — retries change status in the background
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  return (
    <div style={{ display: "flex", gap: 24 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Deliveries</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "4px 0 20px" }}>
          {eventId ? "Deliveries for the selected event." : "Every delivery attempt across all subscriptions."}
        </p>

        {deliveries === null ? (
          <p style={{ color: "var(--text-faint)" }}>Loading…</p>
        ) : deliveries.length === 0 ? (
          <div
            style={{
              border: "1px dashed var(--border-strong)",
              borderRadius: 6,
              padding: 40,
              textAlign: "center",
              color: "var(--text-dim)",
            }}
          >
            No deliveries yet.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Target</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Response</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} onClick={() => setSelectedId(d.id)} style={{ cursor: "pointer" }}>
                  <td className="mono">{d.event.type}</td>
                  <td className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {new URL(d.subscription.targetUrl).hostname}
                  </td>
                  <td>
                    <StatusPill status={d.status} />
                  </td>
                  <td>
                    {d.attemptCount}/{d.maxAttempts}
                  </td>
                  <td style={{ color: d.responseStatus && d.responseStatus >= 300 ? "var(--failure)" : "var(--text-dim)" }}>
                    {d.responseStatus ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedId && (
        <DeliveryDrawer deliveryId={selectedId} onClose={() => setSelectedId(null)} onReplayed={refresh} />
      )}
    </div>
  );
}

function DeliveryDrawer({
  deliveryId,
  onClose,
  onReplayed,
}: {
  deliveryId: string;
  onClose: () => void;
  onReplayed: () => void;
}) {
  const [delivery, setDelivery] = useState<DeliveryDetail | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDelivery(null);
    api.getDelivery(deliveryId).then(setDelivery);
  }, [deliveryId]);

  async function replay() {
    setReplaying(true);
    setErr(null);
    try {
      await api.replayDelivery(deliveryId);
      onReplayed();
      setDelivery(await api.getDelivery(deliveryId));
    } catch (error: any) {
      setErr(error.message);
    } finally {
      setReplaying(false);
    }
  }

  const canReplay = delivery && delivery.status !== "PENDING" && delivery.status !== "RETRYING";

  return (
    <div
      style={{
        width: 380,
        flexShrink: 0,
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 20,
        height: "fit-content",
        position: "sticky",
        top: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Delivery detail</div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "var(--text-faint)", fontSize: 16, padding: 0 }}
        >
          ×
        </button>
      </div>

      {!delivery ? (
        <p style={{ color: "var(--text-faint)" }}>Loading…</p>
      ) : (
        <>
          {err && (
            <div
              style={{
                background: "rgba(217,99,77,0.12)",
                border: "1px solid var(--failure)",
                color: "var(--failure)",
                borderRadius: 4,
                padding: "8px 12px",
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              {err}
            </div>
          )}

          <DetailRow label="Event type" value={delivery.event.type} mono />
          <DetailRow label="Target" value={delivery.subscription.targetUrl} mono />
          <DetailRow label="Status" value={<StatusPill status={delivery.status} />} />
          <DetailRow label="Attempts" value={`${delivery.attemptCount} / ${delivery.maxAttempts}`} />
          {delivery.nextAttemptAt && (
            <DetailRow label="Next attempt" value={new Date(delivery.nextAttemptAt).toLocaleString()} />
          )}

          <div style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "16px 0 8px" }}>Attempt history</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {delivery.attempts.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>No attempts made yet.</div>
            )}
            {delivery.attempts.map((attempt) => (
              <div
                key={attempt.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Attempt {attempt.attemptNumber}</span>
                  <span style={{ color: "var(--text-faint)" }}>
                    {new Date(attempt.requestedAt).toLocaleTimeString()}
                  </span>
                </div>
                <div style={{ color: attempt.errorMessage ? "var(--failure)" : "var(--success)", marginTop: 4 }}>
                  {attempt.errorMessage ?? `HTTP ${attempt.responseStatus}`}
                  {attempt.durationMs != null && (
                    <span style={{ color: "var(--text-faint)" }}> · {attempt.durationMs}ms</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={replay}
            disabled={!canReplay || replaying}
            style={{
              width: "100%",
              background: canReplay ? "var(--amber)" : "var(--panel-raised)",
              color: canReplay ? "#1a1305" : "var(--text-faint)",
              border: canReplay ? "none" : "1px solid var(--border-strong)",
              borderRadius: 4,
              padding: "8px 0",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {replaying ? "Replaying…" : "Replay delivery"}
          </button>
        </>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginBottom: 2 }}>{label}</div>
      <div className={mono ? "mono" : undefined} style={{ fontSize: 12.5, wordBreak: "break-all" }}>
        {value}
      </div>
    </div>
  );
}
