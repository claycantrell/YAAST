import * as vscode from 'vscode';

export interface DrawerTarget {
  id: string;
  uri: string;
  languageId: string;
  name: string;
  detail?: string;
  kind: vscode.SymbolKind;
  fullRange: vscode.Range;
  selectionRange: vscode.Range;
  fold: vscode.FoldingRange;
}

export async function collectDrawerTargets(doc: vscode.TextDocument): Promise<DrawerTarget[]> {
  const [symbols, folds] = await Promise.all([
    vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      'vscode.executeDocumentSymbolProvider',
      doc.uri,
    ),
    vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      doc.uri,
    ),
  ]);

  const documentSymbols = (symbols ?? []).filter(
    (s): s is vscode.DocumentSymbol => s instanceof vscode.DocumentSymbol,
  );

  return flatten(documentSymbols).map((sym) => ({
    id: `${doc.uri.toString()}#${sym.name}:${sym.selectionRange.start.line}`,
    uri: doc.uri.toString(),
    languageId: doc.languageId,
    name: sym.name,
    detail: sym.detail,
    kind: sym.kind,
    fullRange: sym.range,
    selectionRange: sym.selectionRange,
    fold:
      folds?.find(
        (f) =>
          f.start <= sym.selectionRange.start.line &&
          f.end >= sym.range.end.line - 1,
      ) ??
      new vscode.FoldingRange(sym.selectionRange.start.line, Math.max(sym.range.end.line - 1, sym.selectionRange.start.line)),
  }));
}

function flatten(list: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const out: vscode.DocumentSymbol[] = [];
  for (const item of list) {
    out.push(item);
    out.push(...flatten(item.children));
  }
  return out;
}
