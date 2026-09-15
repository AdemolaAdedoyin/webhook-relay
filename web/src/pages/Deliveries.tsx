import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import StatusPill from "../components/StatusPill";
import { useRemote } from "../hooks/useRemote";

export default function Deliveries() {
  const [params, setParams] = useSearchParams();
  const eventId = params.get("eventId") ?? "";
  const status = params.get("status") ?? "";
  const subscriptionId = params.get("subscriptionId") ?? "";
  const selectedId = params.get("deliveryId");
  const load = useCallback(() => api.listDeliveries({ ...(eventId ? { eventId } : {}), ...(status ? { status } : {}), ...(subscriptionId ? { subscriptionId } : {}) }), [eventId, status, subscriptionId]);
  const { data, error, refresh } = useRemote(load, 5000);
  const subscriptions = useRemote(api.listSubscriptions);
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "deliveryId") next.delete("deliveryId");
    setParams(next);
  }
  return <section>
    <header className="page-heading"><div><p className="eyebrow">DELIVERY OPERATIONS</p><h1>Deliveries</h1><p>Latest 50 matching deliveries. Updates every 5 seconds.</p></div><button onClick={refresh}>Refresh</button></header>
    <div className="toolbar">
      <label>Status<select value={status} onChange={(e) => filter("status", e.target.value)}><option value="">All statuses</option>{["PENDING", "PROCESSING", "RETRYING", "SUCCEEDED", "FAILED"].map((s) => <option key={s}>{s}</option>)}</select></label>
      <label>Subscription<select value={subscriptionId} onChange={(e) => filter("subscriptionId", e.target.value)}><option value="">All subscriptions</option>{subscriptions.data?.map((s) => <option key={s.id} value={s.id}>{s.description || s.targetUrl}</option>)}</select></label>
      {eventId && <span className="filter-chip">Event: <code>{eventId}</code> <button aria-label="Clear event filter" onClick={() => filter("eventId", "")}>×</button></span>}
      {(status || subscriptionId || eventId) && <button onClick={() => setParams({})}>Clear filters</button>}
    </div>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {subscriptions.error && <p role="alert" className="error-banner">Subscription filter unavailable: {subscriptions.error}</p>}
    <div className="delivery-layout"><div className="table-scroll">
      {!data ? <p>{error ? "Unable to load deliveries. Try Refresh." : "Loading deliveries…"}</p> : !data.length ? <div className="empty-state">No deliveries match these filters. Deleted subscriptions lose delivery history; their original events remain.</div> : <table><thead><tr><th>Event / target</th><th>Status</th><th>Run / attempts</th><th>Latest result</th></tr></thead><tbody>
        {data.map((d) => <tr key={d.id} className={selectedId === d.id ? "selected-row" : ""}>
          <td><button className="text-button" onClick={() => filter("deliveryId", d.id)}>{d.event.type}</button><div className="muted truncate" title={d.subscription.targetUrl}>{d.subscription.targetUrl}</div></td>
          <td><StatusPill status={d.status} />{d.nextAttemptAt && <div className="muted">Eligible {new Date(d.nextAttemptAt).toLocaleTimeString()}</div>}</td>
          <td>Run {d.runNumber}<div className="muted">{d.attemptCount} / {d.maxAttempts} attempts</div></td>
          <td><div className={d.errorMessage ? "failure-text" : "muted"}>{d.errorMessage || (d.responseStatus ? `HTTP ${d.responseStatus}` : "Awaiting attempt")}</div></td>
        </tr>)}
      </tbody></table>}
    </div>{selectedId && <DeliveryDrawer key={selectedId} id={selectedId} onClose={() => filter("deliveryId", "")} onReplayed={refresh} />}</div>
  </section>;
}

function DeliveryDrawer({ id, onClose, onReplayed }: { id: string; onClose: () => void; onReplayed: () => void }) {
  const load = useCallback(() => api.getDelivery(id), [id]);
  const { data: delivery, error, refresh } = useRemote(load, 3000);
  const [replaying, setReplaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const canReplay = delivery?.status === "FAILED" || delivery?.status === "SUCCEEDED";
  async function replay() {
    setReplaying(true); setActionError(null);
    try { await api.replayDelivery(id); setConfirming(false); refresh(); onReplayed(); }
    catch (err) { setActionError(err instanceof Error ? err.message : "Replay failed"); }
    finally { setReplaying(false); }
  }
  return <aside className="panel delivery-drawer" aria-label="Delivery detail"><header className="drawer-heading"><h2>Delivery detail</h2><button aria-label="Close delivery detail" onClick={onClose}>×</button></header>
    {(error || actionError) && <p role="alert" className="error-banner">{actionError || error}</p>}
    {!delivery ? <p>{error ? "Could not load this delivery. It may have been deleted." : "Loading detail…"}</p> : <>
      <code className="muted wrap">{delivery.id}</code><p><StatusPill status={delivery.status} /> · Run {delivery.runNumber} · {delivery.attemptCount}/{delivery.maxAttempts} attempts</p>
      <p className="wrap">{delivery.subscription.targetUrl}</p>
      {delivery.errorMessage && <p className="error-banner">{delivery.errorMessage}</p>}
      {delivery.nextAttemptAt && <p className="muted">Next eligible start: {new Date(delivery.nextAttemptAt).toLocaleString()}. Retry backoff or subscription limits may delay delivery.</p>}
      <details><summary>Event payload</summary><pre>{JSON.stringify(delivery.event.payload, null, 2)}</pre></details>
      <h2>Attempt timeline</h2>
      {!delivery.attempts.length && <p className="muted">No completed network attempts yet. Waiting for capacity does not consume an attempt.</p>}
      <ol className="timeline">{delivery.attempts.map((a) => <li key={a.id}><strong>Run {a.runNumber} · Attempt {a.attemptNumber}</strong><div className="muted">{new Date(a.requestedAt).toLocaleString()} · {a.durationMs ?? "—"} ms</div><p className={a.errorMessage ? "failure-text" : "success-text"}>{a.errorMessage || `HTTP ${a.responseStatus ?? "—"}`}</p>{a.responseBodySnippet && <details><summary>Response snippet</summary><pre>{a.responseBodySnippet}</pre></details>}</li>)}</ol>
      <p className="muted">Recovered attempts can have no recorded response if the worker stopped before saving it.</p>
      {confirming ? <div className="confirmation"><p>Send this event again? Replay starts a new run and preserves history. The receiver may already have processed it.</p><button className="primary" disabled={replaying || !canReplay} onClick={replay}>{replaying ? "Replaying…" : "Confirm replay"}</button> <button disabled={replaying} onClick={() => setConfirming(false)}>Cancel</button></div> : <button className="primary" disabled={!canReplay || replaying} onClick={() => setConfirming(true)}>Replay delivery</button>}
      {!canReplay && <p className="muted">Replay is available after the current run finishes.</p>}
    </>}
  </aside>;
}
