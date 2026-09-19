import { Info } from "lucide-react";

export function EmptyState({ title, hint, icon: Icon = Info }: { title: string; hint?: string; icon?: typeof Info }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-6 text-center">
      <Icon size={20} className="mx-auto text-slate-300" />
      <p className="mt-1.5 text-sm font-medium text-slate-500">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
      {message}
    </div>
  );
}