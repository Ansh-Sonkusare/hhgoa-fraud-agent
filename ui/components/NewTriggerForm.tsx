"use client";

import { useState } from "react";
import { FlaskConical, FileText, Eye, Rocket, Check } from "lucide-react";
import { postNewTrigger } from "../lib/api";
import type { TriggerType } from "../lib/types";

const KINDS: { kind: TriggerType; label: string; icon: typeof Eye; hint: string }[] = [
  { kind: "risk_score", label: "Risk score", icon: Rocket, hint: "A transaction flagged by the model." },
  { kind: "customer_report", label: "Customer report", icon: FileText, hint: "A cardholder contacts the bank." },
  { kind: "analyst_request", label: "Analyst request", icon: Eye, hint: "An analyst opens an investigation." },
];

// Real triggers from the dataset's case pack (HHG-001, HHG-006, HHG-014), so an
// example submitted as-is investigates ids that exist in the graph.
const EXAMPLES: Record<TriggerType, Record<string, string>> = {
  risk_score: { txnId: "3514030", cardId: "C12382-K1", riskScore: "0.61" },
  customer_report: {
    customerId: "C07297",
    txnId: "3476682",
    text: "I never made this $482.12 purchase. Please check my card.",
  },
  analyst_request: {
    cardId: "C13487-K1",
    question:
      "Several cards this month show purchases from the same unusual device profile. Review transaction 3478561 and look for related activity.",
  },
};

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

  function fillExample() {
    const ex = EXAMPLES[kind];
    setTxnId(ex.txnId ?? "");
    setCardId(ex.cardId ?? "");
    setCustomerId(ex.customerId ?? "");
    setRiskScore(ex.riskScore ?? "0.5");
    setText(ex.text ?? "");
    setQuestion(ex.question ?? "");
    setNote(null);
    setError(null);
  }

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
    <form onSubmit={submit} className="panel space-y-4">
      <h2 className="panel-title">
        <FlaskConical size={14} /> New trigger <span className="font-normal normal-case text-slate-400">· PRD §9.1 — 3 trigger types</span>
      </h2>

      <div className="grid gap-2 sm:grid-cols-3">
        {KINDS.map(({ kind: k, label, icon: Icon, hint }) => {
          const selected = kind === k;
          return (
            <button
              type="button"
              key={k}
              onClick={() => {
                setKind(k);
                setNote(null);
                setError(null);
              }}
              className={`rounded-xl border p-3 text-left transition ${
                selected
                  ? "border-slate-900 bg-slate-900 text-white shadow-sm"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              <span className="flex items-center justify-between">
                <Icon size={16} className={selected ? "text-white" : "text-slate-500"} />
                {selected ? <Check size={14} className="text-emerald-400" /> : null}
              </span>
              <span className="mt-2 block text-sm font-semibold">{label}</span>
              <span className={`mt-0.5 block text-xs ${selected ? "text-slate-300" : "text-slate-500"}`}>{hint}</span>
            </button>
          );
        })}
      </div>

      {kind === "risk_score" && (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-xs font-medium text-slate-600">
            Transaction ID
            <input className="input" placeholder="e.g. 3514030" value={txnId} onChange={(e) => setTxnId(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium text-slate-600">
            Card ID <span className="text-slate-400">(optional)</span>
            <input className="input" placeholder="e.g. C11891-K1" value={cardId} onChange={(e) => setCardId(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium text-slate-600">
            Risk score 0–1
            <input className="input" value={riskScore} onChange={(e) => setRiskScore(e.target.value)} />
          </label>
        </div>
      )}

      {kind === "customer_report" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-slate-600">
            Customer ID
            <input className="input" placeholder="e.g. C1001234" value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium text-slate-600">
            Transaction ID <span className="text-slate-400">(optional)</span>
            <input className="input" placeholder="e.g. 3514030" value={txnId} onChange={(e) => setTxnId(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium text-slate-600 sm:col-span-2">
            What the customer says
            <textarea className="input min-h-[3.5rem]" placeholder="e.g. I didn't make these purchases" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </div>
      )}

      {kind === "analyst_request" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-slate-600">
            Card ID
            <input className="input" placeholder="e.g. C11891-K1" value={cardId} onChange={(e) => setCardId(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium text-slate-600">
            Question
            <input className="input" placeholder="e.g. Is this card part of a larger ring?" value={question} onChange={(e) => setQuestion(e.target.value)} />
          </label>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? "Submitting…" : "Start investigation"}
        </button>
        <button type="button" onClick={fillExample} className="btn-ghost">
          Use example input
        </button>
      </div>

      {note ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{note}</p> : null}
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p> : null}
    </form>
  );
}