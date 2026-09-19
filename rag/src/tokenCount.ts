/**
 * Approximate token counting.
 *
 * We deliberately do not pull in a real tokenizer (tiktoken/etc.) — the
 * budget check in PRD §11/R4 ("context_bundle <= 6k tokens") is a curation
 * discipline, not a billing-accurate count, and the LLM backend is
 * Ollama/Groq (PRD §5, docs/decisions.md), not OpenAI, so a GPT tokenizer
 * would be actively misleading here. The standard rule of thumb for
 * English text (~4 chars/token) is within ~10-15% of real BPE tokenizers
 * for prose like ours (policy text, case narratives), which is precise
 * enough for a budget guard. Documented here once so every caller shares
 * the same assumption instead of re-deriving it.
 */
export function approxTokenCount(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
