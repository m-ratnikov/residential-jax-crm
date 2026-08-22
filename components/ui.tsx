/**
 * The small vocabulary every page is built from.
 *
 * Kept deliberately plain: a panel, a badge, a stat, a button, a field. There is
 * no component library here because the whole UI is a handful of shapes, and a
 * dependency would cost more to keep consistent than the shapes cost to write.
 *
 * The rule that matters: anything conveying meaning by colour also says it in
 * words. A stage chip is coloured AND labelled, a match score is coloured AND
 * numeric.
 */

"use client";

import type { ReactNode } from "react";

import { ownerNameCharacter } from "@/lib/data/map";
import { STAGE_LABELS, type AcquisitionStage, type OutreachStatus } from "@/lib/notify/types";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* Layout                                                               */
/* ------------------------------------------------------------------ */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cx(
        "rounded-xl border border-[var(--line)] bg-[var(--panel)] overflow-hidden",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {/* min-h-0 flex-1 so that a Panel given `flex h-full flex-col` lets its
          body take the remaining height and scroll, rather than growing past
          the panel and being clipped. Inert on a panel that is not a flex
          column, which is most of them. */}
      <div className={cx("min-h-0 flex-1 px-4 py-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-good-500"
      : tone === "warn"
        ? "text-warn-500"
        : tone === "bad"
          ? "text-bad-500"
          : "text-ink-100";
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className={cx("tabular mt-1 text-xl font-semibold", toneClass)}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-400">{hint}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink-300">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-lg text-xs text-ink-500">{children}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-400">
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-ink-600 border-t-accent-500" />
      {label ?? "Working"}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Controls                                                             */
/* ------------------------------------------------------------------ */

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  disabled,
  title,
  type = "button",
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const sizes = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-[13px]";
  const variants = {
    default: "border-[var(--line)] bg-[var(--panel-raised)] text-ink-100 hover:bg-ink-700",
    primary: "border-accent-500 bg-accent-500 text-white hover:bg-accent-600",
    ghost: "border-transparent bg-transparent text-ink-300 hover:bg-[var(--panel-raised)]",
    danger: "border-[var(--line)] bg-transparent text-bad-500 hover:bg-ink-800",
  }[variant];

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(base, sizes, variants, className)}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  // Full height with the control pushed to the bottom, so that two fields side
  // by side line up even when one label wraps to a second line and the other
  // does not. "Held at least (years)" next to "At most (years)" did exactly
  // that, and the two inputs sat at different heights.
  return (
    <label className="flex h-full flex-col">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{label}</span>
      <div className="mt-auto pt-1">
        {children}
        {hint && <p className="mt-1 text-[11px] text-ink-500">{hint}</p>}
      </div>
    </label>
  );
}

const CONTROL =
  "w-full rounded-md border border-[var(--line)] bg-[var(--panel-raised)] px-2.5 py-1.5 text-[13px] text-ink-100 outline-none placeholder:text-ink-600 focus:border-accent-500";

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "date" | "email";
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={CONTROL}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={cx(CONTROL, "resize-y")}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className={CONTROL}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-2 text-[13px]",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 accent-[var(--color-accent-500)]"
      />
      <span>
        <span className="text-ink-200">{label}</span>
        {hint && <span className="block text-[11px] text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export function Badge({
  children,
  tone = "neutral",
  title,
  testId,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "good" | "warn" | "bad" | "outline";
  title?: string;
  /** Stable hook for the deployed-runtime smoke check. */
  testId?: string;
}) {
  const tones = {
    neutral: "bg-ink-800 text-ink-300 border-transparent",
    accent: "bg-accent-500/15 text-accent-400 border-accent-500/30",
    good: "bg-good-500/15 text-good-500 border-good-500/30",
    warn: "bg-warn-500/15 text-warn-500 border-warn-500/30",
    bad: "bg-bad-500/15 text-bad-500 border-bad-500/30",
    outline: "bg-transparent text-ink-400 border-[var(--line)]",
  }[tone];
  return (
    <span
      title={title}
      data-testid={testId}
      className={cx(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tones,
      )}
    >
      {children}
    </span>
  );
}

const STAGE_TONE: Record<AcquisitionStage, "neutral" | "accent" | "good" | "warn" | "bad"> = {
  identified: "neutral",
  contacted: "accent",
  negotiating: "warn",
  under_contract: "good",
  closed: "good",
  dead: "bad",
};

export function StageBadge({ stage }: { stage: AcquisitionStage }) {
  return <Badge tone={STAGE_TONE[stage]}>{STAGE_LABELS[stage]}</Badge>;
}

const STATUS_TONE: Record<OutreachStatus, "neutral" | "accent" | "good" | "warn" | "bad"> = {
  queued: "neutral",
  sent: "neutral",
  delivered: "accent",
  opened: "accent",
  replied: "good",
  bounced: "bad",
  returned: "bad",
  failed: "bad",
};

export function StatusBadge({ status }: { status: OutreachStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status.replace("_", " ")}</Badge>;
}

/**
 * A match score, coloured by band and always shown as a number. The bands are
 * arbitrary and the tooltip says so; what is not arbitrary is that the number
 * and its rationale travel together everywhere this appears.
 */
export function ScoreBadge({ score, title }: { score: number; title?: string }) {
  const tone = score >= 75 ? "good" : score >= 45 ? "warn" : "neutral";
  return (
    <Badge tone={tone} title={title ?? "Match score out of 100. Hover a row for the rationale."}>
      <span className="tabular" data-testid="score">
        {score.toFixed(0)}
      </span>
    </Badge>
  );
}

/**
 * Says when the owner of record is evidently not a person.
 *
 * A hospital, a church and a homeowners association all pass a residential
 * acquisition thesis on the county roll: ST VINCENTS HOSPITAL INC sat in the
 * Negotiating stage under the task "Confirm both heirs will sign", and the
 * parcel a church owns at 001 usage with 1,702 livable square feet is a house
 * by every column the filter reads. `dwellingsOnly` cannot catch them, because
 * there is nothing wrong with the dwelling.
 *
 * So this labels rather than filters, which is the whole of the difference. No
 * row is dropped, no score moves, and the reader is told which token in the
 * name made the app say so - a rule you can argue with beats a row that
 * silently vanished. `ownerNameCharacter` carries the measured accuracy.
 */
export function OwnerKindBadge({ name }: { name: string | null | undefined }) {
  const character = ownerNameCharacter(name);
  if (character.kind !== "organisation") return null;
  return (
    <Badge
      tone="warn"
      testId="owner-organisation"
      title={`The owner of record reads as an organisation rather than a person: the name carries "${character.token}". A heuristic on the published name, not a registry lookup - the roll publishes no owner-type column. Nothing is filtered on it.`}
    >
      organisation owner
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* Simulated owner contact                                             */
/* ------------------------------------------------------------------ */

/** The mocked skip-trace block, structurally. See lib/crm/skip-trace.ts. */
export interface SimulatedContactDetails {
  readonly phone: string;
  readonly email: string;
  readonly provider: string;
  readonly basis: string;
}

/**
 * The MOCKED skip-trace contact, rendered the same way everywhere it appears.
 *
 * This lived only inside the parcel drawer, and the deal page - the screen a
 * converted alert actually lands on - rendered `owner.email ?? "not on file"`
 * and never read `skipTrace` at all. Two surfaces showing the same document two
 * different ways is how that happened, so there is now one block and both
 * surfaces render it.
 *
 * It is fenced, tinted, badged, and repeats the provider and the reason under
 * the values. That is louder than a design would normally want, and it is the
 * point: a telephone number on a CRM screen is something somebody dials, so the
 * one thing that must never happen is a reader taking this for a real number.
 */
export function SimulatedContact({
  contact,
  className,
  testId = "owner-contact-simulated",
}: {
  contact: SimulatedContactDetails;
  className?: string;
  /** Stable hook for the deployed-runtime smoke check. */
  testId?: string;
}) {
  return (
    <div className={cx("rounded-md border border-warn-500/50 bg-warn-500/10 p-2.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="warn" testId={testId}>
          simulated contact
        </Badge>
        <span className="text-[11px] font-medium text-warn-500">
          not a real phone number or email address
        </span>
      </div>
      <dl className="mt-2 space-y-1.5 text-[11px]">
        <SimulatedRow label="Phone (mock)" value={contact.phone} mono />
        <SimulatedRow label="Email (mock)" value={contact.email} mono />
        <SimulatedRow label="Generated by" value={contact.provider} />
      </dl>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">{contact.basis}</p>
    </div>
  );
}

function SimulatedRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-ink-500">{label}</dt>
      <dd className={cx("min-w-0 flex-1 break-words text-ink-200", mono ? "mono" : "tabular")}>
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function money(value: number | null | undefined, fallback = "not published"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

/**
 * A count and its noun, agreeing.
 *
 * "Send to 1 owners" was on the button that launches the outreach campaign,
 * which is the last thing a person reads before a batch of messages goes out.
 * A noun glued to `count()` is the standard way to produce that, so the fix is
 * a function rather than a corrected string: the next caller gets agreement for
 * free instead of reintroducing the same defect.
 *
 * The irregular plural is a parameter because English has some, and a rule that
 * only appends "s" would quietly write "1 propertys" one day.
 */
export function plural(
  value: number | null | undefined,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  const amount = value === null || value === undefined || !Number.isFinite(value) ? 0 : value;
  return `${count(amount)} ${Math.abs(amount) === 1 ? singular : pluralForm}`;
}

/**
 * A year is an ordinal, not a quantity, so it never takes a thousands
 * separator: 1916, not 1,916. Anything that is not a number falls back to the
 * raw value, because showing what was published beats showing "NaN".
 */
export function year(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return String(value);
  return String(Math.trunc(parsed));
}

/**
 * A timestamp in any of the shapes the pipeline hands one over in: a Date, an
 * ISO string, or epoch milliseconds arriving as a number, a bigint or a numeric
 * string - which is what a parquet TIMESTAMP column becomes once it has crossed
 * Arrow into the browser. Returns null when the value is not a timestamp at
 * all, so a caller can show what it actually got rather than "Invalid Date".
 *
 * Epoch detection is deliberately narrow (11 to 14 digits, so 1973 to 2972). A
 * four digit year is never mistaken for an epoch, and neither is a parcel
 * number.
 */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "bigint") return finite(new Date(Number(value)));
  if (typeof value === "number") return Number.isFinite(value) ? finite(new Date(value)) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d{11,14}$/.test(text)) return finite(new Date(Number(text)));
  return finite(new Date(withZone(text)));
}

/**
 * A datetime the publisher wrote without a zone, read as UTC.
 *
 * The same instant reached two screens by two routes and rendered seven hours
 * apart. `fetched_at` is a parquet TIMESTAMP, so the browser gets it as epoch
 * milliseconds and lands on the right instant; the native driver hands the
 * server "2026-08-21 13:58:56.294", that string is what a stored
 * `propertySnapshot.provenance.fetchedAt` holds, and `new Date` parses a
 * space-separated datetime with the LEGACY rules, which read it as local. In a
 * UTC+7 tab the drawer said 08:58 PM and the deal page said 01:58 PM for one
 * collection time.
 *
 * The pipeline publishes UTC, so a datetime with no zone on it is UTC and is
 * given the "Z" it was written without. Anchored on a required time part: a
 * bare date is NOT touched here. `new Date("2026-08-21")` is already UTC by
 * spec, and the drawer's TIMESTAMP_COLUMNS note records why a bare date is
 * never turned into a local timestamp in the first place - doing so moves it a
 * day in every negative UTC offset.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function withZone(text: string): string {
  return NAIVE_DATETIME.test(text) ? `${text.replace(" ", "T")}Z` : text;
}

function finite(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A timestamp, in the reader's own zone, saying which zone that is.
 *
 * The zone is named rather than left to be inferred. Provenance is read as
 * evidence, the artifact is stamped in UTC and the reader is not, so a bare
 * "08:58 PM" is a number two people in two places will disagree about. This is
 * the deliberate half of the fix above: `toDate` settles WHICH instant, this
 * settles which clock it is being shown on, and neither is left incidental.
 */
export function when(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "never";
  const date = toDate(value);
  if (!date) return String(value);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function ago(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "never";
  const date = toDate(value);
  if (!date) return String(value);
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)} d ago`;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
