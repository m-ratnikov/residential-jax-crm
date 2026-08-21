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
      <div className={cx("px-4 py-3", bodyClassName)}>{children}</div>
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
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-ink-500">{hint}</p>}
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
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "good" | "warn" | "bad" | "outline";
  title?: string;
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
      <span className="tabular">{score.toFixed(0)}</span>
    </Badge>
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

export function when(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ago(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
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
