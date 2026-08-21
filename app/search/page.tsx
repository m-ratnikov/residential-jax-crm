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
import { ApiError, post, type SavedSearch, type SearchResponse } from "@/lib/client";
import { EMPTY_CRITERIA, type CriteriaSet, type Geometry } from "@/lib/criteria/types";

const PAGE_SIZE = 100;

/**
 * useSearchParams opts a route out of static prerendering unless it sits under
 * a Suspense boundary, so the shell renders immediately and the criteria load
 * from the URL a tick later.
 */
export default function SearchPage() {
  return (
    <Suspense fallback={<div className="p-8 text-xs text-ink-500">Loading the search workspace</div>}>
      <SearchWorkspace />
    </Suspense>
  );
}

function SearchWorkspace() {
  const router = useRouter();
  const params = useSearchParams();

  const [criteria, setCriteria] = useState<CriteriaSet>(EMPTY_CRITERIA);
  const [orderBy, setOrderBy] = useState<"score" | "assessed_value" | "roof_age" | "tenure">("score");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [rows, setRows] = useState<SearchResponse["rows"]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [center, setCenter] = useState({ lat: 30.3322, lng: -81.6557, zoom: 10.5 });
  const [courtDataAvailable, setCourtDataAvailable] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  // Load a saved search when one is named in the URL, so an alert or the saved
  // criteria page can link straight into a live search.
  const savedSearchId = params.get("saved");
  useEffect(() => {
    if (!savedSearchId) return;
    let cancelled = false;
    fetch(`/api/searches/${savedSearchId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { search?: SavedSearch } | null) => {
        if (!cancelled && body?.search) setCriteria(body.search.criteria);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [savedSearchId]);

  useEffect(() => {
    fetch("/api/datasource")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { map?: typeof center; overlay?: { courtDataAvailable: boolean } } | null) => {
        if (body?.map) setCenter(body.map);
        if (body?.overlay) setCourtDataAvailable(body.overlay.courtDataAvailable);
      })
      .catch(() => undefined);
  }, []);

  // Only the criteria that affect the query take part in the debounce key, so
  // renaming a search does not re-run it.
  const queryKey = useMemo(
    () => JSON.stringify({ filters: criteria.filters, weights: criteria.weights, orderBy }),
    [criteria.filters, criteria.weights, orderBy],
  );

  const requestId = useRef(0);

  const runSearch = useCallback(
    async (nextOffset: number, append: boolean) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const body = await post<SearchResponse>("/api/search", {
          criteria,
          limit: PAGE_SIZE,
          offset: nextOffset,
          orderBy,
          includeMap: !append,
        });
        // A slow earlier request must not overwrite a faster later one.
        if (id !== requestId.current) return;
        setResult((current) => (append && current ? { ...body, map: current.map } : body));
        setRows((current) => (append ? [...current, ...body.rows] : body.rows));
        setOffset(nextOffset);
        setCourtDataAvailable(body.courtDataAvailable);
      } catch (cause: unknown) {
        if (id !== requestId.current) return;
        setError(cause instanceof ApiError ? cause.message : "The search failed.");
        if (!append) {
          setRows([]);
          setResult(null);
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [criteria, orderBy],
  );

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(0, false), 250);
    return () => clearTimeout(timer);
    // runSearch closes over criteria and orderBy, both in queryKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const setGeometry = useCallback((geometry: Geometry | null) => {
    setCriteria((current) => ({
      ...current,
      filters: { ...current.filters, geometry: geometry ?? undefined },
    }));
  }, []);

  const selectedRow = rows.find((row) => row.propertyId === selectedId) ?? null;

  return (
    <div className="grid h-[calc(100vh-104px)] grid-cols-1 gap-3 lg:grid-cols-[320px_minmax(0,1fr)_400px]">
      <div className="flex min-h-0 flex-col">
        <CriteriaPanel
          criteria={criteria}
          onChange={setCriteria}
          courtDataAvailable={courtDataAvailable}
          onSave={() => setSaveOpen(true)}
        />
      </div>

      <div className="min-h-0">
        {error && (
          <div className="mb-2 rounded-md border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-xs text-bad-500">
            {error}
          </div>
        )}
        <div className={error ? "h-[calc(100%-38px)]" : "h-full"}>
          <PropertyMap
            points={result?.map.points ?? []}
            center={center}
            geometry={criteria.filters.geometry ?? null}
            onGeometryChange={setGeometry}
            onSelect={setSelectedId}
            selectedId={selectedId}
            truncated={result?.map.truncated}
            total={result?.total}
            loading={loading}
          />
        </div>
      </div>

      <div className="min-h-0">
        <ResultList
          rows={rows}
          total={result?.total ?? 0}
          loading={loading}
          selectedId={selectedId}
          onSelect={setSelectedId}
          hasMore={Boolean(result && rows.length < result.total)}
          onLoadMore={() => void runSearch(offset + PAGE_SIZE, true)}
          sql={result?.sql ?? ""}
          tookMs={result?.tookMs ?? 0}
          orderBy={orderBy}
          onOrderChange={setOrderBy}
        />
      </div>

      <PropertyDrawer
        propertyId={selectedId}
        onClose={() => setSelectedId(null)}
        score={selectedRow?.score ?? null}
        rationale={selectedRow?.rationale ?? null}
        savedSearchId={savedSearchId}
        criteria={criteria}
        onTracked={() => void runSearch(0, false)}
      />

      {saveOpen && (
        <SaveSearchDialog
          criteria={criteria}
          matchCount={result?.total ?? 0}
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
  const [name, setName] = useState(
    criteria.name === "Untitled search" ? "" : criteria.name,
  );
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
        cause instanceof ApiError && cause.isStoreMissing
          ? "No CRM store is attached to this deployment, so searches cannot be saved. Set DATABASE_URL and run the migration."
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
              The first matcher pass records these {count(matchCount)} parcels as the baseline without
              alerting. After that you are told when a parcel newly matches, or when one that already
              matched changes underneath you.
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

            <Field label="Most alerts per pass" hint="Anything beyond this is counted and suppressed.">
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
