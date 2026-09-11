import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { api, Subscription } from "../api/client";
import StatusPill from "../components/StatusPill";

export default function Subscriptions() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setSubs(await api.listSubscriptions());
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(data: { targetUrl: string; description?: string; eventTypes: string[] }) {
    const created = await api.createSubscription(data);
    setRevealedSecret({ id: created.id, secret: created.secret! });
    setShowForm(false);
    refresh();
  }

  async function toggleStatus(sub: Subscription) {
    const next = sub.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    await api.updateSubscriptionStatus(sub.id, next);
    refresh();
  }

  async function remove(sub: Subscription) {
    if (!confirm(`Delete the subscription targeting ${sub.targetUrl}? This can't be undone.`)) return;
    await api.deleteSubscription(sub.id);
    refresh();
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Subscriptions</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "4px 0 0" }}>
            Endpoints that receive events, and which event types each one wants.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          style={{
            background: "var(--amber)",
            color: "#1a1305",
            border: "none",
            borderRadius: 4,
            padding: "8px 14px",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          New subscription
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {revealedSecret && (
        <div
          style={{
            background: "var(--panel-raised)",
            border: "1px solid var(--amber-dim)",
            borderRadius: 6,
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Signing secret — copy it now</div>
          <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "0 0 10px" }}>
            This is the only time the full secret is shown. Use it to verify the{" "}
            <code>Webhook-Signature</code> header on incoming requests.
          </p>
          <code
            style={{
              display: "block",
              background: "var(--ink)",
              padding: "8px 10px",
              borderRadius: 4,
              fontSize: 12.5,
              wordBreak: "break-all",
            }}
          >
            {revealedSecret.secret}
          </code>
          <button
            onClick={() => setRevealedSecret(null)}
            style={{
              marginTop: 10,
              background: "none",
              border: "1px solid var(--border-strong)",
              color: "var(--text-dim)",
              borderRadius: 4,
              padding: "5px 10px",
              fontSize: 12,
            }}
          >
            Done, dismiss
          </button>
        </div>
      )}

      {showForm && (
        <CreateForm onCancel={() => setShowForm(false)} onCreate={handleCreate} />
      )}

      {subs === null ? (
        <Loading />
      ) : subs.length === 0 ? (
        <EmptyState onCreate={() => setShowForm(true)} />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Event types</th>
              <th>Status</th>
              <th>Secret</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {subs.map((sub) => (
              <tr key={sub.id}>
                <td>
                  <div className="mono" style={{ fontSize: 12.5 }}>
                    {sub.targetUrl}
                  </div>
                  {sub.description && (
                    <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 2 }}>{sub.description}</div>
                  )}
                </td>
                <td>
                  {sub.eventTypes.length === 0 ? (
                    <span style={{ color: "var(--text-faint)" }}>all events</span>
                  ) : (
                    sub.eventTypes.join(", ")
                  )}
                </td>
                <td>
                  <StatusPill status={sub.status} />
                  {sub.consecutiveFailures > 0 && (
                    <div style={{ fontSize: 11, color: "var(--failure)", marginTop: 2 }}>
                      {sub.consecutiveFailures} consecutive failures
                    </div>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 12, color: "var(--text-faint)" }}>
                  {sub.secretPreview}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 8 }}>
                    {sub.status !== "DISABLED" && (
                      <button onClick={() => toggleStatus(sub)} style={linkButtonStyle}>
                        {sub.status === "ACTIVE" ? "Pause" : "Resume"}
                      </button>
                    )}
                    <button onClick={() => remove(sub)} style={{ ...linkButtonStyle, color: "var(--failure)" }}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CreateForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (data: { targetUrl: string; description?: string; eventTypes: string[] }) => Promise<void>;
}) {
  const [targetUrl, setTargetUrl] = useState("");
  const [description, setDescription] = useState("");
  const [eventTypes, setEventTypes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        setErr(null);
        try {
          await onCreate({
            targetUrl,
            description: description || undefined,
            eventTypes: eventTypes
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
        } catch (error: any) {
          setErr(error.message);
        } finally {
          setSubmitting(false);
        }
      }}
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 20,
        marginBottom: 20,
        display: "grid",
        gap: 12,
      }}
    >
      {err && <ErrorBanner message={err} />}
      <Field label="Target URL">
        <input
          required
          type="url"
          placeholder="https://your-app.com/webhooks/relay"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Description (optional)">
        <input
          placeholder="Production order events"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Event types (comma-separated, blank = all events)">
        <input
          placeholder="order.created, order.refunded"
          value={eventTypes}
          onChange={(e) => setEventTypes(e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          type="submit"
          disabled={submitting}
          style={{
            background: "var(--amber)",
            color: "#1a1305",
            border: "none",
            borderRadius: 4,
            padding: "8px 14px",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          {submitting ? "Creating…" : "Create subscription"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: "none",
            border: "1px solid var(--border-strong)",
            color: "var(--text-dim)",
            borderRadius: 4,
            padding: "8px 14px",
            fontSize: 13,
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{label}</span>
      {children}
    </label>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--teal)",
  fontSize: 12.5,
  padding: 0,
};

function Loading() {
  return <p style={{ color: "var(--text-faint)" }}>Loading…</p>;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: "rgba(217,99,77,0.12)",
        border: "1px solid var(--failure)",
        color: "var(--failure)",
        borderRadius: 4,
        padding: "8px 12px",
        fontSize: 12.5,
        marginBottom: 12,
      }}
    >
      {message}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        border: "1px dashed var(--border-strong)",
        borderRadius: 6,
        padding: 40,
        textAlign: "center",
        color: "var(--text-dim)",
      }}
    >
      <p style={{ margin: "0 0 12px" }}>No subscriptions yet. Add one to start receiving events.</p>
      <button
        onClick={onCreate}
        style={{
          background: "var(--amber)",
          color: "#1a1305",
          border: "none",
          borderRadius: 4,
          padding: "8px 14px",
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        New subscription
      </button>
    </div>
  );
}
