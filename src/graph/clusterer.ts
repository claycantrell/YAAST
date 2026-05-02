import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { FileEvidence } from './evidence';

export const ClusterSchema = z.object({
  clusters: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      file_ids: z.array(z.string()),
    }),
  ),
});

export type ClusterResult = z.infer<typeof ClusterSchema>;

export interface ClusterRunInfo {
  result: ClusterResult;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

const CLUSTER_SYSTEM = `You organize a codebase into feature clusters for a reader who is meeting it for the first time.

Your job: group every file into one of 5–15 clusters. Each cluster represents a coherent area of functionality — for example "user authentication", "offline sync", "billing flow", "admin dashboard", "shared UI components". Names should be plain English, 2–5 words, what a non-developer would call this area.

Rules:
- Every file id from the input must appear in exactly one cluster's file_ids.
- Avoid generic clusters like "utilities" or "miscellaneous" unless they are genuinely distinct from everything else.
- If multiple files together form a feature, prefer one cluster over scattering them.
- Don't mirror folder structure mechanically — group by what the code does, not where it lives. But folders are evidence; use them.
- Use the symbol names as primary signal: a file with createCheckoutSession + chargeCard is billing, regardless of folder.
- The "description" is one short sentence (≤120 chars). Tell the reader what this area does.

Return a single JSON object matching the schema. No prose, no markdown.`;

export async function clusterFiles(args: {
  apiKey: string;
  model: string;
  evidence: FileEvidence[];
  output: vscode.OutputChannel;
  cancel: vscode.CancellationToken;
}): Promise<ClusterRunInfo> {
  const { apiKey, model, evidence, output, cancel } = args;

  const client = new Anthropic({ apiKey });
  const userMessage = buildUserMessage(evidence);

  output.appendLine(
    `[cluster] sending ${evidence.length} files (~${Math.round(userMessage.length / 4)} tokens) to ${model}`,
  );
  const start = Date.now();

  const response = await client.messages.parse({
    model,
    max_tokens: Math.min(8192, 200 + Math.ceil(evidence.length * 5)),
    system: [
      { type: 'text', text: CLUSTER_SYSTEM, cache_control: { type: 'ephemeral' } },
    ],
    output_config: { format: zodOutputFormat(ClusterSchema) },
    messages: [{ role: 'user', content: userMessage }],
  });

  if (cancel.isCancellationRequested) throw new Error('cancelled');

  const elapsed = Date.now() - start;
  const usage = response.usage;
  output.appendLine(
    `[cluster] ${elapsed}ms in=${usage.input_tokens} out=${usage.output_tokens}`,
  );

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Cluster response did not parse');

  // Sanity: ensure every input file is covered, drop bogus ids.
  const inputIds = new Set(evidence.map((e) => e.id));
  const seen = new Set<string>();
  const cleanedClusters = parsed.clusters
    .map((c) => ({
      ...c,
      file_ids: c.file_ids.filter((fid) => {
        if (!inputIds.has(fid)) return false;
        if (seen.has(fid)) return false;
        seen.add(fid);
        return true;
      }),
    }))
    .filter((c) => c.file_ids.length > 0);

  // Any files the model missed → put in an "unassigned" cluster so they still
  // render. This usually means an output truncation.
  const missed = evidence.filter((e) => !seen.has(e.id)).map((e) => e.id);
  if (missed.length > 0) {
    cleanedClusters.push({
      id: 'unassigned',
      label: 'Unassigned',
      description: `Files the clusterer didn't place (${missed.length}). Often boilerplate, tests, or files at output truncation.`,
      file_ids: missed,
    });
  }

  return {
    result: { clusters: cleanedClusters },
    modelId: model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    latencyMs: elapsed,
  };
}

function buildUserMessage(evidence: FileEvidence[]): string {
  const lines: string[] = [];
  lines.push(`You will cluster ${evidence.length} files. Each line below is one file:`);
  lines.push('');
  lines.push('format: <id> | <path> | <top symbols>');
  lines.push('');
  for (const e of evidence) {
    const symbols = e.topSymbols.length > 0 ? e.topSymbols.join(', ') : '(no top-level symbols)';
    lines.push(`${e.id} | ${e.path} | ${symbols}`);
  }
  lines.push('');
  lines.push('Group every id into one of 5–15 clusters. Return JSON.');
  return lines.join('\n');
}
