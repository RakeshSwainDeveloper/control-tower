import { useEffect, useState } from 'react';

const API = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

interface Health {
  status: string;
  env: string;
  checks: { database: { status: string; latency_ms?: number } };
}

/**
 * Phase 1 shell. Proves the container, the proxy and the API contract.
 * The 30-screen UI is Phase 7 — designed against the tokens in
 * STACK_AND_DOCKER_PLAN.md §6, not scaffolded here.
 */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="shell">
      <header>
        <span className="mark" aria-hidden="true" />
        <div>
          <h1>Control Tower</h1>
          <p className="sub">Construction Project Management — MVP</p>
        </div>
      </header>

      <section className="card">
        <h2>Phase 1 · Foundation</h2>
        <dl>
          <dt>Web container</dt>
          <dd><span className="ok">running</span></dd>
          <dt>API</dt>
          <dd>
            {error && <span className="bad">unreachable — {error}</span>}
            {!error && !health && <span className="pending">checking…</span>}
            {health && <span className="ok">{health.status} · {health.env}</span>}
          </dd>
          <dt>Database</dt>
          <dd>
            {health
              ? <span className={health.checks.database.status === 'up' ? 'ok' : 'bad'}>
                  {health.checks.database.status}
                  {health.checks.database.latency_ms !== undefined &&
                    ` · ${health.checks.database.latency_ms}ms`}
                </span>
              : <span className="pending">—</span>}
          </dd>
        </dl>
        <p className="note">
          Screens are built in Phase 7 against the design tokens agreed in
          <code>STACK_AND_DOCKER_PLAN.md §6</code>.
        </p>
      </section>
    </main>
  );
}
