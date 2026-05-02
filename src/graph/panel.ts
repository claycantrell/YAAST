import * as vscode from 'vscode';
import { buildRepoGraph, type RepoGraph } from './repoIndexer';
import { runClusterFlow, type ClusterFlowResult } from './clusterFlow';
import type { SummaryCache } from '../cache/summaryCache';

interface ReadyMessage { type: 'ready' }
interface OpenMessage { type: 'open'; uri: string }
interface RefreshMessage { type: 'refresh' }
interface ClusterMessage { type: 'cluster'; force?: boolean }
type IncomingMessage = ReadyMessage | OpenMessage | RefreshMessage | ClusterMessage;

export class CallGraphPanel {
  private static current: CallGraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private buildCancel: vscode.CancellationTokenSource | undefined;
  private clusterCancel: vscode.CancellationTokenSource | undefined;
  private buildPromise: Promise<RepoGraph> | undefined;
  private clusterPromise: Promise<ClusterFlowResult> | undefined;

  static show(deps: {
    context: vscode.ExtensionContext;
    fileHeadlineFor: (uri: string) => string | undefined;
    output: vscode.OutputChannel;
    cache: SummaryCache;
    resolveApiKey: () => Promise<string | undefined>;
  }): void {
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
        localResourceRoots: [vscode.Uri.joinPath(deps.context.extensionUri, 'dist')],
      },
    );
    CallGraphPanel.current = new CallGraphPanel(panel, deps);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: {
      context: vscode.ExtensionContext;
      fileHeadlineFor: (uri: string) => string | undefined;
      output: vscode.OutputChannel;
      cache: SummaryCache;
      resolveApiKey: () => Promise<string | undefined>;
    },
  ) {
    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: IncomingMessage) => this.onMessage(m)),
    );
  }

  private dispose(): void {
    CallGraphPanel.current = undefined;
    this.buildCancel?.cancel();
    this.clusterCancel?.cancel();
    for (const d of this.disposables) d.dispose();
  }

  private async onMessage(msg: IncomingMessage): Promise<void> {
    if (msg.type === 'ready' || msg.type === 'refresh') {
      await this.refresh();
      return;
    }
    if (msg.type === 'cluster') {
      await this.cluster(msg.force === true);
      return;
    }
    if (msg.type === 'open') {
      try {
        const uri = vscode.Uri.parse(msg.uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      } catch (err) {
        this.deps.output.appendLine(`[graph open] ${(err as Error).message}`);
      }
    }
  }

  private async refresh(): Promise<void> {
    if (this.buildPromise) return;
    this.buildCancel?.cancel();
    this.buildCancel = new vscode.CancellationTokenSource();
    const cancel = this.buildCancel.token;
    this.buildPromise = buildRepoGraph(
      cancel,
      (p) => this.panel.webview.postMessage({ type: 'progress', ...p }),
      this.deps.fileHeadlineFor,
    );
    try {
      const graph = await this.buildPromise;
      // Merge any cached cluster result that matches this graph.
      const cluster = this.findMatchingCluster(graph);
      this.panel.webview.postMessage({ type: 'repoGraph', ...graph, cluster });
      this.deps.output.appendLine(
        `[graph] ${graph.files.length} files, ${graph.edges.length} import edges, ${graph.externals.length} externals (${graph.durationMs}ms)`,
      );
    } catch (err) {
      const message = (err as Error).message;
      if (message !== 'cancelled') {
        this.panel.webview.postMessage({ type: 'error', message });
        this.deps.output.appendLine(`[graph error] ${message}`);
      }
    } finally {
      this.buildPromise = undefined;
    }
  }

  private async cluster(force: boolean): Promise<void> {
    if (this.clusterPromise) return;
    const apiKey = await this.deps.resolveApiKey();
    if (!apiKey) {
      this.panel.webview.postMessage({
        type: 'error',
        message: 'No Anthropic API key set. Run "Set Anthropic API Key" first.',
      });
      return;
    }

    this.clusterCancel?.cancel();
    this.clusterCancel = new vscode.CancellationTokenSource();
    const cancel = this.clusterCancel.token;
    const cfg = vscode.workspace.getConfiguration('semanticFoldMode');
    const model = cfg.get<string>('cloud.model', 'claude-haiku-4-5');

    this.clusterPromise = runClusterFlow({
      cache: this.deps.cache,
      apiKey,
      model,
      output: this.deps.output,
      cancel,
      forceRefresh: force,
      onProgress: (p) =>
        this.panel.webview.postMessage({ type: 'progress', step: p.step, scanned: p.scanned, total: p.total, message: p.message }),
    });

    try {
      const result = await this.clusterPromise;
      this.panel.webview.postMessage({
        type: 'cluster',
        record: result.record,
        cached: result.cached,
        runInfo: result.runInfo,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message !== 'cancelled') {
        this.panel.webview.postMessage({ type: 'error', message });
        this.deps.output.appendLine(`[cluster error] ${message}`);
      }
    } finally {
      this.clusterPromise = undefined;
    }
  }

  private findMatchingCluster(_graph: RepoGraph) {
    // Reserved for a future fast-path that surfaces a cached cluster on first
    // render; today the cluster button is the explicit trigger.
    return undefined;
  }

  private renderHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'webview-graph.js'),
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
    :root { color-scheme: dark light; }
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
    header input, header select, header button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    header input { flex: 1; min-width: 200px; }
    header label { display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer; }
    header button { cursor: pointer; }
    header button.primary { background: #16a34a; color: white; border-color: #15803d; font-weight: 600; }
    header button.primary:hover { background: #15803d; }
    #status { font-size: 11px; opacity: 0.8; padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    #status.error { color: var(--vscode-errorForeground); }
    #content { flex: 1; display: flex; min-height: 0; }
    #graph { flex: 1; }
    #detail { width: 300px; border-left: 1px solid var(--vscode-panel-border); padding: 12px; overflow-y: auto; font-size: 12px; }
    #detail .meta { opacity: 0.7; font-size: 11px; margin-top: 4px; word-break: break-all; }
    #detail pre { font-size: 11px; overflow-x: auto; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); padding: 6px; border-radius: 4px; margin-top: 8px; white-space: pre-wrap; }
    #detail .file-list { margin-top: 8px; }
    #detail .file-list .file { padding: 2px 0; cursor: pointer; opacity: 0.85; }
    #detail .file-list .file:hover { opacity: 1; text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <input id="search" type="search" placeholder="filter by name / file / cluster" />
    <select id="mode" title="View mode">
      <option value="cluster">cluster</option>
      <option value="folder">folder</option>
    </select>
    <select id="depth" title="Folder aggregation depth (folder mode)">
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
    <button id="cluster" class="primary">✨ Cluster repo</button>
    <button id="clusterRefresh" title="Force re-cluster (~$0.07)">↻</button>
    <button id="refresh">Rescan files</button>
  </header>
  <div id="status">initializing…</div>
  <div id="content">
    <div id="graph"></div>
    <div id="detail">Click a node to inspect.</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
