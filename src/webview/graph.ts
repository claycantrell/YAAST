// Webview-side bundle for YAAST Repo Graph.
// Aggregates the file/import data from the indexer at a chosen folder depth
// (default: 2). At depth N, every file path is bucketed into its first N
// path segments — so src/lib/offline/sync-processor.ts becomes "src/lib".
// Aggregating this way turns a hairball into something readable.

import cytoscape, { type ElementDefinition } from 'cytoscape';

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscodeApi = acquireVsCodeApi();

interface FileNode {
  id: string;
  uri: string;
  basename: string;
  folder: string;
  language: string;
  symbolCount: number;
  loc: number;
  fileSummaryHeadline?: string;
}
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
interface ProgressPayload { type: 'progress'; step: string; scanned: number; total: number; message?: string }
interface ErrorPayload { type: 'error'; message: string }
type Incoming = RepoGraphPayload | ProgressPayload | ErrorPayload;

const HARD_NODE_CAP = 1500;

const status = document.getElementById('status') as HTMLDivElement;
const search = document.getElementById('search') as HTMLInputElement;
const layoutSelect = document.getElementById('layout') as HTMLSelectElement;
const depthSelect = document.getElementById('depth') as HTMLSelectElement;
const detail = document.getElementById('detail') as HTMLDivElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const orphanToggle = document.getElementById('hideOrphans') as HTMLInputElement;
const intraToggle = document.getElementById('hideIntra') as HTMLInputElement;
const externalsToggle = document.getElementById('showExternals') as HTMLInputElement;

let cy: cytoscape.Core | undefined;
let last: RepoGraphPayload | undefined;

window.addEventListener('error', (ev) => {
  status.textContent = `script error: ${ev.message}`;
  status.classList.add('error');
});

refreshBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'refresh' }));
search.addEventListener('input', applyFilter);
layoutSelect.addEventListener('change', () => runLayout());
depthSelect.addEventListener('change', () => last && render(last));
orphanToggle.addEventListener('change', () => last && render(last));
intraToggle.addEventListener('change', () => last && render(last));
externalsToggle.addEventListener('change', () => last && render(last));

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
    last = msg;
    render(msg);
  }
});

vscodeApi.postMessage({ type: 'ready' });

interface Bucket {
  id: string;
  label: string;
  fileCount: number;
  symbolCount: number;
  loc: number;
  files: FileNode[];
  hasSummary: boolean;
}

function bucketIdFor(path: string, depth: number | 'files'): string {
  if (depth === 'files') return path;
  const parts = path.split('/');
  return parts.slice(0, Math.max(1, depth)).join('/');
}

function aggregate(g: RepoGraphPayload, depthRaw: string): {
  buckets: Map<string, Bucket>;
  edges: Map<string, { source: string; target: string; weight: number }>;
} {
  const depth: number | 'files' = depthRaw === 'files' ? 'files' : Math.max(1, parseInt(depthRaw, 10));
  const buckets = new Map<string, Bucket>();
  for (const f of g.files) {
    const id = bucketIdFor(f.id, depth);
    let b = buckets.get(id);
    if (!b) {
      b = {
        id,
        label: id,
        fileCount: 0,
        symbolCount: 0,
        loc: 0,
        files: [],
        hasSummary: false,
      };
      buckets.set(id, b);
    }
    b.fileCount++;
    b.symbolCount += f.symbolCount;
    b.loc += f.loc;
    b.files.push(f);
    if (f.fileSummaryHeadline) b.hasSummary = true;
  }
  const edges = new Map<string, { source: string; target: string; weight: number }>();
  for (const e of g.edges) {
    const s = bucketIdFor(e.source, depth);
    const t = bucketIdFor(e.target, depth);
    if (!buckets.has(s) || !buckets.has(t)) continue;
    const k = `${s}${t}`;
    const existing = edges.get(k);
    if (existing) existing.weight += e.importCount;
    else edges.set(k, { source: s, target: t, weight: e.importCount });
  }
  return { buckets, edges };
}

function render(g: RepoGraphPayload): void {
  const depthRaw = depthSelect.value;
  const isFileLevel = depthRaw === 'files';
  const hideOrphans = orphanToggle.checked;
  const hideIntra = intraToggle.checked && !isFileLevel; // doesn't apply at file level
  const showExternals = externalsToggle.checked;

  const { buckets, edges } = aggregate(g, depthRaw);

  // Drop self-edges; optionally keep them under the "intra" view.
  const filteredEdges = Array.from(edges.values()).filter((e) => {
    if (e.source === e.target) return false;
    return true;
  });

  // hideIntra is about edges within the SAME bucket, which already became
  // self-edges and were dropped. The remaining cross-bucket edges are what
  // the user wants. The toggle stays for symmetry / future grouping modes.
  void hideIntra;

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
    visible = visible
      .slice()
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, HARD_NODE_CAP);
    capNote = ` · capped at ${HARD_NODE_CAP} of ${buckets.size}`;
  }
  const visibleIds = new Set(visible.map((b) => b.id));
  const visibleEdges = filteredEdges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

  const externalsToShow = showExternals ? g.externals.slice(0, 50) : [];

  layoutSelect.dataset.effective = pickLayout(visible.length + externalsToShow.length);

  const elements: ElementDefinition[] = [];

  for (const b of visible) {
    const fileSummaries = b.files
      .filter((f) => f.fileSummaryHeadline)
      .map((f) => `${f.basename}: ${f.fileSummaryHeadline}`)
      .slice(0, 5);
    elements.push({
      data: {
        id: b.id,
        label: isFileLevel
          ? (b.files[0]?.fileSummaryHeadline ?? b.files[0]?.basename ?? b.label)
          : `${b.label} (${b.fileCount})`,
        kind: isFileLevel ? 'file' : 'folder',
        path: b.id,
        uri: isFileLevel ? b.files[0]?.uri : undefined,
        fileCount: b.fileCount,
        symbolCount: b.symbolCount,
        loc: b.loc,
        weight: Math.max(1, b.fileCount),
        sampleSummaries: fileSummaries.join('\n'),
      },
      classes: b.hasSummary ? 'has-summary' : 'no-summary',
    });
  }

  for (const ext of externalsToShow) {
    elements.push({
      data: {
        id: `ext:${ext.id}`,
        label: ext.id,
        kind: 'external',
        usage: ext.usageCount,
        weight: Math.max(1, Math.min(20, Math.ceil(Math.log2(ext.usageCount + 1)))),
      },
      classes: 'external',
    });
  }

  for (const e of visibleEdges) {
    elements.push({
      data: {
        id: `${e.source}${e.target}`,
        source: e.source,
        target: e.target,
        weight: e.weight,
      },
    });
  }

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
          color: 'var(--node-fg, #fff)',
          'border-width': 1,
          padding: '8px',
          shape: 'round-rectangle',
          width: 'mapData(weight, 1, 50, 80, 220)',
          height: 'mapData(weight, 1, 50, 36, 80)',
        },
      },
      {
        selector: 'node.has-summary',
        style: { 'background-color': '#16a34a', 'border-color': '#15803d' },
      },
      {
        selector: 'node.no-summary',
        style: { 'background-color': '#2563eb', 'border-color': '#1e40af' },
      },
      {
        selector: 'node.external',
        style: {
          'background-color': '#6366f1',
          'border-color': '#4338ca',
          shape: 'ellipse',
          width: 'mapData(weight, 0, 20, 24, 60)',
          height: 'mapData(weight, 0, 20, 24, 60)',
          'font-size': '10px',
        },
      },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          width: 'mapData(weight, 1, 30, 1, 6)',
          'line-color': '#64748b',
          'target-arrow-color': '#64748b',
          'arrow-scale': 0.8,
          opacity: 0.7,
        },
      },
      {
        selector: 'node:selected',
        style: { 'border-color': '#f59e0b', 'border-width': 3 },
      },
    ],
  });

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const data = node.data();
    showDetail(data);
    if (data.kind === 'file' && data.uri) {
      vscodeApi.postMessage({ type: 'open', uri: data.uri });
    }
  });
  cy.on('mouseover', 'node', (evt) => showDetail(evt.target.data()));

  applyFilter();
  runLayout();

  const depthLabel = isFileLevel ? 'files' : `depth ${depthRaw}`;
  status.textContent = `${depthLabel} · ${visible.length} nodes · ${visibleEdges.length} edges · ${g.files.length} files / ${g.scannedFiles} scanned · ${g.durationMs}ms${capNote}`;
  status.classList.remove('error');
}

function showDetail(d: Record<string, unknown>): void {
  if (d.kind === 'external') {
    detail.innerHTML = `<strong>${escapeHtml(String(d.label))}</strong><div class="meta">external package · used ${d.usage} time(s)</div>`;
    return;
  }
  if (d.kind === 'folder') {
    const sample = String(d.sampleSummaries ?? '').trim();
    detail.innerHTML = `<strong>${escapeHtml(String(d.label))}</strong>
      <div class="meta">${d.fileCount} files · ${d.symbolCount} symbols · ${d.loc} lines</div>
      ${sample ? `<div class="meta">sample summaries:</div><pre>${escapeHtml(sample)}</pre>` : ''}`;
    return;
  }
  // file kind
  detail.innerHTML = `<strong>${escapeHtml(String(d.label))}</strong>
    <div class="meta">${escapeHtml(String(d.path ?? ''))}</div>
    <div class="meta">${d.symbolCount} symbols · ${d.loc} lines</div>
    <div class="meta">click to open</div>`;
}

function applyFilter(): void {
  if (!cy) return;
  const q = search.value.trim().toLowerCase();
  cy.batch(() => {
    cy!.nodes().forEach((n) => {
      const d = n.data();
      const hay = `${d.label ?? ''} ${d.path ?? ''} ${d.sampleSummaries ?? ''}`.toLowerCase();
      n.style('display', q.length === 0 || hay.includes(q) ? 'element' : 'none');
    });
    cy!.edges().forEach((e) => {
      const visible =
        e.source().style('display') !== 'none' && e.target().style('display') !== 'none';
      e.style('display', visible ? 'element' : 'none');
    });
  });
}

function pickLayout(count: number): string {
  if (layoutSelect.value !== 'auto') return layoutSelect.value;
  if (count <= 60) return 'cose';
  if (count <= 400) return 'breadthfirst';
  return 'grid';
}

function runLayout(): void {
  if (!cy) return;
  const effective = (layoutSelect.dataset.effective || layoutSelect.value) as
    | 'cose' | 'breadthfirst' | 'circle' | 'grid';
  const total = cy.nodes().length;
  const base: Record<string, unknown> = { name: effective, animate: false, fit: true, padding: 20 };
  if (effective === 'cose') {
    base.numIter = Math.min(800, Math.max(100, Math.floor(20000 / Math.max(1, total))));
    base.nodeRepulsion = 6000;
    base.idealEdgeLength = 100;
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
