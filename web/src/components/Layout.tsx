import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { getApiKey, setApiKey, clearApiKey } from "../api/client";

const navItems = [
  { to: "/subscriptions", label: "Subscriptions" },
  { to: "/events", label: "Events" },
  { to: "/deliveries", label: "Deliveries" },
];

export default function Layout() {
  const [apiKey, setKeyState] = useState(getApiKey());

  if (!apiKey) {
    return <ApiKeyGate onSubmit={(key) => setKeyState(key)} />;
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <aside
        style={{
          width: 220,
          background: "var(--panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        <div style={{ padding: "20px 20px 16px" }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Relay</div>
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 2 }}>Webhook delivery console</div>
        </div>
        <nav style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                padding: "8px 12px",
                borderRadius: 4,
                fontSize: 13,
                color: isActive ? "var(--text)" : "var(--text-dim)",
                background: isActive ? "var(--panel-raised)" : "transparent",
                borderLeft: isActive ? "2px solid var(--amber)" : "2px solid transparent",
                textDecoration: "none",
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: "auto", padding: 16, borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => {
              clearApiKey();
              setKeyState(null);
            }}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-faint)",
              fontSize: 12,
              padding: 0,
            }}
          >
            Disconnect API key
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, overflow: "auto", padding: "28px 36px" }}>
        <Outlet />
      </main>
    </div>
  );
}

function ApiKeyGate({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setApiKey(value.trim());
          onSubmit(value.trim());
        }}
        style={{
          width: 360,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 28,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Connect to Relay</div>
        <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 0, marginBottom: 18 }}>
          Enter a tenant API key. Generate one with <code>npm run seed</code> in the API service.
        </p>
        <input
          type="password"
          placeholder="wr_..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ width: "100%", marginBottom: 14 }}
          autoFocus
        />
        <button
          type="submit"
          style={{
            width: "100%",
            background: "var(--amber)",
            color: "#1a1305",
            border: "none",
            borderRadius: 4,
            padding: "9px 0",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          Connect
        </button>
      </form>
    </div>
  );
}
