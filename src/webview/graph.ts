// Webview-side bundle for YAAST Repo Graph.
// Two modes:
//   1) cluster — nodes are AI-named feature areas; edges are import counts between them.
//   2) folder  — nodes are folder buckets aggregated to depth N; edges are import counts.
// Cluster mode requires a one-shot LLM call (the "Cluster repo" button). Folder mode
// runs purely from local data.

import cytoscape, { type ElementDefinition } from 'cytoscape';

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscodeApi = acquireVsCodeApi();

interface FileNode { id: string; uri: string; basename: string; folder: string; language: string; symbolCount: number; loc: number; fileSummaryHeadline?: string }
interface FileEdge { source: string; target: string; importCount: number }
interface ExternalNode { id: string; usageCount: number }
interface RepoGraphPayload {
  type: 'repoGraph';
  files: FileNode[];
  edges: FileEdge[];
  externals: ExternalNode[];
  scannedFiles: number;
  unresolvedImports: number;
  durationMs: number;
}
interface ClusterPayload {
  type: 'cluster';
  record: {
    evidenceHash: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    clusters: Array<{ id: string; label: string; description: string; file_paths: string[] }>;
  };
  cached: boolean;
  runInfo?: { inputTokens: number; outputTokens: number; latencyMs: number };
}
interface ProgressPayload { type: 'progress'; step: string; scanned: number; total: number; message?: string }
interface ErrorPayload { type: 'error'; message: string }
type Incoming = RepoGraphPayload | ClusterPayload | ProgressPayload | ErrorPayload;

const HARD_NODE_CAP = 1500;

const status = document.getElementById('status') as HTMLDivElement;
const search = document.getElementById('search') as HTMLInputElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const depthSelect = document.getElementById('depth') as HTMLSelectElement;
const layoutSelect = document.getElementById('layout') as HTMLSelectElement;
const detail = document.getElementById('detail') as HTMLDivElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const clusterBtn = document.getElementById('cluster') as HTMLButtonElement;
const clusterRefreshBtn = document.getElementById('clusterRefresh') as HTMLButtonElement;
const orphanToggle = document.getElementById('hideOrphans') as HTMLInputElement;

let cy: cytoscape.Core | undefined;
let lastGraph: RepoGraphPayload | undefined;
let lastCluster: ClusterPayload | undefined;

window.addEventListener('error', (ev) => {
  status.textContent = `script error: ${ev.message}`;
  status.classList.add('error');
});

refreshBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'refresh' }));
clusterBtn.addEventListener('click', () => {
  status.textContent = 'starting cluster…';
  vscodeApi.postMessage({ type: 'cluster', force: false });
});
clusterRefreshBtn.addEventListener('click', () => {
  status.textContent = 'recomputing clusters…';
  vscodeApi.postMessage({ type: 'cluster', force: true });
});
search.addEventListener('input', applyFilter);
layoutSelect.addEventListener('change', () => runLayout());
modeSelect.addEventListener('change', () => rerender());
depthSelect.addEventListener('change', () => rerender());
orphanToggle.addEventListener('change', () => rerender());

window.addEventListener('message', (ev) => {
  const msg = ev.data as Incoming;
  if (msg.type === 'progress') {
    status.textContent = `${msg.step}: ${msg.scanned}/${msg.total}${msg.message ? ` — ${msg.message}` : ''}`;
    status.classList.remove('error');
    return;
  }
  if (msg.type === 'error') {
    status.textContent = `error: ${msg.message}`;
    status.classList.add('error');
    return;
  }
  if (msg.type === 'repoGraph') {
    lastGraph = msg;
    rerender();
    return;
  }
  if (msg.type === 'cluster') {
    lastCluster = msg;
    modeSelect.value = 'cluster';
    rerender();
    return;
  }
});

vscodeApi.postMessage({ type: 'ready' });

function rerender(): void {
  if (!lastGraph) return;
  if (modeSelect.value === 'cluster' && lastCluster) {
    renderCluster(lastGraph, lastCluster);
  } else {
    if (modeSelect.value === 'cluster' && !lastCluster) {
      modeSelect.value = 'folder';
    }
    renderFolder(lastGraph);
  }
}

// ---------- Cluster mode ----------

function renderCluster(g: RepoGraphPayload, c: ClusterPayload): void {
  const hideOrphans = orphanToggle.checked;

  const clusterById = new Map(c.record.clusters.map((cl) => [cl.id, cl]));
  const fileToCluster = new Map<string, string>();
  for (const cl of c.record.clusters) {
    for (const path of cl.file_paths) fileToCluster.set(path, cl.id);
  }

  // Aggregate file-to-file imports up to cluster-to-cluster edges.
  const edgeMap = new Map<string, { source: string; target: string; weight: number }>();
  for (const e of g.edges) {
    const s = fileToCluster.get(e.source);
    const t = fileToCluster.get(e.target);
    if (!s || !t || s === t) continue;
    const k = `${s}${t}`;
    const existing = edgeMap.get(k);
    if (existing) existing.weight += e.importCount;
    else edgeMap.set(k, { source: s, target: t, weight: e.importCount });
  }
  const edges = Array.from(edgeMap.values());

  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }

  const fileMap = new Map(g.files.map((f) => [f.id, f]));

  let visibleClusters = c.record.clusters.slice();
  if (hideOrphans) visibleClusters = visibleClusters.filter((cl) => connected.has(cl.id));

  const visibleIds = new Set(visibleClusters.map((cl) => cl.id));
  const visibleEdges = edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

  layoutSelect.dataset.effective = pickLayout(visibleClusters.length);

  const elements: ElementDefinition[] = [];

  for (const cl of visibleClusters) {
    elements.push({
      data: {
        id: cl.id,
        label: `${cl.label}\n(${cl.file_paths.length})`,
        kind: 'cluster',
        clusterId: cl.id,
        plainLabel: cl.label,
        description: cl.description,
        fileCount: cl.file_paths.length,
        weight: Math.max(1, cl.file_paths.length),
      },
      classes: 'cluster',
    });
  }

  for (const e of visibleEdges) {
    elements.push({
      data: {
        id: `${e.source}${e.target}`,
        source: e.source,
        target: e.target,
        weight: e.weight,
      },
    });
  }

  buildCytoscape(elements);

  cy?.on('tap', 'node', (evt) => {
    const data = evt.target.data();
    showClusterDetail(data, clusterById.get(data.clusterId), fileMap);
  });
  cy?.on('mouseover', 'node', (evt) => {
    const data = evt.target.data();
    showClusterDetail(data, clusterById.get(data.clusterId), fileMap);
  });

  applyFilter();
  runLayout();

  const cachedNote = c.cached ? ' (cached)' : '';
  const tokenNote = c.runInfo ? ` · ${c.runInfo.inputTokens} in / ${c.runInfo.outputTokens} out tokens` : '';
  status.textContent = `cluster · ${visibleClusters.length} clusters · ${visibleEdges.length} edges · ${g.files.length} files${cachedNote}${tokenNote}`;
  status.classList.remove('error');
}

function showClusterDetail(
  data: Record<string, unknown>,
  cluster: { id: string; label: string; description: string; file_paths: string[] } | undefined,
  fileMap: Map<string, FileNode>,
): void {
  if (!cluster) {
    detail.textContent = String(data.label ?? '');
    return;
  }
  const lines: string[] = [];
  lines.push(`<strong>${escapeHtml(cluster.label)}</strong>`);
  lines.push(`<div class="meta">${cluster.file_paths.length} files</div>`);
  if (cluster.description) {
    lines.push(`<pre>${escapeHtml(cluster.description)}</pre>`);
  }
  lines.push(`<div class="file-list">`);
  for (const p of cluster.file_paths.slice(0, 80)) {
    const f = fileMap.get(p);
    const headline = f?.fileSummaryHeadline;
    const uri = f?.uri ?? '';
    const display = headline ? `<strong>${escapeHtml(p)}</strong><br/><span style="opacity:0.7;font-size:11px;">${escapeHtml(headline)}</span>` : escapeHtml(p);
    lines.push(`<div class="file" data-uri="${escapeHtml(uri)}">${display}</div>`);
  }
  if (cluster.file_paths.length > 80) {
    lines.push(`<div class="meta">… and ${cluster.file_paths.length - 80} more</div>`);
  }
  lines.push(`</div>`);
  detail.innerHTML = lines.join('\n');
  detail.querySelectorAll<HTMLElement>('.file').forEach((el) => {
    el.addEventListener('click', () => {
      const uri = el.dataset.uri;
      if (uri) vscodeApi.postMessage({ type: 'open', uri });
    });
  });
}

// ---------- Folder mode ----------

function renderFolder(g: RepoGraphPayload): void {
  const depthRaw = depthSelect.value;
  const isFileLevel = depthRaw === 'files';
  const hideOrphans = orphanToggle.checked;

  const depth: number | 'files' = isFileLevel ? 'files' : Math.max(1, parseInt(depthRaw, 10));
  const buckets = new Map<string, { id: string; fileCount: number; symbolCount: number; loc: number; files: FileNode[]; hasSummary: boolean }>();
  for (const f of g.files) {
    const id = bucketIdFor(f.id, depth);
    let b = buckets.get(id);
    if (!b) {
      b = { id, fileCount: 0, symbolCount: 0, loc: 0, files: [], hasSummary: false };
      buckets.set(id, b);
    }
    b.fileCount++;
    b.symbolCount += f.symbolCount;
    b.loc += f.loc;
    b.files.push(f);
    if (f.fileSummaryHeadline) b.hasSummary = true;
  }

  const edgeMap = new Map<string, { source: string; target: string; weight: number }>();
  for (const e of g.edges) {
    const s = bucketIdFor(e.source, depth);
    const t = bucketIdFor(e.target, depth);
    if (s === t) continue;
    if (!buckets.has(s) || !buckets.has(t)) continue;
    const k = `${s}${t}`;
    const existing = edgeMap.get(k);
    if (existing) existing.weight += e.importCount;
    else edgeMap.set(k, { source: s, target: t, weight: e.importCount });
  }

  const filteredEdges = Array.from(edgeMap.values());
  const connected = new Set<string>();
  for (const e of filteredEdges) {
    connected.add(e.source);
    connected.add(e.target);
  }

  let visible = Array.from(buckets.values());
  if (hideOrphans) visible = visible.filter((b) => connected.has(b.id));

  let capNote = '';
  if (visible.length > HARD_NODE_CAP) {
    const degree = new Map<string, number>();
    for (const e of filteredEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    visible = visible.slice().sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, HARD_NODE_CAP);
    capNote = ` · capped at ${HARD_NODE_CAP} of ${buckets.size}`;
  }
  const visibleIds = new Set(visible.map((b) => b.id));
  const visibleEdges = filteredEdges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

  layoutSelect.dataset.effective = pickLayout(visible.length);

  const elements: ElementDefinition[] = [];
  for (const b of visible) {
    elements.push({
      data: {
        id: b.id,
        label: isFileLevel ? (b.files[0]?.fileSummaryHeadline ?? b.files[0]?.basename ?? b.id) : `${b.id} (${b.fileCount})`,
        kind: isFileLevel ? 'file' : 'folder',
        path: b.id,
        uri: isFileLevel ? b.files[0]?.uri : undefined,
        fileCount: b.fileCount,
        symbolCount: b.symbolCount,
        loc: b.loc,
        weight: Math.max(1, b.fileCount),
      },
      classes: b.hasSummary ? 'has-summary' : 'no-summary',
    });
  }
  for (const e of visibleEdges) {
    elements.push({
      data: { id: `${e.source}${e.target}`, source: e.source, target: e.target, weight: e.weight },
    });
  }

  buildCytoscape(elements);

  cy?.on('tap', 'node', (evt) => {
    const data = evt.target.data();
    showFolderDetail(data);
    if (data.kind === 'file' && data.uri) {
      vscodeApi.postMessage({ type: 'open', uri: data.uri });
    }
  });
  cy?.on('mouseover', 'node', (evt) => showFolderDetail(evt.target.data()));

  applyFilter();
  runLayout();

  const depthLabel = isFileLevel ? 'files' : `depth ${depthRaw}`;
  status.textContent = `folder · ${depthLabel} · ${visible.length} nodes · ${visibleEdges.length} edges · ${g.files.length} files${capNote}`;
  status.classList.remove('error');
}

function showFolderDetail(d: Record<string, unknown>): void {
  detail.innerHTML = `<strong>${escapeHtml(String(d.label))}</strong>
    <div class="meta">${escapeHtml(String(d.path ?? ''))}</div>
    <div class="meta">${d.fileCount} files · ${d.symbolCount} symbols · ${d.loc} lines</div>
    ${d.kind === 'file' ? '<div class="meta">click to open</div>' : ''}`;
}

// ---------- Shared ----------

function bucketIdFor(path: string, depth: number | 'files'): string {
  if (depth === 'files') return path;
  return path.split('/').slice(0, Math.max(1, depth)).join('/');
}

function buildCytoscape(elements: ElementDefinition[]): void {
  if (cy) cy.destroy();
  cy = cytoscape({
    container: document.getElementById('graph')!,
    elements,
    wheelSensitivity: 0.25,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'font-size': '12px',
          'text-wrap': 'wrap',
          'text-max-width': '220px',
          'text-valign': 'center',
          'text-halign': 'center',
          color: '#ffffff',
          'border-width': 1,
          padding: '8px',
          shape: 'round-rectangle',
          width: 'mapData(weight, 1, 50, 90, 220)',
          height: 'mapData(weight, 1, 50, 40, 80)',
        },
      },
      { selector: 'node.has-summary', style: { 'background-color': '#16a34a', 'border-color': '#15803d' } },
      { selector: 'node.no-summary', style: { 'background-color': '#2563eb', 'border-color': '#1e40af' } },
      { selector: 'node.cluster', style: { 'background-color': '#7c3aed', 'border-color': '#5b21b6', 'font-size': '13px', 'font-weight': 600 } },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          width: 'mapData(weight, 1, 50, 1, 8)',
          'line-color': '#64748b',
          'target-arrow-color': '#64748b',
          'arrow-scale': 0.8,
          opacity: 0.7,
        },
      },
      { selector: 'node:selected', style: { 'border-color': '#f59e0b', 'border-width': 3 } },
    ],
  });
}

function applyFilter(): void {
  if (!cy) return;
  const q = search.value.trim().toLowerCase();
  cy.batch(() => {
    cy!.nodes().forEach((n) => {
      const d = n.data();
      const hay = `${d.label ?? ''} ${d.path ?? ''} ${d.plainLabel ?? ''} ${d.description ?? ''}`.toLowerCase();
      n.style('display', q.length === 0 || hay.includes(q) ? 'element' : 'none');
    });
    cy!.edges().forEach((e) => {
      const visible = e.source().style('display') !== 'none' && e.target().style('display') !== 'none';
      e.style('display', visible ? 'element' : 'none');
    });
  });
}

function pickLayout(count: number): string {
  if (layoutSelect.value !== 'auto') return layoutSelect.value;
  if (count <= 30) return 'cose';
  if (count <= 200) return 'breadthfirst';
  return 'grid';
}

function runLayout(): void {
  if (!cy) return;
  const effective = (layoutSelect.dataset.effective || layoutSelect.value) as 'cose' | 'breadthfirst' | 'circle' | 'grid';
  const total = cy.nodes().length;
  const base: Record<string, unknown> = { name: effective, animate: false, fit: true, padding: 20 };
  if (effective === 'cose') {
    base.numIter = Math.min(800, Math.max(100, Math.floor(20000 / Math.max(1, total))));
    base.nodeRepulsion = 6000;
    base.idealEdgeLength = 120;
    base.gravity = 0.2;
  }
  try {
    cy.layout(base as unknown as cytoscape.LayoutOptions).run();
  } catch (err) {
    status.textContent = `layout error: ${(err as Error).message}; falling back to grid`;
    cy.layout({ name: 'grid', fit: true, padding: 20 } as unknown as cytoscape.LayoutOptions).run();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
