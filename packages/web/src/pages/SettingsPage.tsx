import type * as React from "react";
/**
 * Settings page — minimal v1.
 *
 * Per design review decision 7.4: full Settings is a followup. v1 shows
 * the daemon config (read-only) + About.
 */

import { useEffect, useState } from "react";

import { Card, Kbd } from "../components/ui/index.js";
import { api, AstackError } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";

interface Health {
  status: string;
  version: string;
  uptime_ms: number;
}

export function SettingsPage(): React.JSX.Element {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AstackError ? err.message : String(err)
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-secondary">Daemon</h2>
        <Card>
          {error ? (
            <div className="text-sm text-error">{error}</div>
          ) : !health ? (
            <div className="text-sm text-text-muted">Probing…</div>
          ) : (
            <dl className="text-sm grid grid-cols-[140px_1fr] gap-y-1">
              <dt className="text-text-muted">Version</dt>
              <dd className="font-mono">{health.version}</dd>
              <dt className="text-text-muted">Status</dt>
              <dd className="text-accent">{health.status}</dd>
              <dt className="text-text-muted">Uptime</dt>
              <dd>
                {relativeTime(
                  new Date(Date.now() - health.uptime_ms).toISOString()
                )}
              </dd>
              <dt className="text-text-muted">Data dir</dt>
              <dd className="font-mono text-text-secondary">
                ~/.astack/ (override with <Kbd>ASTACK_DATA_DIR</Kbd>)
              </dd>
            </dl>
          )}
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-secondary">Keyboard</h2>
        <Card>
          <dl className="text-sm grid grid-cols-[140px_1fr] gap-y-1">
            <dt>
              <Kbd>⌘K</Kbd>
            </dt>
            <dd className="text-text-secondary">Command palette</dd>
            <dt>
              <Kbd>⌘1</Kbd> – <Kbd>⌘5</Kbd>
            </dt>
            <dd className="text-text-secondary">Jump between sections</dd>
            <dt>
              <Kbd>⌘R</Kbd>
            </dt>
            <dd className="text-text-secondary">Refresh current view</dd>
            <dt>
              <Kbd>Esc</Kbd>
            </dt>
            <dd className="text-text-secondary">Close dialog / palette</dd>
          </dl>
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-secondary">About</h2>
        <Card className="text-sm text-text-secondary">
          <div>Astack — AI Harness System.</div>
          <div className="text-text-muted text-xs mt-1">
            Dashboard served by the local daemon at 127.0.0.1:7432.
          </div>
        </Card>
      </section>
    </div>
  );
}
