const statusColors: Record<string, string> = {
  ACTIVE: "var(--success)",
  SUCCEEDED: "var(--success)",
  PAUSED: "var(--text-faint)",
  PENDING: "var(--teal)",
  RETRYING: "var(--amber)",
  DISABLED: "var(--failure)",
  FAILED: "var(--failure)",
};

export default function StatusPill({ status }: { status: string }) {
  const color = statusColors[status] ?? "var(--text-faint)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ color: "var(--text-dim)" }}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>
    </span>
  );
}
