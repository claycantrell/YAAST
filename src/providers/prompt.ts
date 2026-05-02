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

export const BatchSummarySchema = z.object({
  summaries: z.array(
    SummarySchema.extend({
      id: z.string(),
    }),
  ),
});

export const FileSummarySchema = z.object({
  headline: z.string(),
  overview: z.string(),
  main_features: z.array(z.string()),
});

export type FileSummaryJson = z.infer<typeof FileSummarySchema>;

export const FILE_SYSTEM_PROMPT = `You summarize a code file at a high level for a reader skimming it for the first time.

Return a single JSON object that conforms exactly to the supplied schema.
Base every claim only on the supplied code or outline.
Prefer plain language: describe what the file does and what's in it, not how it's implemented in detail.

Field guidance:
- "headline" is the file's one-line elevator pitch (<= 80 chars, no trailing period).
- "overview" is 2-4 sentences (<= 600 chars). Explain what the file is for, what it exposes, and any important context.
- "main_features" is 3-6 short bullets naming the notable things this file provides. Each <= 80 chars.
- Do not invent dependencies, runtime behavior, or relationships not visible in the input.
- If the file is mostly empty or boilerplate, say so plainly and use a small main_features list.`;

export interface FilePromptInput {
  path: string;
  languageId: string;
  content: string;
  truncated: boolean;
}

export function buildFileUserMessage(input: FilePromptInput): string {
  const lines = [
    'Summarize this code file.',
    '',
    `path: ${input.path}`,
    `language: ${input.languageId}`,
    `truncated: ${input.truncated}`,
    '',
    'Code:',
    input.content,
  ];
  return lines.join('\n');
}

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

export const BATCH_SYSTEM_PROMPT = `You summarize a batch of code symbols for an IDE drawer UI.

Return a single JSON object {summaries: [...]} where each entry includes the same "id"
that was provided for that symbol in the input.

For every symbol, follow the same field guidance as a single-symbol summary:
- "headline" reads like a compact virtual header (<= 72 chars, no trailing period).
- "purpose" is one short sentence (<= 120 chars).
- "methods_used" lists direct callees, helpers, or APIs visible in the code (max 6).
- "techniques" describes implementation patterns, not generic fluff (max 5).
- "risks" mentions caveats only if supported by the code (max 3).
- "confidence" is "low" | "medium" | "high".
- Do not repeat the symbol name in "headline" unless it improves clarity.
- If evidence is insufficient for any symbol, use empty arrays and lower confidence.

Cover every "id" in the input. Do not invent ids that weren't provided.`;

export interface BatchItem extends SummaryRequest {
  id: string;
}

export function buildBatchUserMessage(items: BatchItem[]): string {
  const lines = [
    `Summarize the following ${items.length} code symbol${items.length === 1 ? '' : 's'}.`,
    '',
    'Each symbol below begins with --- BEGIN <id> --- and ends with --- END <id> ---.',
    'In your response, every "id" string in "summaries" must exactly match one of these ids.',
    '',
  ];
  for (const item of items) {
    lines.push(`--- BEGIN ${item.id} ---`);
    lines.push(`language: ${item.languageId}`);
    lines.push(`symbol_kind: ${item.symbolKind}`);
    lines.push(`symbol_path: ${JSON.stringify(item.symbolPath)}`);
    lines.push(`signature: ${item.signature}`);
    if (item.containerSignature) lines.push(`container_signature: ${item.containerSignature}`);
    if (item.staticCalls?.length) lines.push(`static_calls: ${JSON.stringify(item.staticCalls)}`);
    lines.push(`truncated: ${item.truncated}`);
    lines.push('code:');
    lines.push(item.codeSlice);
    lines.push(`--- END ${item.id} ---`);
    lines.push('');
  }
  return lines.join('\n');
}

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
