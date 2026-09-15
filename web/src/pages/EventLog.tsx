import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, EventSummary } from "../api/client";

export default function EventLog() {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setEvents(await api.listEvents());
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Events</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "4px 0 0" }}>
            Latest 50 events, most recent first. Events remain after a subscription is deleted.
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
          Publish test event
        </button>
      </div>

      {error && (
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
          {error}
        </div>
      )}

      <button onClick={refresh}>Refresh events</button>
      {showForm && (
        <PublishForm
          onCancel={() => setShowForm(false)}
          onPublish={async (data) => {
            await api.publishEvent(data);
            setShowForm(false);
            refresh();
          }}
        />
      )}

      {events === null ? (
        <p style={{ color: "var(--text-dim)" }}>{error ? "Unable to load events. Try Refresh events." : "Loading…"}</p>
      ) : events.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--border-strong)",
            borderRadius: 6,
            padding: 40,
            textAlign: "center",
            color: "var(--text-dim)",
          }}
        >
          No events published yet.
        </div>
      ) : (
        <div className="table-scroll"><table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Published</th>
              <th>Deliveries</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="mono">{event.type}</td>
                <td style={{ color: "var(--text-dim)" }}>{new Date(event.createdAt).toLocaleString()}</td>
                <td>{event._count.deliveries}</td>
                <td>
                  <Link to={`/deliveries?eventId=${event.id}`} style={{ color: "var(--teal)", fontSize: 12.5 }}>
                    View deliveries
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function PublishForm({
  onCancel,
  onPublish,
}: {
  onCancel: () => void;
  onPublish: (data: { type: string; payload: unknown }) => Promise<void>;
}) {
  const [type, setType] = useState("order.created");
  const [payload, setPayload] = useState('{\n  "orderId": "ord_123",\n  "amount": 4200\n}');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        setErr(null);
        try {
          const parsedPayload = JSON.parse(payload);
          await onPublish({ type, payload: parsedPayload });
        } catch (error: any) {
          setErr(error instanceof SyntaxError ? "Payload must be valid JSON" : error.message);
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
      {err && (
        <div
          style={{
            background: "rgba(217,99,77,0.12)",
            border: "1px solid var(--failure)",
            color: "var(--failure)",
            borderRadius: 4,
            padding: "8px 12px",
            fontSize: 12.5,
          }}
        >
          {err}
        </div>
      )}
      <label style={{ display: "grid", gap: 5 }}>
        <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>Event type</span>
        <input value={type} onChange={(e) => setType(e.target.value)} required style={{ width: "100%" }} />
      </label>
      <label style={{ display: "grid", gap: 5 }}>
        <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>Payload (JSON)</span>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={6}
          className="mono"
          style={{ width: "100%", resize: "vertical" }}
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
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
          {submitting ? "Publishing…" : "Publish event"}
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
