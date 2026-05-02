import * as vscode from 'vscode';
import { buildRepoGraph, type RepoGraph } from './repoIndexer';

interface ReadyMessage { type: 'ready' }
interface OpenMessage { type: 'open'; uri: string }
interface RefreshMessage { type: 'refresh' }
type IncomingMessage = ReadyMessage | OpenMessage | RefreshMessage;

export class CallGraphPanel {
  private static current: CallGraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private indexCancel: vscode.CancellationTokenSource | undefined;
  private buildPromise: Promise<RepoGraph> | undefined;

  static show(
    context: vscode.ExtensionContext,
    fileHeadlineFor: (uri: string) => string | undefined,
    output: vscode.OutputChannel,
  ): void {
    if (CallGraphPanel.current) {
      CallGraphPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      CallGraphPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'yaastRepoGraph',
      'YAAST: Repo Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    CallGraphPanel.current = new CallGraphPanel(panel, context, fileHeadlineFor, output);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly fileHeadlineFor: (uri: string) => string | undefined,
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
    if (msg.type === 'ready' || msg.type === 'refresh') {
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
    if (this.buildPromise) return;
    this.indexCancel?.cancel();
    this.indexCancel = new vscode.CancellationTokenSource();
    const cancel = this.indexCancel.token;
    this.buildPromise = buildRepoGraph(
      cancel,
      (p) => this.panel.webview.postMessage({ type: 'progress', ...p }),
      this.fileHeadlineFor,
    );
    try {
      const graph = await this.buildPromise;
      this.panel.webview.postMessage({ type: 'repoGraph', ...graph });
      this.output.appendLine(
        `[graph] ${graph.files.length} files, ${graph.edges.length} import edges, ${graph.externals.length} external packages, ${graph.unresolvedImports} unresolved (${graph.durationMs}ms)`,
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
        content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};" />
  <title>YAAST Repo Graph</title>
  <style>
    :root {
      color-scheme: dark light;
      --node-default: #2563eb;
      --node-summary: #16a34a;
      --node-external: #6366f1;
      --node-border: #1e40af;
      --node-fg: #ffffff;
      --group-bg: rgba(100,116,139,0.08);
      --group-border: #475569;
      --group-fg: #94a3b8;
      --edge: #64748b;
      --edge-strong: #94a3b8;
      --selected: #f59e0b;
    }
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
    header input, header select, header button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    header input { flex: 1; min-width: 200px; }
    header label { display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer; }
    header button { cursor: pointer; }
    #status { font-size: 11px; opacity: 0.8; padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    #status.error { color: var(--vscode-errorForeground); }
    #content { flex: 1; display: flex; min-height: 0; }
    #graph { flex: 1; }
    #detail { width: 300px; border-left: 1px solid var(--vscode-panel-border); padding: 12px; overflow-y: auto; font-size: 12px; }
    #detail .meta { opacity: 0.7; font-size: 11px; margin-top: 4px; word-break: break-all; }
    #detail pre { font-size: 11px; overflow-x: auto; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); padding: 6px; border-radius: 4px; margin-top: 8px; }
  </style>
</head>
<body>
  <header>
    <input id="search" type="search" placeholder="filter by path / headline" />
    <select id="depth" title="Aggregation depth (folders deep)">
      <option value="1">depth 1</option>
      <option value="2" selected>depth 2</option>
      <option value="3">depth 3</option>
      <option value="4">depth 4</option>
      <option value="files">files</option>
    </select>
    <select id="layout" title="Layout">
      <option value="auto">auto</option>
      <option value="cose">force</option>
      <option value="breadthfirst">tree</option>
      <option value="circle">circle</option>
      <option value="grid">grid</option>
    </select>
    <label><input id="hideOrphans" type="checkbox" checked /> hide unconnected</label>
    <label><input id="hideIntra" type="checkbox" checked /> only inter-folder edges</label>
    <label><input id="showExternals" type="checkbox" /> external packages</label>
    <button id="refresh">Refresh</button>
  </header>
  <div id="status">initializing…</div>
  <div id="content">
    <div id="graph"></div>
    <div id="detail">Click a file to jump to source.</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
