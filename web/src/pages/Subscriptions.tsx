import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { api, Subscription } from "../api/client";
import StatusPill from "../components/StatusPill";

export default function Subscriptions() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setSubs(await api.listSubscriptions());
      setError(null);
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
    setNotice(null);
    setShowForm(false);
    refresh();
  }

  async function action(sub: Subscription, work: () => Promise<unknown>) {
    setBusy(sub.id); setError(null);
    try { await work(); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Action failed"); }
    finally { setBusy(null); }
  }
  async function toggleStatus(sub: Subscription) {
    const next = sub.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    await action(sub, () => api.updateSubscriptionStatus(sub.id, next));
  }
  async function remove(sub: Subscription) {
    if (!confirm(`Delete ${sub.targetUrl}? This permanently deletes its deliveries and attempt history. Original events remain. Use Pause to preserve delivery history.`)) return;
    await action(sub, async () => { await api.deleteSubscription(sub.id); if (editing?.id === sub.id) setEditing(null); });
  }
  async function rotate(sub: Subscription) {
    if (!confirm("Rotate the signing secret? Save the new secret at your receiver within five minutes. Both keys work during this grace period.")) return;
    await action(sub, async () => {
      const result = await api.rotateSecret(sub.id);
      setRevealedSecret({ id: sub.id, secret: result.secret });
      setNotice(`Update your receiver before ${new Date(result.previousSecretExpiresAt).toLocaleString()}.`);
    });
  }

  return (
    <div>
      <div className="page-heading">
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

      <p className="muted">Pause preserves delivery history. Delete removes the subscription, its deliveries and attempts; original events remain.</p>
      {error && <ErrorBanner message={error} />}
      <button onClick={refresh} disabled={!!busy}>Refresh subscriptions</button>
      {editing && <LimitsForm key={editing.id} subscription={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />}


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
          {notice && <p role="status">{notice}</p>}
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
            onClick={() => { setRevealedSecret(null); setNotice(null); }}
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
        error ? <p>Unable to load subscriptions. Try Refresh subscriptions.</p> : <Loading />
      ) : subs.length === 0 ? (
        <EmptyState onCreate={() => setShowForm(true)} />
      ) : (
        <div className="table-scroll"><table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Event types</th>
              <th>Status</th>
              <th>Throughput</th>
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
                  {sub.maxConcurrentDeliveries} concurrent<br />{sub.minDeliveryIntervalMs ? `${sub.minDeliveryIntervalMs} ms between starts` : "No pacing"}
                </td>
                <td>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {(
                      <button disabled={!!busy} onClick={() => toggleStatus(sub)} style={linkButtonStyle}>
                        {sub.status === "ACTIVE" ? "Pause" : sub.status === "DISABLED" ? "Reactivate" : "Resume"}
                      </button>
                    )}
                    <button disabled={!!busy} onClick={() => setEditing(sub)} style={linkButtonStyle}>Edit limits</button>
                    <button disabled={!!busy} onClick={() => rotate(sub)} style={linkButtonStyle}>Rotate secret</button>
                    <button disabled={!!busy} onClick={() => remove(sub)} style={{ ...linkButtonStyle, color: "var(--failure)" }}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
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
    <div role="alert"
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

function LimitsForm({ subscription, onClose, onSaved }: { subscription: Subscription; onClose: () => void; onSaved: () => Promise<void> }) {
  const [concurrency, setConcurrency] = useState(subscription.maxConcurrentDeliveries);
  const [interval, setInterval] = useState(subscription.minDeliveryIntervalMs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className="panel" onSubmit={async (e) => {
    e.preventDefault(); setSaving(true); setError(null);
    try { await api.updateLimits(subscription.id, { maxConcurrentDeliveries: concurrency, minDeliveryIntervalMs: interval }); await onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to save limits"); }
    finally { setSaving(false); }
  }}>
    <h2>Edit throughput limits</h2><p className="wrap">{subscription.targetUrl}</p>
    {error && <p role="alert" className="error-banner">{error}</p>}
    <div className="toolbar"><label>Concurrent deliveries<input type="number" min="1" max="100" step="1" required value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} /></label>
    <label>Minimum interval (ms)<input type="number" min="0" max="3600000" step="1" required value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></label></div>
    <p className="muted">Limits apply across workers. Zero interval disables pacing. Active requests are not cancelled.</p>
    <button className="primary" disabled={saving}>{saving ? "Saving…" : "Save limits"}</button> <button type="button" disabled={saving} onClick={onClose}>Cancel</button>
  </form>;
}
