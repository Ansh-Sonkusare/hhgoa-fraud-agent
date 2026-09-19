export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
      {message}
    </div>
  );
}
