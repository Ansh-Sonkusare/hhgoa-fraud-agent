"use client";

import { useState } from "react";
import { postNewTrigger } from "../lib/api";
import type { TriggerType } from "../lib/types";

export function NewTriggerForm({ onCreated }: { onCreated: (caseId: string) => void }) {
  const [kind, setKind] = useState<TriggerType>("risk_score");
  const [txnId, setTxnId] = useState("");
  const [cardId, setCardId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [riskScore, setRiskScore] = useState("0.5");
  const [text, setText] = useState("");
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNote(null);
    try {
      const trigger =
        kind === "risk_score"
          ? { kind, txn_id: txnId || undefined, card_id: cardId || undefined, risk_score: Number(riskScore) }
          : kind === "customer_report"
            ? { kind, customer_id: customerId, txn_ids: txnId ? [txnId] : undefined, text }
            : { kind, entity: { type: "Card", id: cardId }, question };
      const result = await postNewTrigger(trigger);
      setNote(result.note);
      onCreated(result.case_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-3">
      <h2 className="panel-title">New trigger (PRD §9.1 — 3 trigger types)</h2>
      <div className="flex gap-4 text-sm">
        {(["risk_score", "customer_report", "analyst_request"] as const).map((t) => (
          <label key={t} className="flex items-center gap-1">
            <input type="radio" name="kind" checked={kind === t} onChange={() => setKind(t)} />
            {t}
          </label>
        ))}
      </div>

      {kind === "risk_score" && (
        <div className="grid grid-cols-3 gap-2">
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="txn_id"
            value={txnId}
            onChange={(e) => setTxnId(e.target.value)}
          />
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="card_id"
            value={cardId}
            onChange={(e) => setCardId(e.target.value)}
          />
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="risk_score (0-1)"
            value={riskScore}
            onChange={(e) => setRiskScore(e.target.value)}
          />
        </div>
      )}

      {kind === "customer_report" && (
        <div className="grid grid-cols-2 gap-2">
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="customer_id"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          />
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="txn_id (optional)"
            value={txnId}
            onChange={(e) => setTxnId(e.target.value)}
          />
          <textarea
            className="col-span-2 rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="Customer message"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}

      {kind === "analyst_request" && (
        <div className="grid grid-cols-2 gap-2">
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="card_id"
            value={cardId}
            onChange={(e) => setCardId(e.target.value)}
          />
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="Analyst question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit trigger"}
      </button>

      {note ? <p className="text-xs text-slate-500">{note}</p> : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </form>
  );
}
