import * as vscode from 'vscode';
import { buildCallGraph } from './indexer';
import type { CallGraph } from './types';

interface ReadyMessage { type: 'ready' }
interface OpenMessage { type: 'open'; uri: string; pathKey: string }
interface RefreshMessage { type: 'refresh' }
type IncomingMessage = ReadyMessage | OpenMessage | RefreshMessage;

export class CallGraphPanel {
  private static current: CallGraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private indexCancel: vscode.CancellationTokenSource | undefined;
  private buildPromise: Promise<CallGraph> | undefined;

  static show(
    context: vscode.ExtensionContext,
    headlineFor: (pathKey: string) => string | undefined,
    output: vscode.OutputChannel,
  ): void {
    if (CallGraphPanel.current) {
      CallGraphPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      CallGraphPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'yaastCallGraph',
      'YAAST: Call Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    CallGraphPanel.current = new CallGraphPanel(panel, context, headlineFor, output);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly headlineFor: (pathKey: string) => string | undefined,
    private readonly output: vscode.OutputChannel,
  ) {
    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: IncomingMessage) => this.onMessage(m)),
    );
  }

  private dispose(): void {
    CallGraphPanel.current = undefined;
    this.indexCancel?.cancel();
    for (const d of this.disposables) d.dispose();
  }

  private async onMessage(msg: IncomingMessage): Promise<void> {
    if (msg.type === 'ready') {
      await this.refresh();
      return;
    }
    if (msg.type === 'refresh') {
      await this.refresh();
      return;
    }
    if (msg.type === 'open') {
      try {
        const uri = vscode.Uri.parse(msg.uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      } catch (err) {
        this.output.appendLine(`[graph open] ${(err as Error).message}`);
      }
    }
  }

  private async refresh(): Promise<void> {
    if (this.buildPromise) return; // already building
    this.indexCancel?.cancel();
    this.indexCancel = new vscode.CancellationTokenSource();
    const cancel = this.indexCancel.token;
    this.buildPromise = buildCallGraph(
      cancel,
      (p) => {
        this.panel.webview.postMessage({ type: 'progress', ...p });
      },
      this.headlineFor,
    );
    try {
      const graph = await this.buildPromise;
      this.panel.webview.postMessage({ type: 'callGraph', ...graph });
      this.output.appendLine(
        `[graph] ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.scannedFiles} files in ${graph.durationMs}ms`,
      );
    } catch (err) {
      const message = (err as Error).message;
      if (message !== 'cancelled') {
        this.panel.webview.postMessage({ type: 'error', message });
        this.output.appendLine(`[graph error] ${message}`);
      }
    } finally {
      this.buildPromise = undefined;
    }
  }

  private renderHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview-graph.js'),
    );
    const cspSource = this.panel.webview.cspSource;
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>YAAST Call Graph</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg-node: #2563eb;
      --bg-node-empty: #475569;
      --border-node: #1e40af;
      --fg-node: #ffffff;
      --bg-group: rgba(100,116,139,0.08);
      --border-group: #475569;
      --fg-group: #94a3b8;
      --edge: #64748b;
      --selected: #f59e0b;
    }
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    header input, header select, header button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    header input { flex: 1; }
    header button { cursor: pointer; }
    #status { font-size: 11px; opacity: 0.8; padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    #status.error { color: var(--vscode-errorForeground); }
    #content { flex: 1; display: flex; min-height: 0; }
    #graph { flex: 1; }
    #detail { width: 280px; border-left: 1px solid var(--vscode-panel-border); padding: 12px; overflow-y: auto; font-size: 12px; }
    #detail .meta { opacity: 0.7; font-size: 11px; margin-top: 4px; }
    #detail pre { font-size: 11px; overflow-x: auto; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); padding: 6px; border-radius: 4px; margin-top: 8px; }
  </style>
</head>
<body>
  <header>
    <input id="search" type="search" placeholder="filter by headline / name / file" />
    <select id="layout" title="Layout (auto picks based on node count)">
      <option value="auto">auto</option>
      <option value="cose">force</option>
      <option value="breadthfirst">tree</option>
      <option value="circle">circle</option>
      <option value="grid">grid</option>
    </select>
    <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
      <input id="hideOrphans" type="checkbox" checked /> hide unconnected
    </label>
    <button id="refresh">Refresh</button>
  </header>
  <div id="status">initializing…</div>
  <div id="content">
    <div id="graph"></div>
    <div id="detail">Click a node to see details and jump to source.</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
