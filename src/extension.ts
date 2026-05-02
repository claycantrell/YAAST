import * as vscode from 'vscode';
import { collectDrawerTargets, type DrawerTarget } from './extraction/symbols';
import { applyVirtualHeaders, headerDecorationType } from './rendering/decorations';
import { SummaryProviderRegistry } from './providers/registry';
import type { SummaryJson } from './providers/types';
import { SummaryCache } from './cache/summaryCache';
import { CloudProvider } from './providers/cloud';

const PROMPT_VERSION = 'v1';
const SCHEMA_VERSION = 'v1';

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let registry: SummaryProviderRegistry;
let cache: SummaryCache;
let enabled = true;
const targetsByEditor = new WeakMap<vscode.TextEditor, DrawerTarget[]>();
const summaryByCacheKey = new Map<string, SummaryJson>();
const pendingByCacheKey = new Set<string>();
const autoFoldedDocs = new WeakSet<vscode.TextDocument>();

class TaskQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  constructor(private readonly maxConcurrent: number) {}
  add(task: () => Promise<void>): void {
    this.queue.push(task);
    this.run();
  }
  private run(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running++;
      task().finally(() => {
        this.running--;
        this.run();
      });
    }
  }
}

let summaryQueue: TaskQueue;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Semantic Fold Mode');
  context.subscriptions.push(output);
  output.appendLine('[activate] Semantic Fold Mode activated');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'semanticFoldMode.toggle';
  context.subscriptions.push(statusBar);

  registry = new SummaryProviderRegistry(context, output);
  cache = new SummaryCache(context);

  const cfg = vscode.workspace.getConfiguration('semanticFoldMode');
  enabled = cfg.get('enabled', true);
  summaryQueue = new TaskQueue(cfg.get<number>('concurrency', 3));
  updateStatusBar(0);

  context.subscriptions.push(
    vscode.commands.registerCommand('semanticFoldMode.toggle', async () => {
      enabled = !enabled;
      await vscode.workspace.getConfiguration('semanticFoldMode').update('enabled', enabled, true);
      vscode.window.showInformationMessage(`Semantic Fold Mode: ${enabled ? 'on' : 'off'}`);
      await refreshAllVisibleEditors();
    }),
    vscode.commands.registerCommand('semanticFoldMode.regenerate', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const targets = targetsByEditor.get(editor) ?? [];
      const cursorLine = editor.selection.active.line;
      const target =
        targets.find(
          (t) => t.fullRange.start.line <= cursorLine && t.fullRange.end.line >= cursorLine,
        ) ?? targets[0];
      if (!target) return;
      const id = identityFor(editor.document, target);
      summaryByCacheKey.delete(id.cacheKey);
      enqueueSummary(editor, target);
    }),
    vscode.commands.registerCommand('semanticFoldMode.promoteToComment', async () => {
      output.appendLine('[command] promoteToComment (stub)');
    }),
    vscode.commands.registerCommand('semanticFoldMode.clearCache', async () => {
      await cache.clear();
      summaryByCacheKey.clear();
      vscode.window.showInformationMessage('Semantic Fold Mode: cache cleared');
      await refreshAllVisibleEditors();
    }),
    vscode.commands.registerCommand('semanticFoldMode.foldAll', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await foldDrawers(editor);
    }),
    vscode.commands.registerCommand('semanticFoldMode.unfoldAll', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await unfoldDrawers(editor);
    }),
    vscode.commands.registerCommand('semanticFoldMode.setApiKey', async () => {
      await CloudProvider.setApiKey(context);
      await refreshAllVisibleEditors();
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) refreshEditor(ed);
    }),
    vscode.window.onDidChangeVisibleTextEditors((eds) => {
      for (const ed of eds) refreshEditor(ed);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc);
      if (ed) refreshEditor(ed);
    }),
    vscode.workspace.onDidChangeTextDocument((evt) => {
      const ed = vscode.window.visibleTextEditors.find((e) => e.document === evt.document);
      if (ed) refreshEditor(ed);
    }),
    vscode.workspace.onDidChangeConfiguration((evt) => {
      if (evt.affectsConfiguration('semanticFoldMode.enabled')) {
        enabled = vscode.workspace.getConfiguration('semanticFoldMode').get('enabled', true);
        refreshAllVisibleEditors();
      }
    }),
    headerDecorationType,
  );

  setTimeout(() => refreshAllVisibleEditors(), 500);
  setTimeout(() => refreshAllVisibleEditors(), 2000);

  // First-run nudge if no API key and provider is cloud.
  setTimeout(async () => {
    const provider = registry.active();
    if (provider.id === 'cloud' && !(await provider.isAvailable())) {
      const choice = await vscode.window.showInformationMessage(
        'Semantic Fold Mode: set your Anthropic API key to enable AI summaries.',
        'Set API Key',
        'Dismiss',
      );
      if (choice === 'Set API Key') {
        await vscode.commands.executeCommand('semanticFoldMode.setApiKey');
      }
    }
  }, 2500);
}

async function refreshAllVisibleEditors() {
  for (const ed of vscode.window.visibleTextEditors) {
    await refreshEditor(ed);
  }
}

async function refreshEditor(editor: vscode.TextEditor) {
  if (!enabled) {
    applyVirtualHeaders(editor, []);
    updateStatusBar(0);
    return;
  }

  try {
    const cfg = vscode.workspace.getConfiguration('semanticFoldMode');
    const includeKinds = new Set(cfg.get<string[]>('includeKinds', ['Function', 'Method', 'Class']));
    const all = await collectDrawerTargets(editor.document);
    const targets = all.filter((t) => includeKinds.has(vscode.SymbolKind[t.kind]));
    output.appendLine(
      `[refresh] ${editor.document.uri.fsPath} (${editor.document.languageId}): ${targets.length}/${all.length} targets`,
    );
    targetsByEditor.set(editor, targets);
    renderHeaders(editor);

    if (
      targets.length > 0 &&
      cfg.get<boolean>('autoFoldOnOpen', true) &&
      !autoFoldedDocs.has(editor.document)
    ) {
      autoFoldedDocs.add(editor.document);
      await foldDrawers(editor);
    }

    for (const t of targets) {
      const id = identityFor(editor.document, t);
      if (summaryByCacheKey.has(id.cacheKey)) continue;
      const persisted = cache.get(id.cacheKey);
      if (persisted) {
        summaryByCacheKey.set(id.cacheKey, persisted.summary);
        continue;
      }
      enqueueSummary(editor, t);
    }
  } catch (err) {
    output.appendLine(`[refresh error] ${(err as Error).message}`);
  }
}

function renderHeaders(editor: vscode.TextEditor): void {
  const targets = targetsByEditor.get(editor) ?? [];
  const items = targets.map((t) => {
    const summary = lookupSummary(editor.document, t);
    return {
      line: t.selectionRange.start.line,
      text: summary?.headline ?? deterministicHeader(t.name, t.kind),
      hover: buildHoverMarkdown(t, summary),
    };
  });
  applyVirtualHeaders(editor, items);
  updateStatusBar(targets.length);
}

function lookupSummary(doc: vscode.TextDocument, target: DrawerTarget): SummaryJson | undefined {
  const id = identityFor(doc, target);
  return summaryByCacheKey.get(id.cacheKey);
}

function identityFor(doc: vscode.TextDocument, target: DrawerTarget) {
  const slice = doc.getText(target.fullRange);
  const provider = registry.active();
  return cache.identity({
    sourceSlice: slice,
    semanticSlice: slice,
    providerId: provider.id,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    settingsProfile: 'default',
  });
}

function enqueueSummary(editor: vscode.TextEditor, target: DrawerTarget): void {
  const id = identityFor(editor.document, target);
  if (pendingByCacheKey.has(id.cacheKey)) return;
  pendingByCacheKey.add(id.cacheKey);

  summaryQueue.add(async () => {
    const provider = registry.active();
    if (!(await provider.isAvailable())) {
      pendingByCacheKey.delete(id.cacheKey);
      return;
    }
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const slice = editor.document.getText(target.fullRange);
      const signature = firstNonEmptyLine(slice);
      const start = Date.now();
      const summary = await provider.summarize(
        {
          languageId: editor.document.languageId,
          symbolKind: vscode.SymbolKind[target.kind],
          symbolPath: [target.name],
          signature,
          truncated: false,
          codeSlice: slice,
        },
        tokenSource.token,
      );
      const latency = Date.now() - start;
      summaryByCacheKey.set(id.cacheKey, summary);
      cache.set({
        cacheKey: id.cacheKey,
        targetId: target.id,
        semanticHash: id.semanticHash,
        sourceHash: id.sourceHash,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        providerId: provider.id,
        summary,
        generatedAt: new Date().toISOString(),
        latencyMs: latency,
      });
      renderHeaders(editor);
    } catch (err) {
      output.appendLine(`[summary error] ${target.name}: ${(err as Error).message}`);
    } finally {
      tokenSource.dispose();
      pendingByCacheKey.delete(id.cacheKey);
    }
  });
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 200);
  }
  return '';
}

function buildHoverMarkdown(target: DrawerTarget, summary: SummaryJson | undefined): string {
  if (!summary) {
    return `**${target.name}** — ${vscode.SymbolKind[target.kind]}\n\n_AI summary not yet generated._`;
  }
  const lines = [`**${summary.headline}**`, '', summary.purpose];
  if (summary.methods_used.length) lines.push('', `**Methods used:** ${summary.methods_used.join(', ')}`);
  if (summary.techniques.length) lines.push(`**Techniques:** ${summary.techniques.join(', ')}`);
  if (summary.risks.length) lines.push(`**Risks:** ${summary.risks.join(', ')}`);
  lines.push('', `_Confidence: ${summary.confidence}_`);
  return lines.join('\n');
}

async function foldDrawers(editor: vscode.TextEditor): Promise<void> {
  const targets = targetsByEditor.get(editor);
  if (!targets || targets.length === 0) return;
  if (vscode.window.activeTextEditor !== editor) {
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }
  const selectionLines = targets.map((t) => t.fold.start);
  await vscode.commands.executeCommand('editor.fold', { selectionLines });
  output.appendLine(`[fold] folded ${selectionLines.length} drawers`);
}

async function unfoldDrawers(editor: vscode.TextEditor): Promise<void> {
  if (vscode.window.activeTextEditor !== editor) {
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }
  await vscode.commands.executeCommand('editor.unfoldAll');
  output.appendLine('[fold] unfoldAll executed');
}

function deterministicHeader(name: string, kind: vscode.SymbolKind): string {
  return `${vscode.SymbolKind[kind].toLowerCase()} ${name}`;
}

function updateStatusBar(count: number): void {
  if (!statusBar) return;
  statusBar.text = enabled ? `$(symbol-method) Fold: ${count}` : '$(circle-slash) Fold: off';
  statusBar.tooltip = 'Semantic Fold Mode — click to toggle';
  statusBar.show();
}

export function deactivate() {
  output?.dispose();
  statusBar?.dispose();
}
