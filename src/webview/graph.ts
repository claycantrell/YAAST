// Webview-side bundle for YAAST Repo Graph.
// Receives a {files, edges, externals} payload from the extension and renders
// it via Cytoscape with file-as-node / import-as-edge semantics.

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
interface FileEdge {
  source: string;
  target: string;
  importCount: number;
}
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
const detail = document.getElementById('detail') as HTMLDivElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const orphanToggle = document.getElementById('hideOrphans') as HTMLInputElement;
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
orphanToggle.addEventListener('change', () => last && render(last));
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

function render(g: RepoGraphPayload): void {
  const hideOrphans = orphanToggle.checked;
  const showExternals = externalsToggle.checked;

  const connected = new Set<string>();
  for (const e of g.edges) {
    connected.add(e.source);
    connected.add(e.target);
  }

  let visibleFiles = hideOrphans ? g.files.filter((f) => connected.has(f.id)) : g.files;
  let capNote = '';
  if (visibleFiles.length > HARD_NODE_CAP) {
    const degree = new Map<string, number>();
    for (const e of g.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    visibleFiles = visibleFiles
      .slice()
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, HARD_NODE_CAP);
    capNote = ` · capped at ${HARD_NODE_CAP} of ${g.files.length}`;
  }
  const visibleIds = new Set(visibleFiles.map((f) => f.id));
  const visibleEdges = g.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

  // External packages that are imported by any visible file.
  const externalsToShow = showExternals ? g.externals.slice(0, 50) : [];

  layoutSelect.dataset.effective = pickLayout(visibleFiles.length + externalsToShow.length);

  const elements: ElementDefinition[] = [];

  // Folder compound nodes.
  const folders = new Set<string>();
  for (const f of visibleFiles) folders.add(folderId(f.folder));
  for (const folder of folders) {
    elements.push({
      data: { id: folder, label: folder.replace(/^folder:/, ''), kind: 'folder' },
      classes: 'folder-group',
    });
  }
  if (externalsToShow.length > 0) {
    elements.push({ data: { id: 'folder:external', label: 'external', kind: 'folder' }, classes: 'folder-group' });
  }

  for (const f of visibleFiles) {
    elements.push({
      data: {
        id: f.id,
        label: f.fileSummaryHeadline ?? f.basename,
        basename: f.basename,
        folder: f.folder,
        path: f.id,
        uri: f.uri,
        language: f.language,
        symbolCount: f.symbolCount,
        loc: f.loc,
        fileSummary: f.fileSummaryHeadline ?? '',
        kind: 'file',
        weight: f.symbolCount,
        parent: folderId(f.folder),
      },
      classes: f.fileSummaryHeadline ? 'has-summary file' : 'no-summary file',
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
        parent: 'folder:external',
      },
      classes: 'external',
    });
    // Edges from each importing file to the external are not separately tracked
    // in the current indexer payload, so we skip drawing them. The external
    // appears as a satellite node sized by usage.
  }

  for (const e of visibleEdges) {
    elements.push({
      data: {
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        weight: e.importCount,
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
        selector: 'node[kind = "file"]',
        style: {
          label: 'data(label)',
          'font-size': '11px',
          'text-wrap': 'wrap',
          'text-max-width': '180px',
          'text-valign': 'center',
          'text-halign': 'center',
          'background-color': 'var(--node-default)',
          color: 'var(--node-fg)',
          'border-width': 1,
          'border-color': 'var(--node-border)',
          width: 'mapData(weight, 0, 30, 60, 200)',
          height: 'mapData(weight, 0, 30, 28, 70)',
          padding: '6px',
          shape: 'round-rectangle',
        },
      },
      {
        selector: 'node.has-summary',
        style: { 'background-color': 'var(--node-summary)' },
      },
      {
        selector: 'node.no-summary',
        style: { 'background-color': 'var(--node-default)' },
      },
      {
        selector: 'node.external',
        style: {
          label: 'data(label)',
          'font-size': '10px',
          'background-color': 'var(--node-external)',
          color: 'var(--node-fg)',
          shape: 'ellipse',
          width: 'mapData(weight, 0, 20, 24, 60)',
          height: 'mapData(weight, 0, 20, 24, 60)',
        },
      },
      {
        selector: 'node.folder-group',
        style: {
          'background-color': 'var(--group-bg)',
          'border-color': 'var(--group-border)',
          'border-width': 1,
          'text-valign': 'top',
          'text-halign': 'center',
          'font-size': '10px',
          'font-weight': 'bold',
          color: 'var(--group-fg)',
          shape: 'round-rectangle',
          padding: '12px',
        },
      },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          width: 'mapData(weight, 1, 10, 1, 4)',
          'line-color': 'var(--edge)',
          'target-arrow-color': 'var(--edge)',
          'arrow-scale': 0.8,
        },
      },
      {
        selector: 'node:selected',
        style: { 'border-color': 'var(--selected)', 'border-width': 3 },
      },
    ],
  });

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    if (node.hasClass('folder-group')) return;
    const data = node.data();
    showDetail(data);
    if (data.kind === 'file' && data.uri) {
      vscodeApi.postMessage({ type: 'open', uri: data.uri });
    }
  });
  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    if (node.hasClass('folder-group')) return;
    showDetail(node.data());
  });

  applyFilter();
  runLayout();

  status.textContent = `${visibleFiles.length} of ${g.files.length} files · ${visibleEdges.length} imports · ${g.scannedFiles} scanned · ${g.durationMs}ms${capNote}`;
  status.classList.remove('error');
}

function showDetail(d: Record<string, unknown>): void {
  if (d.kind === 'external') {
    detail.innerHTML = `<strong>${escapeHtml(String(d.label))}</strong><div class="meta">external package · used ${d.usage} time(s)</div>`;
    return;
  }
  detail.innerHTML = `<strong>${escapeHtml(String(d.label))}</strong>
  <div class="meta">${escapeHtml(String(d.path ?? ''))}</div>
  <div class="meta">${escapeHtml(String(d.language ?? ''))} · ${d.symbolCount} symbols · ${d.loc} lines</div>
  ${d.fileSummary ? `<pre>${escapeHtml(String(d.fileSummary))}</pre>` : ''}
  <div class="meta">click to open</div>`;
}

function applyFilter(): void {
  if (!cy) return;
  const q = search.value.trim().toLowerCase();
  cy.batch(() => {
    cy!.nodes().forEach((n) => {
      if (n.hasClass('folder-group')) {
        n.style('display', 'element');
        return;
      }
      const data = n.data();
      const hay = `${data.label ?? ''} ${data.path ?? ''} ${data.fileSummary ?? ''}`.toLowerCase();
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
  if (count <= 150) return 'cose';
  if (count <= 600) return 'breadthfirst';
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
    base.nodeRepulsion = 4000;
    base.idealEdgeLength = 80;
    base.gravity = 0.25;
  }
  try {
    cy.layout(base as unknown as cytoscape.LayoutOptions).run();
  } catch (err) {
    status.textContent = `layout error: ${(err as Error).message}; falling back to grid`;
    cy.layout({ name: 'grid', fit: true, padding: 20 } as unknown as cytoscape.LayoutOptions).run();
  }
}

function folderId(folder: string): string {
  return `folder:${folder || '.'}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
