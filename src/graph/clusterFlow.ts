import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { gatherEvidence, type FileEvidence } from './evidence';
import { clusterFiles, type ClusterRunInfo } from './clusterer';
import type { SummaryCache, ClusterRecord } from '../cache/summaryCache';

const CLUSTER_PROMPT_VERSION = 'v1';
const FILE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py}';
const EXCLUDE =
  '{**/node_modules/**,**/dist/**,**/out/**,**/.next/**,**/.open-next/**,**/build/**,**/target/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.git/**,**/.vscode-test/**,**/coverage/**,**/.turbo/**,**/.cache/**,**/.parcel-cache/**,**/.svelte-kit/**,**/.nuxt/**,**/.output/**,**/.expo/**,**/.docusaurus/**,**/.claude/**,**/playwright-report/**,**/test-results/**,**/storybook-static/**,**/.yarn/**,**/.pnpm-store/**,**/*.min.js,**/*.bundle.js,**/*.d.ts}';

export interface ClusterFlowProgress {
  step: 'scanning' | 'cache-check' | 'calling-llm' | 'storing' | 'done';
  scanned: number;
  total: number;
  message?: string;
}

export interface ClusterFlowResult {
  record: ClusterRecord;
  evidence: FileEvidence[];
  cached: boolean;
  runInfo?: ClusterRunInfo;
}

export async function runClusterFlow(args: {
  cache: SummaryCache;
  apiKey: string;
  model: string;
  output: vscode.OutputChannel;
  cancel: vscode.CancellationToken;
  onProgress: (p: ClusterFlowProgress) => void;
  forceRefresh?: boolean;
}): Promise<ClusterFlowResult> {
  const { cache, apiKey, model, output, cancel, onProgress, forceRefresh } = args;
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error('Open a workspace folder first.');

  onProgress({ step: 'scanning', scanned: 0, total: 0, message: 'finding files' });
  const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE, 8000);
  if (cancel.isCancellationRequested) throw new Error('cancelled');

  const evidence = await gatherEvidence(uris, cancel, (scanned, total) =>
    onProgress({ step: 'scanning', scanned, total }),
  );
  if (cancel.isCancellationRequested) throw new Error('cancelled');

  onProgress({ step: 'cache-check', scanned: evidence.length, total: evidence.length });
  const evidenceHash = computeEvidenceHash(evidence, model);

  if (!forceRefresh) {
    const cached = cache.getCluster(evidenceHash);
    if (cached) {
      output.appendLine(`[cluster] cache hit (${cached.clusters.length} clusters, ${evidence.length} files)`);
      onProgress({ step: 'done', scanned: evidence.length, total: evidence.length, message: 'cache hit' });
      return { record: cached, evidence, cached: true };
    }
  }

  onProgress({
    step: 'calling-llm',
    scanned: evidence.length,
    total: evidence.length,
    message: `clustering ${evidence.length} files with ${model}`,
  });

  const runInfo = await clusterFiles({
    apiKey,
    model,
    evidence,
    output,
    cancel,
  });

  // Resolve file_ids → file_paths.
  const idToPath = new Map(evidence.map((e) => [e.id, e.path]));
  const clusters = runInfo.result.clusters.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    file_paths: c.file_ids.map((fid) => idToPath.get(fid)).filter((p): p is string => !!p),
  }));

  const record: ClusterRecord = {
    evidenceHash,
    modelId: runInfo.modelId,
    promptVersion: CLUSTER_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    inputTokens: runInfo.inputTokens,
    outputTokens: runInfo.outputTokens,
    latencyMs: runInfo.latencyMs,
    clusters,
  };

  onProgress({ step: 'storing', scanned: evidence.length, total: evidence.length });
  await cache.setCluster(record);
  output.appendLine(
    `[cluster] stored: ${clusters.length} clusters, in=${runInfo.inputTokens}, out=${runInfo.outputTokens}, ${runInfo.latencyMs}ms`,
  );

  onProgress({ step: 'done', scanned: evidence.length, total: evidence.length });
  return { record, evidence, cached: false, runInfo };
}

function computeEvidenceHash(evidence: FileEvidence[], model: string): string {
  // Stable, order-independent hash of the evidence input.
  const sorted = evidence
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.path}|${e.topSymbols.join(',')}`)
    .join('\n');
  return createHash('sha256')
    .update(`${CLUSTER_PROMPT_VERSION}|${model}|${sorted}`)
    .digest('hex');
}
