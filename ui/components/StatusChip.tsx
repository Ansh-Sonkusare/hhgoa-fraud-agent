const VERDICT_STYLES: Record<string, string> = {
  fraud: "bg-red-100 text-red-800 border-red-200",
  legitimate: "bg-green-100 text-green-800 border-green-200",
  uncertain: "bg-amber-100 text-amber-800 border-amber-200",
};

const RISK_STYLES: Record<string, string> = {
  LOW: "bg-green-100 text-green-800 border-green-200",
  MEDIUM: "bg-amber-100 text-amber-800 border-amber-200",
  HIGH: "bg-orange-100 text-orange-800 border-orange-200",
  CRITICAL: "bg-red-100 text-red-800 border-red-200",
};

const STATUS_STYLES: Record<string, string> = {
  no_recording: "bg-slate-100 text-slate-600 border-slate-200",
  idle: "bg-slate-100 text-slate-600 border-slate-200",
  running: "bg-blue-100 text-blue-800 border-blue-200",
  done: "bg-slate-100 text-slate-700 border-slate-300",
  error: "bg-red-100 text-red-800 border-red-200",
};

type Tone = { dot: string; text: string };

function Chip({ label, className, tone }: { label: string; className: string; tone?: Tone }) {
  return (
    <span className={`${className} inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium`}>
      {tone ? <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} /> : null}
      <span className={tone?.text}>{label}</span>
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: string | null }) {
  if (!verdict) return <Chip label="not run" className="bg-slate-100 text-slate-500 border-slate-200" />;
  return <Chip label={verdict} className={VERDICT_STYLES[verdict] ?? "bg-slate-100 text-slate-700 border-slate-200"} />;
}

export function RiskChip({ level }: { level: string | null | undefined }) {
  if (!level) return null;
  return <Chip label={level} className={RISK_STYLES[level] ?? "bg-slate-100 text-slate-700 border-slate-200"} />;
}

export function StatusChip({ status }: { status: string }) {
  const label = status === "no_recording" ? "not run" : status;
  const tone: Tone | undefined =
    status === "running"
      ? { dot: "bg-blue-500 animate-pulse", text: "text-blue-800" }
      : status === "error"
        ? { dot: "bg-red-500", text: "text-red-800" }
        : status === "done"
          ? { dot: "bg-emerald-500", text: "text-slate-700" }
          : undefined;
  return <Chip label={label} className={STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700 border-slate-200"} tone={tone} />;
}

export function RouteChip({ route }: { route: string }) {
  const styles: Record<string, string> = {
    auto: "bg-slate-100 text-slate-700 border-slate-200",
    L1: "bg-amber-100 text-amber-800 border-amber-200",
    L2: "bg-red-100 text-red-800 border-red-200",
  };
  return <Chip label={route} className={styles[route] ?? "bg-slate-100 text-slate-700 border-slate-200"} />;
}