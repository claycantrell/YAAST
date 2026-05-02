import * as vscode from 'vscode';
import { collectDrawerTargets } from './extraction/symbols';
import { applyVirtualHeaders, headerDecorationType } from './rendering/decorations';
import { SummaryProviderRegistry } from './providers/registry';
import { SummaryCache } from './cache/summaryCache';

let output: vscode.OutputChannel;
let registry: SummaryProviderRegistry;
let cache: SummaryCache;
let enabled = true;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Semantic Fold Mode');
  context.subscriptions.push(output);
  output.appendLine('Semantic Fold Mode activated');

  registry = new SummaryProviderRegistry(context, output);
  cache = new SummaryCache(context);

  enabled = vscode.workspace.getConfiguration('semanticFoldMode').get('enabled', true);

  context.subscriptions.push(
    vscode.commands.registerCommand('semanticFoldMode.toggle', async () => {
      enabled = !enabled;
      await vscode.workspace.getConfiguration('semanticFoldMode').update('enabled', enabled, true);
      vscode.window.showInformationMessage(`Semantic Fold Mode: ${enabled ? 'on' : 'off'}`);
      await refreshActiveEditor();
    }),
    vscode.commands.registerCommand('semanticFoldMode.regenerate', async () => {
      output.appendLine('regenerate (stub)');
    }),
    vscode.commands.registerCommand('semanticFoldMode.promoteToComment', async () => {
      output.appendLine('promoteToComment (stub)');
    }),
    vscode.commands.registerCommand('semanticFoldMode.clearCache', async () => {
      await cache.clear();
      vscode.window.showInformationMessage('Semantic Fold Mode: cache cleared');
    }),
    vscode.window.onDidChangeActiveTextEditor(refreshActiveEditor),
    headerDecorationType
  );

  await refreshActiveEditor();
}

async function refreshActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  if (!enabled) {
    applyVirtualHeaders(editor, []);
    return;
  }

  try {
    const targets = await collectDrawerTargets(editor.document);
    const items = targets.map((t) => ({
      line: t.selectionRange.start.line,
      text: deterministicHeader(t.name, t.kind),
      hover: `**${t.name}** — ${vscode.SymbolKind[t.kind]}\n\nNo AI summary yet.`,
    }));
    applyVirtualHeaders(editor, items);
  } catch (err) {
    output.appendLine(`refresh error: ${(err as Error).message}`);
  }
}

function deterministicHeader(name: string, kind: vscode.SymbolKind): string {
  return `${vscode.SymbolKind[kind].toLowerCase()} ${name}`;
}

export function deactivate() {
  output?.dispose();
}
