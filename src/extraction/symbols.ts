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
    vscode.commands.executeCommand<unknown[]>('vscode.executeDocumentSymbolProvider', doc.uri),
    vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      doc.uri,
    ),
  ]);

  const documentSymbols = (symbols ?? []).filter(isDocumentSymbolLike);

  return flatten(documentSymbols).map((sym) => {
    const fullRange = toRange(sym.range);
    const selectionRange = toRange(sym.selectionRange);
    return {
      id: `${doc.uri.toString()}#${sym.name}:${selectionRange.start.line}`,
      uri: doc.uri.toString(),
      languageId: doc.languageId,
      name: sym.name,
      detail: sym.detail,
      kind: sym.kind,
      fullRange,
      selectionRange,
      fold:
        folds?.find(
          (f) =>
            f.start <= selectionRange.start.line && f.end >= fullRange.end.line - 1,
        ) ??
        new vscode.FoldingRange(
          selectionRange.start.line,
          Math.max(fullRange.end.line - 1, selectionRange.start.line),
        ),
    };
  });
}

interface DocumentSymbolLike {
  name: string;
  detail?: string;
  kind: vscode.SymbolKind;
  range: RangeLike;
  selectionRange: RangeLike;
  children?: DocumentSymbolLike[];
}

interface RangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function isDocumentSymbolLike(s: unknown): s is DocumentSymbolLike {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    typeof o.kind === 'number' &&
    o.range != null &&
    o.selectionRange != null &&
    'children' in o
  );
}

function toRange(r: RangeLike): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function flatten(list: DocumentSymbolLike[]): DocumentSymbolLike[] {
  const out: DocumentSymbolLike[] = [];
  for (const item of list) {
    out.push(item);
    if (item.children?.length) out.push(...flatten(item.children));
  }
  return out;
}
