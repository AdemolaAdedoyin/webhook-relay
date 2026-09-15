import { useEffect, useState } from "react";

/** Sequential polling; stale responses cannot replace a newer selection. */
export function useRemote<T>(load: () => Promise<T>, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setError(null);
    async function run() {
      try {
        const result = await load();
        if (!cancelled) { setData(result); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load data");
      } finally {
        if (!cancelled && intervalMs) timer = setTimeout(run, intervalMs);
      }
    }
    void run();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [load, intervalMs, version]);
  return { data, error, refresh: () => setVersion((n) => n + 1) };
}
