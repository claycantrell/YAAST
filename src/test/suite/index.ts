import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { collectDrawerTargets } from '../../extraction/symbols';

export async function run(): Promise<void> {
  const failures: string[] = [];
  const log = (msg: string) => {
    console.log(`[test] ${msg}`);
  };

  log('--- Semantic Fold Mode integration test ---');

  // 1) Verify extension activates.
  // Note: --disable-extensions disables all OTHER extensions, but the development extension still loads.
  const ourExt = vscode.extensions.all.find(
    (e) => e.id.toLowerCase().endsWith('semantic-fold-mode'),
  );
  if (!ourExt) {
    failures.push(
      `extension not found in vscode.extensions.all. Found ids: ${vscode.extensions.all
        .map((e) => e.id)
        .join(', ')}`,
    );
  } else {
    log(`extension found: id=${ourExt.id} active=${ourExt.isActive}`);
    if (!ourExt.isActive) {
      await ourExt.activate();
      log(`extension activated: ${ourExt.isActive}`);
    }
  }

  // 2) Open the sample file.
  const samplePath = path.resolve(__dirname, '../../../sample/demo.ts');
  if (!fs.existsSync(samplePath)) {
    failures.push(`sample file missing: ${samplePath}`);
  } else {
    const doc = await vscode.workspace.openTextDocument(samplePath);
    const editor = await vscode.window.showTextDocument(doc);
    log(`opened ${samplePath} (${doc.languageId}, ${doc.lineCount} lines)`);

    // Diagnostic: list all extensions.
    log(`total extensions loaded: ${vscode.extensions.all.length}`);
    const tsExt = vscode.extensions.all.find((e) => e.id === 'vscode.typescript-language-features');
    log(`vscode.typescript-language-features: ${tsExt ? `found, active=${tsExt.isActive}` : 'NOT FOUND'}`);
    if (tsExt && !tsExt.isActive) {
      await tsExt.activate();
      log(`activated TS extension: ${tsExt.isActive}`);
    }

    // 3) Wait for TS language service to come up.
    const allTargets = await waitForSymbols(doc, 30000);
    const includeKinds = new Set(['Function', 'Method', 'Class']);
    const targets = allTargets.filter((t) => includeKinds.has(vscode.SymbolKind[t.kind]));
    log(`collectDrawerTargets: ${targets.length}/${allTargets.length} after kind filter`);
    for (const t of targets) {
      log(
        `  - ${vscode.SymbolKind[t.kind]} ${t.name} @ line ${t.selectionRange.start.line + 1} fold=${t.fold.start}-${t.fold.end}`,
      );
    }

    if (targets.length === 0) {
      failures.push('expected >0 drawer targets in sample/demo.ts');
    }

    // 4) Verify expected symbols are present (Function/Method/Class only).
    const names = new Set(targets.map((t) => t.name));
    for (const expected of ['UserService', 'findById', 'invalidate', 'fetchUser', 'buildIndex', 'tokenize']) {
      if (!names.has(expected)) {
        failures.push(`expected symbol '${expected}' missing from targets`);
      }
    }
    // Verify properties/variables are filtered out.
    for (const unwanted of ['cache', 'res', 'index', 'item', 'user']) {
      if (names.has(unwanted)) {
        failures.push(`unwanted symbol '${unwanted}' should be filtered out by kind`);
      }
    }

    // 5) Verify the extension's command is registered.
    const cmds = await vscode.commands.getCommands(true);
    for (const c of [
      'semanticFoldMode.toggle',
      'semanticFoldMode.foldAll',
      'semanticFoldMode.unfoldAll',
    ]) {
      if (!cmds.includes(c)) failures.push(`command '${c}' not registered`);
      else log(`command '${c}' is registered`);
    }

    // 6) Verify fold/unfold commands actually change visible ranges.
    // Unfold first to establish a clean baseline (autoFoldOnOpen may have run).
    await vscode.commands.executeCommand('semanticFoldMode.unfoldAll');
    await new Promise((r) => setTimeout(r, 400));
    const baseline = countVisibleLines(editor);
    log(`baseline visible lines (unfolded): ${baseline}`);
    if (baseline < doc.lineCount) {
      failures.push(`baseline should equal lineCount (${doc.lineCount}) but got ${baseline}`);
    }

    await vscode.commands.executeCommand('semanticFoldMode.foldAll');
    await new Promise((r) => setTimeout(r, 400));
    const folded = countVisibleLines(editor);
    log(`visible lines after foldAll: ${folded}`);
    if (folded >= baseline) {
      failures.push(`foldAll did not reduce visible lines (baseline=${baseline} folded=${folded})`);
    }

    await vscode.commands.executeCommand('semanticFoldMode.unfoldAll');
    await new Promise((r) => setTimeout(r, 400));
    const reopened = countVisibleLines(editor);
    log(`visible lines after unfoldAll: ${reopened}`);
    if (reopened <= folded) {
      failures.push(`unfoldAll did not restore visible lines (folded=${folded} reopened=${reopened})`);
    }

    // Use editor to silence unused warning.
    void editor;
  }

  if (failures.length) {
    console.error('FAILURES:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    throw new Error(`${failures.length} failure(s)`);
  }

  log('ALL CHECKS PASSED');
}

function countVisibleLines(editor: vscode.TextEditor): number {
  let total = 0;
  for (const r of editor.visibleRanges) {
    total += r.end.line - r.start.line + 1;
  }
  return total;
}

async function waitForSymbols(doc: vscode.TextDocument, timeoutMs: number) {
  const start = Date.now();
  let tick = 0;
  while (Date.now() - start < timeoutMs) {
    const raw = await vscode.commands.executeCommand<unknown>(
      'vscode.executeDocumentSymbolProvider',
      doc.uri,
    );
    const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      doc.uri,
    );
    const rawType = raw === null ? 'null' : raw === undefined ? 'undefined' : Array.isArray(raw) ? `Array[${(raw as unknown[]).length}]` : typeof raw;
    const targets = await collectDrawerTargets(doc);
    if (tick % 4 === 0) {
      console.log(
        `[test] t=${Date.now() - start}ms  rawSymbols=${rawType}  folds=${folds?.length ?? 'null'}  targets=${targets.length}`,
      );
    }
    tick++;
    if (targets.length > 0) return targets;
    await new Promise((r) => setTimeout(r, 500));
  }
  return collectDrawerTargets(doc);
}
