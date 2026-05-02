# Repo Graph (experimental)

Read-only architectural map of a codebase, opened from `YAAST: Open Repo Graph`. Two view modes share the same scan:

- **Folder mode** (default before clustering): nodes are folders aggregated to a chosen depth (default 2). Edges are summed cross-folder imports. Pure local data, no API calls.
- **Cluster mode** (single LLM call): nodes are AI-named feature areas — "Authentication", "Offline Sync", "Billing" — with a one-sentence description each. Edges are summed cross-cluster imports. ~$0.07 per repo on Haiku 4.5; cached on disk; reusable across sessions.

## Pipeline

```
findFiles  →  repoIndexer  →  RepoGraph (files, edges, externals)
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
       Folder mode (no API)                  Cluster mode (one LLM call)
       webview aggregates by                 evidence.ts gathers per-file
       depth N path segments                 evidence (path + top symbols),
                                             clusterer.ts sends one structured
                                             call → {clusters[].file_ids[]},
                                             clusterFlow.ts hashes + caches.
```

## Imports

`repoIndexer.ts` walks workspace files (TS/JS/Python with sensible excludes), regex-extracts ES imports, dynamic imports, CommonJS `require`, ES re-exports, and Python `from x import` / `import x`. Resolves relative paths and TS/JS path aliases (loaded from `tsconfig.json` / `jsconfig.json`, plus a Next.js-flavored `@/` → `src/` fallback). External (bare) imports are aggregated into a usage-counted external-package list and rendered as satellite nodes when toggled on.

Comments are stripped before regex matching but string contents are preserved (the spec inside `from 'foo'` is the bit we want).

## Clustering

`clusterer.ts` sends a single `messages.parse` call to Anthropic with one line per file:

```
f0042 | src/lib/offline/sync-processor.ts | SyncProcessor, processQueue, retryFailed
```

Output schema (Zod):

```ts
{ clusters: [{ id, label, description, file_ids: [...] }] }
```

The model sees only path + top-level symbol names. No code bodies, no imports, no cached file summaries (yet). All grouping is its judgment over that thin evidence. Folder names are evidence; the model is told not to mirror folder structure mechanically when a more meaningful semantic grouping exists.

Files the model misses (output truncation) get swept into an "Unassigned" cluster so they always render. `stop_reason=max_tokens` is logged when we hit the cap.

## Cache

Three compartments under `globalStorageUri`, all loaded on activation:

```
summaries/        — symbol-level summaries (cacheKey = content hash)
file-summaries/   — file-level summaries (uri-keyed)
clusters/         — cluster results (evidenceHash-keyed)
```

Cluster cache key: `sha256(promptVersion + model + sorted (path|symbols))`. Adding a file, removing one, or changing a top-level symbol invalidates and reclusters; whitespace-only edits don't.

## Costs

Per repo, Haiku 4.5:

| Repo size | Cluster call cost | Wall time |
|---|---|---|
| ~100 files | ~$0.01 | ~3s |
| ~700 files | ~$0.07 | ~6–10s |
| ~5000 files | ~$0.50 | hits 16K output cap; needs streaming or chunking |

Re-opens free until the file set / signatures change.

## Out of scope (today)

- Per-file imports / call edges as cluster-call evidence (would sharpen labels).
- Cached file-summary headlines as cluster-call evidence (same).
- Streaming output for repos that exceed the 16K non-streaming output ceiling.
- Drill-down: clicking a cluster shows its files in a side panel; clicking a file opens it. There's no expand-into-symbols view yet.
- Cross-language edges (e.g. a Python service called from a TS frontend).
