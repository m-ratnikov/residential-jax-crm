/**
 * The header, and the app's standing statement about what it is running on.
 *
 * The dataset badge is not decoration. A reviewer opening the deployed URL
 * should be able to tell, before clicking anything, whether they are looking at
 * the full published county roll or a bundled sample, how many parcels that is,
 * and which pipeline run produced it. The same badge says when no CRM store is
 * attached, because that changes what half the app can do.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge, cx, count } from "./ui";

interface DataSourceStatus {
  dataSource: {
    label: string;
    location: string;
    isSample: boolean;
    rowCount: number;
    columnCount: number;
    countyName: string;
    stateCode: string;
    runId: string | null;
  };
  crmStore: { configured: boolean };
  overlay: { courtDataAvailable: boolean; simulatedProperties: number };
  pipeline: { runId: string; status: string; startedAt: string } | null;
}

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/search", label: "Search" },
  { href: "/searches", label: "Saved criteria" },
  { href: "/alerts", label: "Alerts" },
  { href: "/opportunities", label: "Opportunities" },
  { href: "/agent", label: "Ask" },
  { href: "/pipeline", label: "Pipeline" },
];

export function AppHeader() {
  const pathname = usePathname();
  const [status, setStatus] = useState<DataSourceStatus | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/datasource")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: DataSourceStatus | null) => {
        if (!cancelled) setStatus(body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The unread count is re-read on every navigation, which is often enough for
  // a badge and avoids a polling timer nobody asked for.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/alerts?unread=true&limit=200")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { alerts?: unknown[] } | null) => {
        if (!cancelled) setUnread(body?.alerts?.length ?? 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const data = status?.dataSource;

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--panel)]/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight text-ink-50">
            Duval Acquisitions
          </span>
          <span className="text-[11px] text-ink-500">Jacksonville, FL</span>
        </Link>

        <nav className="flex flex-wrap items-center gap-0.5">
          {NAV.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : (pathname?.startsWith(item.href) ?? false);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cx(
                  "relative rounded-md px-2.5 py-1 text-[13px] transition-colors",
                  active
                    ? "bg-[var(--panel-raised)] text-ink-50"
                    : "text-ink-400 hover:text-ink-100",
                )}
              >
                {item.label}
                {item.href === "/alerts" && unread > 0 && (
                  <span className="tabular ml-1.5 rounded bg-accent-500 px-1 py-px text-[10px] font-semibold text-white">
                    {unread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {data && (
            <>
              {data.isSample ? (
                <Badge
                  tone="warn"
                  title={`Bundled sample extract: ${count(data.rowCount)} parcels. Set PROPERTY_DATA_URL to read the full published county artifact.`}
                >
                  SAMPLE - {count(data.rowCount)} parcels
                </Badge>
              ) : (
                <Badge
                  tone="good"
                  title={`Published ${data.countyName} County query table: ${count(data.rowCount)} parcels over ${data.columnCount} columns.`}
                >
                  {count(data.rowCount)} parcels
                </Badge>
              )}

              {status?.overlay.simulatedProperties ? (
                <Badge
                  tone="accent"
                  title="A simulated pipeline update is currently applied on top of the published data. Clear it from the Pipeline page."
                >
                  {status.overlay.simulatedProperties} simulated
                </Badge>
              ) : null}

              {status && !status.crmStore.configured && (
                <Badge
                  tone="bad"
                  title="No DATABASE_URL is set, so saved searches, alerts and opportunities cannot be stored. Search, the map and the agent still work."
                >
                  No CRM store
                </Badge>
              )}
            </>
          )}

          <Link
            href="/settings"
            className={cx(
              "rounded-md px-2.5 py-1 text-[13px] transition-colors",
              pathname?.startsWith("/settings")
                ? "bg-[var(--panel-raised)] text-ink-50"
                : "text-ink-400 hover:text-ink-100",
            )}
          >
            Settings
          </Link>
        </div>
      </div>
    </header>
  );
}
