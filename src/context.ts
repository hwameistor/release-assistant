import type { ModelInfo } from '@github/copilot-sdk';

/** The SDK performs token-aware compaction. Preflight uses UTF-8 bytes as a
 * conservative estimate, not a claimed tokenizer count or a whole-release cap. */
export function contextBudget(model: ModelInfo | undefined, initialText: string) {
  if (!model) return { chunkBytes: 12000 };
  const limits = model.capabilities.limits;
  const reserve = Math.min(limits.max_output_tokens ?? 16000, 16000);
  const inputTokens = Math.min(limits.max_prompt_tokens ?? Infinity, limits.max_context_window_tokens - reserve);
  if (!Number.isFinite(inputTokens) || inputTokens < 1) throw new Error('Copilot returned unusable model context limits');
  // Reserve space for tool results, SDK framing and the first investigation response.
  if (Buffer.byteLength(initialText) > inputTokens * 0.7) {
    throw new Error('Research instructions exceed the model input budget; shorten the policy. Release diffs are already paginated.');
  }
  return { chunkBytes: Math.max(512, Math.min(12000, Math.floor(inputTokens * 0.1))), limits };
}
