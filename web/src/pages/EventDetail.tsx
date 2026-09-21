import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useRemote } from "../hooks/useRemote";
import StatusPill from "../components/StatusPill";

export default function EventDetail() {
  const { id = "" } = useParams();
  const { data, error, refresh } = useRemote(useCallback(() => api.getEvent(id), [id]), 5000);
  return <section><header className="page-heading"><div><Link to="/events">← Events</Link><h1>Event detail</h1></div><button onClick={refresh}>Refresh</button></header>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {!data ? <p>{error ? "Unable to load this event." : "Loading…"}</p> : <>
      <div className="panel"><h2>{data.type}</h2><p className="wrap"><code>{data.id}</code></p><p>Published {new Date(data.createdAt).toLocaleString()}</p>
        {data.historical && <p>Historical — all associated subscriptions are archived. This record remains available for audit and idempotency.</p>}
        {data.idempotencyKey && <p className="wrap">Idempotency key: <code>{data.idempotencyKey}</code></p>}
        <h2>Payload</h2><pre>{JSON.stringify(data.payload, null, 2)}</pre>
      </div><h2>Delivery history</h2>
      {!data.deliveries.length ? <p>No retained deliveries. This event may have had no matching subscriptions, or its deliveries were deleted by an earlier version. New subscriptions do not automatically receive it.</p> : <div className="table-scroll"><table><thead><tr><th>Target</th><th>Status</th><th>Run</th><th>History</th></tr></thead><tbody>{data.deliveries.map(d => <tr key={d.id}><td className="wrap">{d.subscription.targetUrl}{d.subscription.archivedAt && <div className="muted">Archived subscription · Read-only</div>}</td><td><StatusPill status={d.status} /></td><td>{d.runNumber}</td><td><Link to={`/deliveries?eventId=${data.id}&deliveryId=${d.id}`}>Inspect attempts</Link></td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
