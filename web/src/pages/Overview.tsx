import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useRemote } from "../hooks/useRemote";

export default function Overview() {
  const { data, error, refresh } = useRemote(api.getOperations, 10000);
  return <section>
    <header className="page-heading"><div><p className="eyebrow">WORKSPACE HEALTH</p><h1>Delivery overview</h1><p>Current activity across your subscriptions. Updates every 10 seconds.</p></div><button onClick={refresh}>Refresh</button></header>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {!data ? <p>{error ? "Check your connection or API-key permissions, then refresh." : "Loading overview…"}</p> : <>
      <div className="stat-grid">
        <Link className="stat-card" to="/events"><span>Retained events</span><strong>{data.events}</strong><small>Original published records</small></Link>
        <Link className="stat-card" to="/subscriptions"><span>Active subscriptions</span><strong>{data.subscriptions.ACTIVE}</strong><small>{data.subscriptions.PAUSED} paused · {data.subscriptions.DISABLED} disabled</small></Link>
        <Link className="stat-card" to="/deliveries?status=PROCESSING"><span>In flight</span><strong>{data.deliveries.PROCESSING}</strong><small>{data.deliveries.PENDING} pending · {data.deliveries.RETRYING} retrying</small></Link>
        <Link className="stat-card" to="/deliveries?status=FAILED"><span>Failed deliveries</span><strong className={data.deliveries.FAILED ? "failure-text" : ""}>{data.deliveries.FAILED}</strong><small>{data.deliveries.SUCCEEDED} succeeded</small></Link>
      </div>
      <div className="panel"><h2>Needs attention</h2>
        {data.staleProcessing > 0 && <p className="error-banner">{data.staleProcessing} deliveries have expired worker leases. Recovery should reschedule them; check worker logs if this persists.</p>}
        {data.deliveries.FAILED > 0 && <p><Link to="/deliveries?status=FAILED">Inspect {data.deliveries.FAILED} failed deliveries</Link> before replaying.</p>}
        {data.subscriptions.DISABLED > 0 && <p><Link to="/subscriptions">Review {data.subscriptions.DISABLED} disabled subscriptions</Link> and fix the receiver before reactivating.</p>}
        {!data.staleProcessing && !data.deliveries.FAILED && !data.subscriptions.DISABLED && <p>No failed deliveries, expired leases or disabled subscriptions.</p>}
        <p className="muted">Counts reflect retained records, not lifetime totals. A healthy overview does not prove a separate worker is running.</p>
      </div>
    </>}
  </section>;
}
