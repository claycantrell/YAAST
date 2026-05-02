import * as vscode from 'vscode';
import { collectDrawerTargets, type DrawerTarget } from './extraction/symbols';
import { applyVirtualHeaders, headerDecorationType } from './rendering/decorations';
import { SummaryProviderRegistry } from './providers/registry';
import { SummaryCache } from './cache/summaryCache';

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let _registry: SummaryProviderRegistry;
let cache: SummaryCache;
let enabled = true;
const targetsByEditor = new WeakMap<vscode.TextEditor, DrawerTarget[]>();
const autoFoldedDocs = new WeakSet<vscode.TextDocument>();

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Semantic Fold Mode');
  context.subscriptions.push(output);
  output.appendLine('[activate] Semantic Fold Mode activated');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'semanticFoldMode.toggle';
  context.subscriptions.push(statusBar);

  _registry = new SummaryProviderRegistry(context, output);
  cache = new SummaryCache(context);
  void _registry;

  enabled = vscode.workspace.getConfiguration('semanticFoldMode').get('enabled', true);
  updateStatusBar(0);

  context.subscriptions.push(
    vscode.commands.registerCommand('semanticFoldMode.toggle', async () => {
      enabled = !enabled;
      await vscode.workspace.getConfiguration('semanticFoldMode').update('enabled', enabled, true);
      vscode.window.showInformationMessage(`Semantic Fold Mode: ${enabled ? 'on' : 'off'}`);
      await refreshAllVisibleEditors();
    }),
    vscode.commands.registerCommand('semanticFoldMode.regenerate', async () => {
      output.appendLine('[command] regenerate (stub)');
    }),
    vscode.commands.registerCommand('semanticFoldMode.promoteToComment', async () => {
      output.appendLine('[command] promoteToComment (stub)');
    }),
    vscode.commands.registerCommand('semanticFoldMode.clearCache', async () => {
      await cache.clear();
      vscode.window.showInformationMessage('Semantic Fold Mode: cache cleared');
    }),
    vscode.commands.registerCommand('semanticFoldMode.foldAll', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await foldDrawers(editor);
    }),
    vscode.commands.registerCommand('semanticFoldMode.unfoldAll', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await unfoldDrawers(editor);
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

  // Initial pass — symbol providers may need a beat to register.
  setTimeout(() => refreshAllVisibleEditors(), 500);
  setTimeout(() => refreshAllVisibleEditors(), 2000);
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
    const items = targets.map((t) => ({
      line: t.selectionRange.start.line,
      text: deterministicHeader(t.name, t.kind),
      hover: `**${t.name}** — ${vscode.SymbolKind[t.kind]}\n\nNo AI summary yet.`,
    }));
    applyVirtualHeaders(editor, items);
    targetsByEditor.set(editor, targets);
    updateStatusBar(targets.length);

    if (
      targets.length > 0 &&
      cfg.get<boolean>('autoFoldOnOpen', true) &&
      !autoFoldedDocs.has(editor.document)
    ) {
      autoFoldedDocs.add(editor.document);
      await foldDrawers(editor);
    }
  } catch (err) {
    output.appendLine(`[refresh error] ${(err as Error).message}`);
  }
}

async function foldDrawers(editor: vscode.TextEditor): Promise<void> {
  const targets = targetsByEditor.get(editor);
  if (!targets || targets.length === 0) return;
  // editor.fold operates on the active editor; ensure this editor is active.
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
  // Use the built-in unfoldAll to ensure nested ranges (e.g. methods inside a folded class) are also unfolded.
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
