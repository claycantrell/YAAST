import * as vscode from 'vscode';
import { collectDrawerTargets, type DrawerTarget } from './extraction/symbols';
import {
  applyFileBanner,
  applyVirtualHeaders,
  fileBannerDecorationType,
  headerDecorationType,
} from './rendering/decorations';
import { SummaryProviderRegistry } from './providers/registry';
import type { FileSummaryJson, SummaryJson } from './providers/types';
import { SummaryCache, type CacheIdentity } from './cache/summaryCache';
import { CloudProvider } from './providers/cloud';

const PROMPT_VERSION = 'v1';
const SCHEMA_VERSION = 'v1';

interface SummaryLookup {
  summary: SummaryJson;
  stale: boolean;
}

interface FileSummaryLookup {
  summary: FileSummaryJson;
  stale: boolean;
}

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let registry: SummaryProviderRegistry;
let cache: SummaryCache;
let lensProvider: RegenerateCodeLensProvider;
let enabled = true;
const targetsByEditor = new WeakMap<vscode.TextEditor, DrawerTarget[]>();
const pendingByCacheKey = new Set<string>();
const fileSummaryPending = new Set<string>();
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

class RegenerateCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  refresh(): void {
    this.emitter.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    if (!editor || !enabled) return [];
    const targets = targetsByEditor.get(editor) ?? [];
    const lenses: vscode.CodeLens[] = [];

    // Top-of-file aggregate lens: only show if at least one target needs work.
    let missing = 0;
    let stale = 0;
    for (const t of targets) {
      const lookup = lookupSummary(doc, t);
      if (!lookup) missing++;
      else if (lookup.stale) stale++;
    }
    const fileLookup = lookupFileSummary(doc, targets);
    const filePending = fileSummaryPending.has(doc.uri.toString());
    const fileNeedsWork = !fileLookup || fileLookup.stale || filePending;

    if ((missing + stale > 0 || fileNeedsWork) && doc.lineCount > 0) {
      const headerRange = new vscode.Range(0, 0, 0, 0);
      const parts: string[] = [];
      if (filePending) parts.push('generating file summary');
      else if (!fileLookup) parts.push('file summary');
      else if (fileLookup.stale) parts.push('1 out-of-date file summary');
      if (missing > 0) parts.push(`${missing} new symbol summar${missing === 1 ? 'y' : 'ies'}`);
      if (stale > 0) parts.push(`${stale} out-of-date symbol summar${stale === 1 ? 'y' : 'ies'}`);
      const icon = stale > 0 || (fileLookup && fileLookup.stale) ? '$(refresh)' : '$(sparkle)';
      const headerTitle = `${icon} Semantic Fold: ${parts.join(' · ')}`;
      lenses.push(
        new vscode.CodeLens(headerRange, {
          title: headerTitle,
          command: 'semanticFoldMode.generateForFile',
          arguments: [doc.uri.toString()],
        }),
      );
    }

    for (const t of targets) {
      const lookup = lookupSummary(doc, t);
      const id = identityFor(doc, t);
      const pending = pendingByCacheKey.has(id.cacheKey);
      // Fresh, non-pending symbols don't get a CodeLens — keeps the editor uncluttered.
      // Regenerate is still available from the hover card.
      if (lookup && !lookup.stale && !pending) continue;
      const range = new vscode.Range(t.selectionRange.start.line, 0, t.selectionRange.start.line, 0);
      let title: string;
      if (pending) {
        title = '$(sync~spin) Generating…';
      } else if (!lookup) {
        title = '$(sparkle) Generate summary';
      } else {
        title = '$(warning) Out of date · Regenerate';
      }
      lenses.push(
        new vscode.CodeLens(range, {
          title,
          command: 'semanticFoldMode.regenerateUnitAt',
          arguments: [doc.uri.toString(), t.selectionRange.start.line],
        }),
      );
    }
    return lenses;
  }
}

class SemanticFoldHoverProvider implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!enabled) return undefined;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    if (!editor) return undefined;
    const targets = targetsByEditor.get(editor) ?? [];

    // 1) Line 0 → file summary banner.
    if (position.line === 0) {
      const lookup = lookupFileSummary(doc, targets);
      if (lookup) {
        const md = new vscode.MarkdownString(buildFileHoverMarkdown(doc, lookup));
        md.isTrusted = { enabledCommands: ['semanticFoldMode.regenerateFileSummary'] };
        md.supportThemeIcons = true;
        return new vscode.Hover(md);
      }
    }

    // 2) Find the most-specific (smallest fullRange) target whose fullRange contains
    //    the cursor position. Smaller wins so a method's hover beats its enclosing class.
    let best: DrawerTarget | undefined;
    let bestSize = Number.POSITIVE_INFINITY;
    for (const t of targets) {
      if (!t.fullRange.contains(position)) continue;
      const size = (t.fullRange.end.line - t.fullRange.start.line) * 10000 + t.fullRange.end.character;
      if (size < bestSize) {
        bestSize = size;
        best = t;
      }
    }
    if (!best) return undefined;

    const lookup = lookupSummary(doc, best);
    const md = new vscode.MarkdownString(buildHoverMarkdown(best, lookup));
    md.isTrusted = { enabledCommands: ['semanticFoldMode.regenerateUnitAt'] };
    md.supportThemeIcons = true;
    return new vscode.Hover(md);
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
  const { loaded, filesLoaded } = await cache.init();
  output.appendLine(`[cache] loaded ${loaded} symbol summaries + ${filesLoaded} file summaries`);

  lensProvider = new RegenerateCodeLensProvider();
  const hoverProvider = new SemanticFoldHoverProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider),
    vscode.languages.registerCodeLensProvider({ scheme: 'untitled' }, lensProvider),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
    vscode.languages.registerHoverProvider({ scheme: 'untitled' }, hoverProvider),
    fileBannerDecorationType,
  );

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
      // Regenerate the unit under the cursor in the active editor.
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const target = targetAtLine(editor, editor.selection.active.line);
      if (!target) {
        vscode.window.showInformationMessage('No drawer target at cursor.');
        return;
      }
      enqueueSummary(editor, target, true);
    }),
    vscode.commands.registerCommand(
      'semanticFoldMode.regenerateUnitAt',
      async (uriStr: string, line: number) => {
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === uriStr,
        );
        if (!editor) return;
        const target = targetAtLine(editor, line);
        if (!target) return;
        enqueueSummary(editor, target, true);
      },
    ),
    vscode.commands.registerCommand('semanticFoldMode.regeneratePage', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await generateForFile(editor, { onlyStale: true });
    }),
    vscode.commands.registerCommand(
      'semanticFoldMode.generateForFile',
      async (uriStr?: string) => {
        let editor = vscode.window.activeTextEditor;
        if (uriStr) {
          editor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uriStr,
          );
        }
        if (!editor) return;
        await generateForFile(editor, { onlyStale: false });
      },
    ),
    vscode.commands.registerCommand(
      'semanticFoldMode.regenerateFileSummary',
      async (uriStr?: string) => {
        let editor = vscode.window.activeTextEditor;
        if (uriStr) {
          editor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uriStr,
          );
        }
        if (!editor) return;
        await generateFileSummary(editor, true);
      },
    ),
    vscode.commands.registerCommand('semanticFoldMode.promoteToComment', async () => {
      output.appendLine('[command] promoteToComment (stub)');
    }),
    vscode.commands.registerCommand('semanticFoldMode.clearCache', async () => {
      await cache.clear();
      vscode.window.showInformationMessage('Semantic Fold Mode: cache cleared');
      lensProvider.refresh();
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

  setTimeout(async () => {
    const provider = registry.active();
    if (provider.id !== 'cloud') return;
    if (await provider.isAvailable()) return;
    const choice = await vscode.window.showInformationMessage(
      'Semantic Fold Mode needs an Anthropic API key to generate AI summaries.',
      'Set API Key',
      'Use static headers (no AI)',
      'Dismiss',
    );
    if (choice === 'Set API Key') {
      await vscode.commands.executeCommand('semanticFoldMode.setApiKey');
    } else if (choice === 'Use static headers (no AI)') {
      await vscode.workspace
        .getConfiguration('semanticFoldMode')
        .update('provider', 'static', vscode.ConfigurationTarget.Global);
    }
  }, 1500);
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
    lensProvider?.refresh();
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
    lensProvider?.refresh();

    if (
      targets.length > 0 &&
      cfg.get<boolean>('autoFoldOnOpen', true) &&
      !autoFoldedDocs.has(editor.document)
    ) {
      autoFoldedDocs.add(editor.document);
      await foldDrawers(editor);
    }

    // No auto-generation. The user explicitly clicks the top-of-file CodeLens
    // ("Generate summaries for this file") or per-symbol CodeLens to summarize.
  } catch (err) {
    output.appendLine(`[refresh error] ${(err as Error).message}`);
  }
}

function renderHeaders(editor: vscode.TextEditor): void {
  const targets = targetsByEditor.get(editor) ?? [];
  const items = targets.map((t) => {
    const lookup = lookupSummary(editor.document, t);
    let text: string;
    if (!lookup) {
      text = deterministicHeader(t.name, t.kind);
    } else if (lookup.stale) {
      text = `⚠ ${lookup.summary.headline}`;
    } else {
      text = lookup.summary.headline;
    }
    return {
      line: t.selectionRange.start.line,
      text,
      hover: buildHoverMarkdown(t, lookup),
    };
  });
  applyVirtualHeaders(editor, items);
  renderFileBanner(editor);
  updateStatusBar(targets.length);
}

function renderFileBanner(editor: vscode.TextEditor): void {
  const targets = targetsByEditor.get(editor) ?? [];
  const lookup = lookupFileSummary(editor.document, targets);
  if (!lookup) {
    applyFileBanner(editor, undefined);
    return;
  }
  const headline = lookup.stale ? `⚠ ${lookup.summary.headline}` : lookup.summary.headline;
  applyFileBanner(editor, {
    text: headline,
    hover: buildFileHoverMarkdown(editor.document, lookup),
  });
}

function fileSkeleton(doc: vscode.TextDocument, targets: DrawerTarget[]): string {
  // Top-level symbols only (path length 1); list each plus its direct children's
  // declaration lines. Stable across method-body edits, changes when the file's
  // structure (top-level symbols, signatures, child layout) changes.
  const topLevel = targets.filter((t) => t.symbolPath.length === 1);
  const lines: string[] = [`path:${doc.uri.toString()}`, `lang:${doc.languageId}`];
  for (const t of topLevel) {
    lines.push(`${vscode.SymbolKind[t.kind]}::${t.name}::${lineSafely(doc, t.selectionRange.start.line)}`);
    for (const c of t.directChildren) {
      lines.push(`  ${vscode.SymbolKind[c.kind]}::${c.name}::${lineSafely(doc, c.selectionRange.start.line)}`);
    }
  }
  return lines.join('\n');
}

function fileIdentityFor(doc: vscode.TextDocument, targets: DrawerTarget[]) {
  const provider = registry.active();
  return cache.fileIdentity({
    skeleton: fileSkeleton(doc, targets),
    providerId: provider.id,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    settingsProfile: 'default',
  });
}

function lookupFileSummary(
  doc: vscode.TextDocument,
  targets: DrawerTarget[],
): FileSummaryLookup | undefined {
  const record = cache.getFileByUri(doc.uri.toString());
  if (!record) return undefined;
  const id = fileIdentityFor(doc, targets);
  return { summary: record.summary, stale: record.skeletonHash !== id.skeletonHash };
}

function lookupSummary(doc: vscode.TextDocument, target: DrawerTarget): SummaryLookup | undefined {
  const id = identityFor(doc, target);
  const fresh = cache.getByCacheKey(id.cacheKey);
  if (fresh) return { summary: fresh.summary, stale: false };
  const stale = cache.getByPathKey(target.pathKey);
  if (stale) return { summary: stale.summary, stale: true };
  return undefined;
}

const CONTAINER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Object,
]);

function identityFor(doc: vscode.TextDocument, target: DrawerTarget): CacheIdentity {
  const sourceSlice = doc.getText(target.fullRange);
  const semanticSlice = computeSemanticSlice(doc, target, sourceSlice);
  const provider = registry.active();
  return cache.identity({
    sourceSlice,
    semanticSlice,
    providerId: provider.id,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    settingsProfile: 'default',
  });
}

function computeSemanticSlice(
  doc: vscode.TextDocument,
  target: DrawerTarget,
  sourceSlice: string,
): string {
  if (!CONTAINER_KINDS.has(target.kind) || target.directChildren.length === 0) {
    return sourceSlice;
  }
  // Container hash invariant to child bodies: declaration line + each child's
  // declaration line. Editing a method body leaves the parent class hash intact.
  const declLine = lineSafely(doc, target.selectionRange.start.line);
  const childLines = target.directChildren
    .slice()
    .sort((a, b) => a.selectionRange.start.line - b.selectionRange.start.line)
    .map((c) => `${vscode.SymbolKind[c.kind]}::${c.name}::${lineSafely(doc, c.selectionRange.start.line)}`);
  return [declLine, ...childLines].join('\n');
}

function lineSafely(doc: vscode.TextDocument, line: number): string {
  if (line < 0 || line >= doc.lineCount) return '';
  return doc.lineAt(line).text.trim();
}

function targetAtLine(editor: vscode.TextEditor, line: number): DrawerTarget | undefined {
  const targets = targetsByEditor.get(editor) ?? [];
  // Prefer exact match on selection line; fall back to enclosing range.
  return (
    targets.find((t) => t.selectionRange.start.line === line) ??
    targets.find((t) => t.fullRange.start.line <= line && t.fullRange.end.line >= line)
  );
}

function enqueueSummary(editor: vscode.TextEditor, target: DrawerTarget, force: boolean): void {
  const id = identityFor(editor.document, target);
  if (pendingByCacheKey.has(id.cacheKey)) return;
  if (!force && cache.getByCacheKey(id.cacheKey)) return; // already fresh
  pendingByCacheKey.add(id.cacheKey);
  lensProvider?.refresh();

  summaryQueue.add(async () => {
    const provider = registry.active();
    if (!(await provider.isAvailable())) {
      pendingByCacheKey.delete(id.cacheKey);
      lensProvider?.refresh();
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
          symbolPath: target.symbolPath,
          signature,
          truncated: false,
          codeSlice: slice,
        },
        tokenSource.token,
      );
      const latency = Date.now() - start;
      await cache.set({
        cacheKey: id.cacheKey,
        pathKey: target.pathKey,
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
      lensProvider?.refresh();
    } catch (err) {
      output.appendLine(`[summary error] ${target.symbolPath.join('.')}: ${(err as Error).message}`);
    } finally {
      tokenSource.dispose();
      pendingByCacheKey.delete(id.cacheKey);
      lensProvider?.refresh();
    }
  });
}

async function generateForFile(
  editor: vscode.TextEditor,
  _opts: { onlyStale: boolean },
): Promise<void> {
  const provider = registry.active();
  if (!(await provider.isAvailable())) {
    vscode.window.showWarningMessage(
      'Semantic Fold Mode: provider is not configured. Set your Anthropic API key first.',
    );
    return;
  }

  // Always (re)check the file summary as part of "generate for file".
  generateFileSummary(editor, false).catch((err) => {
    output.appendLine(`[file summary] ${(err as Error).message}`);
  });

  const targets = targetsByEditor.get(editor) ?? [];
  const eligible: DrawerTarget[] = [];
  for (const t of targets) {
    const lookup = lookupSummary(editor.document, t);
    if (!lookup || lookup.stale) eligible.push(t);
  }
  if (eligible.length === 0) {
    return; // file summary may still be running; that's fine
  }

  const cfg = vscode.workspace.getConfiguration('semanticFoldMode');
  const batchSize = Math.max(1, cfg.get<number>('cloud.batchSize', 30));
  const maxChars = Math.max(2000, cfg.get<number>('cloud.maxBatchInputChars', 60000));

  if (typeof provider.summarizeBatch !== 'function') {
    output.appendLine('[generateForFile] provider does not support batching, falling back to per-symbol queue');
    for (const t of eligible) enqueueSummary(editor, t, false);
    return;
  }

  const batches = batchTargets(editor.document, eligible, batchSize, maxChars);
  output.appendLine(
    `[generateForFile] ${eligible.length} target(s) → ${batches.length} batch(es) (cap ${batchSize}/${maxChars}ch)`,
  );

  // Mark all as pending up-front so the UI shows progress immediately.
  const pendingKeys: string[] = [];
  for (const t of eligible) {
    const id = identityFor(editor.document, t);
    if (!pendingByCacheKey.has(id.cacheKey)) {
      pendingByCacheKey.add(id.cacheKey);
      pendingKeys.push(id.cacheKey);
    }
  }
  lensProvider?.refresh();

  for (const batch of batches) {
    summaryQueue.add(() => runBatch(editor, batch));
  }
}

interface PreparedBatchItem {
  target: DrawerTarget;
  cacheKey: string;
  semanticHash: string;
  sourceHash: string;
  request: import('./providers/types').BatchSummaryItem;
}

function batchTargets(
  doc: vscode.TextDocument,
  targets: DrawerTarget[],
  batchSize: number,
  maxChars: number,
): PreparedBatchItem[][] {
  const batches: PreparedBatchItem[][] = [];
  let current: PreparedBatchItem[] = [];
  let currentChars = 0;

  targets.forEach((target, index) => {
    const id = identityFor(doc, target);
    const slice = doc.getText(target.fullRange);
    const signature = firstNonEmptyLine(slice);
    const item: PreparedBatchItem = {
      target,
      cacheKey: id.cacheKey,
      semanticHash: id.semanticHash,
      sourceHash: id.sourceHash,
      request: {
        id: String(index),
        languageId: doc.languageId,
        symbolKind: vscode.SymbolKind[target.kind],
        symbolPath: target.symbolPath,
        signature,
        truncated: false,
        codeSlice: slice,
      },
    };
    const itemChars = slice.length + 200; // signature + metadata overhead
    if (current.length >= batchSize || (current.length > 0 && currentChars + itemChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

async function runBatch(editor: vscode.TextEditor, batch: PreparedBatchItem[]): Promise<void> {
  const provider = registry.active();
  if (!provider.summarizeBatch) return;
  const tokenSource = new vscode.CancellationTokenSource();
  const start = Date.now();
  try {
    const results = await provider.summarizeBatch(
      batch.map((b) => b.request),
      tokenSource.token,
    );
    const latency = Date.now() - start;
    const byId = new Map(results.map((r) => [r.id, r.summary]));
    let stored = 0;
    for (const item of batch) {
      const summary = byId.get(item.request.id);
      if (!summary) continue;
      stored++;
      await cache.set({
        cacheKey: item.cacheKey,
        pathKey: item.target.pathKey,
        targetId: item.target.id,
        semanticHash: item.semanticHash,
        sourceHash: item.sourceHash,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        providerId: provider.id,
        summary,
        generatedAt: new Date().toISOString(),
        latencyMs: latency,
      });
    }
    output.appendLine(`[batch] stored ${stored}/${batch.length} summaries`);
    if (stored < batch.length) {
      const missing = batch.filter((b) => !byId.has(b.request.id)).map((b) => b.target.symbolPath.join('.'));
      output.appendLine(`[batch] missing ids in response: ${missing.join(', ')}`);
    }
    renderHeaders(editor);
  } catch (err) {
    output.appendLine(`[batch error] ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Semantic Fold Mode: batch summarize failed — ${(err as Error).message}`);
  } finally {
    tokenSource.dispose();
    for (const item of batch) pendingByCacheKey.delete(item.cacheKey);
    lensProvider?.refresh();
  }
}

async function generateFileSummary(editor: vscode.TextEditor, force: boolean): Promise<void> {
  const provider = registry.active();
  if (!provider.summarizeFile) return;
  if (!(await provider.isAvailable())) return;

  const doc = editor.document;
  const uriStr = doc.uri.toString();
  const targets = targetsByEditor.get(editor) ?? [];
  const id = fileIdentityFor(doc, targets);

  const existing = cache.getFileByUri(uriStr);
  if (!force && existing && existing.skeletonHash === id.skeletonHash) return;
  if (fileSummaryPending.has(uriStr)) return;
  fileSummaryPending.add(uriStr);
  lensProvider?.refresh();

  summaryQueue.add(async () => {
    const tokenSource = new vscode.CancellationTokenSource();
    const start = Date.now();
    try {
      const cfg = vscode.workspace.getConfiguration('semanticFoldMode');
      const maxChars = Math.max(8000, cfg.get<number>('cloud.maxBatchInputChars', 60000));
      const fullText = doc.getText();
      const truncated = fullText.length > maxChars;
      const content = truncated ? fileSkeleton(doc, targets) : fullText;
      const summary = await provider.summarizeFile!(
        {
          path: uriStr,
          languageId: doc.languageId,
          content,
          truncated,
        },
        tokenSource.token,
      );
      const latency = Date.now() - start;
      await cache.setFile({
        cacheKey: id.cacheKey,
        uri: uriStr,
        skeletonHash: id.skeletonHash,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        providerId: provider.id,
        summary,
        generatedAt: new Date().toISOString(),
        latencyMs: latency,
      });
      output.appendLine(`[file summary] stored: ${summary.headline}`);
      renderHeaders(editor);
    } catch (err) {
      output.appendLine(`[file summary error] ${(err as Error).message}`);
    } finally {
      tokenSource.dispose();
      fileSummaryPending.delete(uriStr);
      lensProvider?.refresh();
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

function buildFileHoverMarkdown(doc: vscode.TextDocument, lookup: FileSummaryLookup): string {
  const args = encodeURIComponent(JSON.stringify([doc.uri.toString()]));
  const regenLink = `[$(refresh) Regenerate file summary](command:semanticFoldMode.regenerateFileSummary?${args} "Regenerate this file's overview")`;
  const { summary, stale } = lookup;
  const lines: string[] = [];
  if (stale) lines.push('⚠ _File structure changed — overview may be out of date._', '');
  lines.push(`**${summary.headline}**`, '', summary.overview);
  if (summary.main_features.length) {
    lines.push('', '**Main features:**');
    for (const f of summary.main_features) lines.push(`- ${f}`);
  }
  lines.push('', regenLink);
  return lines.join('\n');
}

function buildHoverMarkdown(target: DrawerTarget, lookup: SummaryLookup | undefined): string {
  const args = encodeURIComponent(JSON.stringify([target.uri, target.selectionRange.start.line]));
  const regenLink = `[$(refresh) Regenerate](command:semanticFoldMode.regenerateUnitAt?${args} "Regenerate this summary")`;

  if (!lookup) {
    return [
      `**${target.name}** — ${vscode.SymbolKind[target.kind]}`,
      '',
      '_AI summary not yet generated._',
      '',
      regenLink,
    ].join('\n');
  }
  const { summary, stale } = lookup;
  const lines: string[] = [];
  if (stale) lines.push('⚠ _Out of date — content edited since last summary._', '');
  lines.push(`**${summary.headline}**`, '', summary.purpose);
  if (summary.methods_used.length) lines.push('', `**Methods used:** ${summary.methods_used.join(', ')}`);
  if (summary.techniques.length) lines.push(`**Techniques:** ${summary.techniques.join(', ')}`);
  if (summary.risks.length) lines.push(`**Risks:** ${summary.risks.join(', ')}`);
  lines.push('', `_Confidence: ${summary.confidence}_`, '', regenLink);
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
