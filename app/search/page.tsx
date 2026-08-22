/**
 * The core surface: criteria on the left, map in the middle, ranked list on the
 * right, detail in a drawer.
 *
 * The search is debounced rather than run on a button, because an acquisitions
 * analyst adjusts a threshold and wants to see the count move. The count is the
 * feedback; making them press Search to get it hides the thing they came for.
 */

"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CriteriaPanel } from "@/components/CriteriaPanel";
import { PropertyDrawer } from "@/components/PropertyDrawer";
import { PropertyMap } from "@/components/PropertyMap";
import { ResultList } from "@/components/ResultList";
import { Button, Field, Panel, TextArea, TextInput, Toggle, count } from "@/components/ui";
import { ApiError, post, type SavedSearch } from "@/lib/client";
import {
  attachHeadline,
  useParcelSearch,
  type OrderBy,
  type SearchState,
} from "@/lib/data/use-search";
import type { AttachAttaching, AttachFailed } from "@/lib/data/types";
import { publicDataConfig } from "@/lib/data/public-config";
import { EMPTY_CRITERIA, type CriteriaSet, type Geometry } from "@/lib/criteria/types";
import type { MapViewport } from "@/lib/criteria/sql";

/**
 * useSearchParams opts a route out of static prerendering unless it sits under
 * a Suspense boundary, so the shell renders immediately and the criteria load
 * from the URL a tick later.
 */
export default function SearchPage() {
  return (
    <Suspense
      fallback={<div className="p-8 text-xs text-ink-500">Loading the search workspace</div>}
    >
      <SearchWorkspace />
    </Suspense>
  );
}

function SearchWorkspace() {
  const router = useRouter();
  const params = useSearchParams();

  const savedSearchId = params.get("saved");
  const focusId = params.get("focus");

  const [criteria, setCriteria] = useState<CriteriaSet>(EMPTY_CRITERIA);
  const [orderBy, setOrderBy] = useState<OrderBy>("score");
  // A parcel id in the query string opens that parcel's drawer, which is how an
  // alert links to the thing it is about. Initial state rather than an effect:
  // as an effect it would also re-select the linked parcel after the user had
  // clicked away from it.
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [saveOpen, setSaveOpen] = useState(false);

  // What the map is currently showing, when the user has asked results to
  // follow it. Held here rather than in the criteria set on purpose: it narrows
  // what is displayed and is deliberately absent from anything that gets saved,
  // because where the map is pointing is not part of an acquisition thesis.
  const [followView, setFollowView] = useState(false);
  const [viewport, setViewport] = useState<MapViewport | null>(null);

  // Load a saved search when one is named in the URL, so an alert or the saved
  // criteria page can link straight into a live search.
  useEffect(() => {
    if (!savedSearchId) return;
    let cancelled = false;
    fetch(`/api/searches/${savedSearchId}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { search?: SavedSearch } | null) => {
        if (!cancelled && body?.search) setCriteria(body.search.criteria);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [savedSearchId]);

  const search = useParcelSearch(criteria, orderBy, viewport);

  const setGeometry = useCallback((geometry: Geometry | null) => {
    setCriteria((current) => ({
      ...current,
      filters: { ...current.filters, geometry: geometry ?? undefined },
    }));
  }, []);

  // Everything below narrows on `search.status` first. Until the published
  // artifact has attached there are no rows to count, so there is nothing here
  // that could render a match count - the surface can only say what it is
  // waiting for.
  const ready = search.status === "ready" ? search : null;
  const rows = ready?.rows ?? [];
  const total = ready?.total ?? 0;
  const loading = ready ? ready.loading : true;
  const error = ready?.error ?? null;

  const selectedRow = rows.find((row) => row.propertyId === selectedId) ?? null;

  return (
    <div className="grid h-[calc(100vh-104px)] min-h-0 grid-cols-1 gap-3 lg:grid-cols-[340px_minmax(0,1fr)_420px]">
      <div className="flex min-h-0 flex-col overflow-hidden">
        <CriteriaPanel
          criteria={criteria}
          onChange={setCriteria}
          courtDataAvailable={search.overlay.courtDataAvailable}
          onSave={() => setSaveOpen(true)}
        />
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden">
        {error && (
          <div className="mb-2 rounded-md border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-xs text-bad-500">
            {error}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <PropertyMap
            points={ready?.mapPoints ?? []}
            center={publicDataConfig.center}
            initialBounds={publicDataConfig.initialBounds}
            geometry={criteria.filters.geometry ?? null}
            onGeometryChange={setGeometry}
            onViewportChange={setViewport}
            followView={followView}
            onFollowViewChange={setFollowView}
            onSelect={setSelectedId}
            selectedId={selectedId}
            truncated={ready?.mapTruncated ?? false}
            total={total}
            loading={loading}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden">
        {search.status === "ready" ? (
          <ResultList
            rows={search.rows}
            total={search.total}
            loading={search.loading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            hasMore={search.hasMore}
            onLoadMore={search.loadMore}
            sql={search.sql}
            tookMs={search.tookMs}
            orderBy={orderBy}
            onOrderChange={setOrderBy}
            criteria={criteria}
            limitedToView={followView}
          />
        ) : (
          <AttachPanel search={search} />
        )}
      </div>

      <PropertyDrawer
        key={selectedId}
        propertyId={selectedId}
        onClose={() => setSelectedId(null)}
        score={selectedRow?.score ?? null}
        rationale={selectedRow?.rationale ?? null}
        savedSearchId={savedSearchId}
        onTracked={search.refresh}
      />

      {saveOpen && (
        <SaveSearchDialog
          criteria={criteria}
          matchCount={total}
          onClose={() => setSaveOpen(false)}
          onSaved={(search) => {
            setSaveOpen(false);
            router.push(`/searches?highlight=${search.id}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * What the result column shows before there is anything to rank.
 *
 * This exists because the alternative was a lie. The published parquet is
 * 49.97 MB of Duval County read over a public IPFS gateway, and on a cold load
 * the attach takes as long as the gateway takes. The surface used to say
 * "Searching", then "No parcels match these criteria" - so the first thing a
 * reviewer saw was a CRM that had searched 404,023 parcels and found nothing.
 *
 * A wait is fine. A wait that does not say what it is waiting for, how long it
 * has been waiting, or what it will do about it, is not.
 */
function AttachPanel({ search }: { search: Exclude<SearchState, { status: "ready" }> }) {
  return search.status === "attaching" ? (
    <Attaching attach={search.attach} />
  ) : (
    <Unavailable attach={search.attach} onRetry={search.retryAttach} />
  );
}

function Attaching({ attach }: { attach: AttachAttaching }) {
  const percent = attach.progress === null ? null : Math.round(attach.progress * 100);
  const slow = attach.elapsedMs > 20_000;

  return (
    <Panel
      title="Loading the county"
      subtitle={`${publicDataConfig.countyName} County, read straight from the gateway by this tab`}
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-300">{attachHeadline(attach)}</p>

        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-raised)]"
          role="progressbar"
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Query table load progress"
        >
          <div
            className={
              percent === null
                ? "h-full w-1/3 animate-pulse rounded-full bg-accent-500/70"
                : "h-full rounded-full bg-accent-500 transition-[width] duration-300"
            }
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>

        <p className="text-[11px] text-ink-500">
          Reading from <span className="mono text-ink-400">{hostname(attach.gateway)}</span>
          {attach.gatewayCount > 1 &&
            ` - ${attach.gatewayCount - attach.gatewayIndex - 1} more gateway${
              attach.gatewayCount - attach.gatewayIndex - 1 === 1 ? "" : "s"
            } to fall back on`}
          .
        </p>

        {attach.failedOver && (
          <p className="rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-[11px] text-warn-500">
            The configured gateway did not answer in time, so this tab moved to a public IPFS
            gateway. It is the same content-addressed artifact either way.
          </p>
        )}

        {slow && !attach.failedOver && (
          <p className="text-[11px] text-ink-500">
            Public IPFS gateways are slow on a cold read. Nothing is wrong; the tab is fetching the
            parquet and will fall back to another gateway if this one stalls.
          </p>
        )}
      </div>
    </Panel>
  );
}

function Unavailable({ attach, onRetry }: { attach: AttachFailed; onRetry: () => void }) {
  return (
    <Panel title="The county data could not be read">
      <div className="space-y-3">
        <p className="rounded-md border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-xs text-bad-500">
          {attach.error}
        </p>
        <p className="text-[11px] text-ink-500">
          Tried {attach.tried.length} gateway{attach.tried.length === 1 ? "" : "s"}:{" "}
          <span className="mono text-ink-400">
            {attach.tried.map((url) => hostname(url)).join(", ")}
          </span>
          . This is the gateway, not the CRM: saved criteria, alerts and opportunities are
          unaffected.
        </p>
        <Button variant="primary" onClick={onRetry} className="w-full">
          Try the gateways again
        </Button>
      </div>
    </Panel>
  );
}

function hostname(url: string): string {
  try {
    return new URL(url, "https://localhost").host || url;
  } catch {
    return url;
  }
}

/**
 * Saving is the moment a query becomes something watched, so the dialog states
 * what that means rather than just taking a name: the first pass records what
 * already matches without alerting, and everything after it is a change.
 */
function SaveSearchDialog({
  criteria,
  matchCount,
  onClose,
  onSaved,
}: {
  criteria: CriteriaSet;
  matchCount: number;
  onClose: () => void;
  onSaved: (search: SavedSearch) => void;
}) {
  const [name, setName] = useState(criteria.name === "Untitled search" ? "" : criteria.name);
  const [description, setDescription] = useState(criteria.description ?? "");
  const [inApp, setInApp] = useState(true);
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [limit, setLimit] = useState("25");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = await post<{ search: SavedSearch }>("/api/searches", {
        name: name.trim() || "Untitled search",
        description: description.trim() || null,
        criteria: { ...criteria, name: name.trim() || criteria.name },
        notifyInApp: inApp,
        notifyEmail: email,
        notifySms: sms,
        alertLimitPerRun: Math.max(1, Math.min(500, Number(limit) || 25)),
      });
      onSaved(body.search);
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiError && cause.isStoreReadOnly
          ? "The CRM store on this deployment is attached read only, so criteria cannot be saved. Search itself is unaffected."
          : cause instanceof Error
            ? cause.message
            : "Could not save the search.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md">
        <Panel
          title="Save these criteria"
          subtitle={`${count(matchCount)} parcels match right now`}
          actions={
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="Name">
              <TextInput value={name} onChange={setName} placeholder="Arlington tired landlords" />
            </Field>
            <Field label="Note" hint="Why this thesis, for whoever picks it up later.">
              <TextArea value={description} onChange={setDescription} rows={2} />
            </Field>

            <div className="rounded-md border border-[var(--line)] bg-[var(--panel-raised)] px-3 py-2 text-[11px] text-ink-400">
              The first matcher pass records these {count(matchCount)} parcels as the baseline
              without alerting. After that you are told when a parcel newly matches, or when one
              that already matched changes underneath you.
            </div>

            <div className="space-y-2">
              <Toggle checked={inApp} onChange={setInApp} label="Alert me in the app" />
              <Toggle
                checked={email}
                onChange={setEmail}
                label="Send a mocked email"
                hint="Simulated. Nothing leaves this deployment."
              />
              <Toggle checked={sms} onChange={setSms} label="Send a mocked SMS" />
            </div>

            <Field
              label="Most alerts per pass"
              hint="Anything beyond this is counted and suppressed."
            >
              <TextInput type="number" value={limit} onChange={setLimit} />
            </Field>

            {error && (
              <p className="rounded-md border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-xs text-bad-500">
                {error}
              </p>
            )}

            <Button variant="primary" onClick={save} disabled={saving} className="w-full">
              {saving ? "Saving" : "Save and watch"}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
