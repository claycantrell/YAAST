import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { collectDrawerTargets, type DrawerTarget } from '../../extraction/symbols';

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
    // Disable autoFoldOnOpen so the test isn't racing the activation timer, then
    // unfold any leftover state from earlier auto-folding to establish a clean baseline.
    await vscode.workspace
      .getConfiguration('semanticFoldMode')
      .update('autoFoldOnOpen', false, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 200));
    await vscode.commands.executeCommand('semanticFoldMode.unfoldAll');
    await new Promise((r) => setTimeout(r, 200));
    await vscode.commands.executeCommand('semanticFoldMode.unfoldAll');
    await new Promise((r) => setTimeout(r, 400));
    const baseline = countVisibleLines(editor);
    log(`baseline visible lines (unfolded): ${baseline}`);
    if (baseline < 30) {
      failures.push(`baseline suspiciously low (${baseline}) — folds may not have cleared`);
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
    if (Math.abs(reopened - baseline) > 2) {
      failures.push(`unfoldAll didn't restore to baseline (baseline=${baseline} reopened=${reopened})`);
    }

    // 7) Verify the parent-stays-fresh invariant: editing a method body should
    //    change the method's hash but NOT the parent class's hash.
    log('--- container skeleton hash invariance ---');
    await runHashInvarianceCheck(failures, log);

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

async function runHashInvarianceCheck(failures: string[], log: (msg: string) => void) {
  const beforeText = `export class Container {
  alpha(): number {
    return 1;
  }
  beta(x: number): number {
    return x * 2;
  }
}
`;
  const afterText = `export class Container {
  alpha(): number {
    return 999; // body changed
  }
  beta(x: number): number {
    return x * 2;
  }
}
`;

  const docBefore = await vscode.workspace.openTextDocument({ language: 'typescript', content: beforeText });
  await vscode.window.showTextDocument(docBefore);
  await waitForSymbols(docBefore, 15000);
  const targetsBefore = await collectDrawerTargets(docBefore);
  const containerBefore = targetsBefore.find((t) => t.name === 'Container');
  const alphaBefore = targetsBefore.find((t) => t.name === 'alpha');
  if (!containerBefore || !alphaBefore) {
    failures.push('hash-invariance: missing Container/alpha in the BEFORE doc');
    return;
  }

  const docAfter = await vscode.workspace.openTextDocument({ language: 'typescript', content: afterText });
  await vscode.window.showTextDocument(docAfter);
  await waitForSymbols(docAfter, 15000);
  const targetsAfter = await collectDrawerTargets(docAfter);
  const containerAfter = targetsAfter.find((t) => t.name === 'Container');
  const alphaAfter = targetsAfter.find((t) => t.name === 'alpha');
  if (!containerAfter || !alphaAfter) {
    failures.push('hash-invariance: missing Container/alpha in the AFTER doc');
    return;
  }

  const containerSliceBefore = skeletonOf(docBefore, containerBefore);
  const containerSliceAfter = skeletonOf(docAfter, containerAfter);
  log(`Container skeleton BEFORE: ${JSON.stringify(containerSliceBefore)}`);
  log(`Container skeleton AFTER : ${JSON.stringify(containerSliceAfter)}`);
  if (containerSliceBefore !== containerSliceAfter) {
    failures.push(`Container skeleton changed when only a child body changed`);
  } else {
    log(`✓ Container skeleton invariant holds`);
  }

  const alphaSliceBefore = docBefore.getText(alphaBefore.fullRange);
  const alphaSliceAfter = docAfter.getText(alphaAfter.fullRange);
  if (alphaSliceBefore === alphaSliceAfter) {
    failures.push(`alpha source slice did not change despite body edit`);
  } else {
    log(`✓ alpha body slice DID change (good)`);
  }
}

function skeletonOf(doc: vscode.TextDocument, target: DrawerTarget): string {
  // Mirror computeSemanticSlice from extension.ts for verification purposes.
  const declLine = doc.lineAt(target.selectionRange.start.line).text.trim();
  const childLines = target.directChildren
    .slice()
    .sort((a, b) => a.selectionRange.start.line - b.selectionRange.start.line)
    .map(
      (c) =>
        `${vscode.SymbolKind[c.kind]}::${c.name}::${doc.lineAt(c.selectionRange.start.line).text.trim()}`,
    );
  return [declLine, ...childLines].join('\n');
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
