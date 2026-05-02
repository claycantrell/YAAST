import { z } from 'zod';
import type { SummaryRequest } from './types';

export const SummarySchema = z.object({
  headline: z.string(),
  purpose: z.string(),
  methods_used: z.array(z.string()),
  techniques: z.array(z.string()),
  risks: z.array(z.string()),
  confidence: z.enum(['low', 'medium', 'high']),
});

export const SYSTEM_PROMPT = `You summarize a single code symbol for an IDE drawer UI.

Return a single JSON object that conforms exactly to the supplied schema.
Base every claim only on the supplied code and metadata.
Do not invent runtime behavior, performance characteristics, or dependencies.
Prefer short, concrete phrasing suitable for editor UI.

Field guidance:
- "headline" reads like a compact virtual header (<= 72 chars, no trailing period).
- "purpose" is one short sentence (<= 120 chars).
- "methods_used" lists direct callees, helpers, or APIs visible in the code (max 6).
- "techniques" describes implementation patterns, not generic fluff (max 5).
- "risks" mentions caveats only if supported by the code (max 3).
- "confidence" is "low" | "medium" | "high".
- Do not repeat the symbol name in "headline" unless it improves clarity.
- If evidence is insufficient, use empty arrays and lower confidence.`;

export function buildUserMessage(req: SummaryRequest): string {
  const lines = [
    'Generate a compact summary for one code symbol.',
    '',
    'Metadata:',
    `language: ${req.languageId}`,
    `symbol_kind: ${req.symbolKind}`,
    `symbol_path: ${JSON.stringify(req.symbolPath)}`,
    `signature: ${req.signature}`,
  ];
  if (req.containerSignature) lines.push(`container_signature: ${req.containerSignature}`);
  if (req.staticCalls?.length) lines.push(`static_calls: ${JSON.stringify(req.staticCalls)}`);
  if (req.visibleImports?.length) lines.push(`visible_imports: ${JSON.stringify(req.visibleImports)}`);
  lines.push(`truncated: ${req.truncated}`);
  lines.push('', 'Code:', req.codeSlice);
  return lines.join('\n');
}
