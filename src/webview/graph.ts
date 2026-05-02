// Webview-side bundle. Loaded into a vscode.WebviewPanel.
// Receives the call-graph payload from the extension via postMessage,
// renders with Cytoscape, and posts back navigation/hover events.

import cytoscape, { type ElementDefinition } from 'cytoscape';

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscodeApi = acquireVsCodeApi();

interface IncomingNode {
  id: string;
  uri: string;
  filePath: string;
  name: string;
  kind: number;
  headline?: string;
  signature?: string;
}
interface IncomingEdge {
  source: string;
  target: string;
  count: number;
}
interface CallGraphPayload {
  type: 'callGraph';
  nodes: IncomingNode[];
  edges: IncomingEdge[];
  scannedFiles: number;
  durationMs: number;
}
interface ProgressPayload {
  type: 'progress';
  step: string;
  scanned: number;
  total: number;
  message?: string;
}
interface ErrorPayload {
  type: 'error';
  message: string;
}
type Incoming = CallGraphPayload | ProgressPayload | ErrorPayload;

const status = document.getElementById('status') as HTMLDivElement;
const search = document.getElementById('search') as HTMLInputElement;
const layoutSelect = document.getElementById('layout') as HTMLSelectElement;
const detail = document.getElementById('detail') as HTMLDivElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;

let cy: cytoscape.Core | undefined;

refreshBtn.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'refresh' });
});

search.addEventListener('input', () => {
  if (!cy) return;
  const q = search.value.trim().toLowerCase();
  cy.batch(() => {
    cy!.nodes().forEach((n) => {
      const data = n.data();
      const hay = `${data.label ?? ''} ${data.name ?? ''} ${data.filePath ?? ''}`.toLowerCase();
      const hit = q.length === 0 || hay.includes(q);
      n.style('display', hit ? 'element' : 'none');
    });
    cy!.edges().forEach((e) => {
      const visible =
        e.source().style('display') !== 'none' && e.target().style('display') !== 'none';
      e.style('display', visible ? 'element' : 'none');
    });
  });
});

layoutSelect.addEventListener('change', () => runLayout());

window.addEventListener('message', (ev) => {
  const msg = ev.data as Incoming;
  if (msg.type === 'progress') {
    status.textContent = `${msg.step}: ${msg.scanned}/${msg.total}${msg.message ? ` — ${msg.message}` : ''}`;
    return;
  }
  if (msg.type === 'error') {
    status.textContent = `error: ${msg.message}`;
    status.classList.add('error');
    return;
  }
  if (msg.type === 'callGraph') {
    status.textContent = `${msg.nodes.length} symbols, ${msg.edges.length} edges, ${msg.scannedFiles} files (${msg.durationMs}ms)`;
    renderGraph(msg.nodes, msg.edges);
  }
});

vscodeApi.postMessage({ type: 'ready' });

function renderGraph(nodes: IncomingNode[], edges: IncomingEdge[]) {
  const elements: ElementDefinition[] = [];
  const fileGroups = new Set<string>();
  for (const n of nodes) {
    fileGroups.add(n.filePath);
  }
  for (const f of fileGroups) {
    elements.push({ data: { id: `file:${f}`, label: f, filePath: f }, classes: 'file-group' });
  }
  for (const n of nodes) {
    elements.push({
      data: {
        id: n.id,
        label: n.headline ?? n.name,
        name: n.name,
        kind: n.kind,
        uri: n.uri,
        filePath: n.filePath,
        signature: n.signature ?? '',
        hasSummary: n.headline ? 'yes' : 'no',
        parent: `file:${n.filePath}`,
      },
      classes: n.headline ? 'has-summary' : 'no-summary',
    });
  }
  for (const e of edges) {
    elements.push({
      data: { id: `${e.source}->${e.target}`, source: e.source, target: e.target, count: e.count },
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
          'font-size': '11px',
          'text-wrap': 'wrap',
          'text-max-width': '200px',
          'text-valign': 'center',
          'text-halign': 'center',
          'background-color': 'var(--bg-node, #2563eb)',
          color: 'var(--fg-node, #fff)',
          'border-width': 1,
          'border-color': 'var(--border-node, #1e40af)',
          width: 'label',
          height: 'label',
          padding: '8px',
          shape: 'round-rectangle',
        },
      },
      {
        selector: 'node.no-summary',
        style: {
          'background-color': 'var(--bg-node-empty, #475569)',
          'font-style': 'italic',
        },
      },
      {
        selector: 'node.file-group',
        style: {
          'background-color': 'var(--bg-group, rgba(100,116,139,0.08))',
          'border-color': 'var(--border-group, #475569)',
          'border-width': 1,
          'text-valign': 'top',
          'text-halign': 'center',
          'font-size': '10px',
          'font-weight': 'bold',
          color: 'var(--fg-group, #94a3b8)',
          shape: 'round-rectangle',
          padding: '12px',
        },
      },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          width: 1.5,
          'line-color': 'var(--edge, #64748b)',
          'target-arrow-color': 'var(--edge, #64748b)',
          'arrow-scale': 0.8,
        },
      },
      {
        selector: 'node:selected',
        style: { 'border-color': 'var(--selected, #f59e0b)', 'border-width': 3 },
      },
    ],
  });

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    if (node.hasClass('file-group')) return;
    const data = node.data();
    detail.innerHTML = `<strong>${escapeHtml(data.label)}</strong><div class="meta">${escapeHtml(data.filePath)} · ${escapeHtml(data.name)}</div>${data.signature ? `<pre>${escapeHtml(data.signature)}</pre>` : ''}`;
    vscodeApi.postMessage({ type: 'open', uri: data.uri, pathKey: data.id });
  });

  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    if (node.hasClass('file-group')) return;
    const data = node.data();
    detail.innerHTML = `<strong>${escapeHtml(data.label)}</strong><div class="meta">${escapeHtml(data.filePath)} · ${escapeHtml(data.name)}</div>${data.signature ? `<pre>${escapeHtml(data.signature)}</pre>` : ''}`;
  });

  runLayout();
}

function runLayout() {
  if (!cy) return;
  const name = layoutSelect.value as 'cose' | 'breadthfirst' | 'circle';
  const opts = { name, animate: false, fit: true, padding: 20 } as unknown as cytoscape.LayoutOptions;
  cy.layout(opts).run();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
