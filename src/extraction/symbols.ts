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
      fold: pickSmallestContainingFold(folds, selectionRange, fullRange),
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

function pickSmallestContainingFold(
  folds: vscode.FoldingRange[] | undefined,
  selectionRange: vscode.Range,
  fullRange: vscode.Range,
): vscode.FoldingRange {
  const sel = selectionRange.start.line;
  const end = Math.max(fullRange.end.line - 1, sel);
  const containing = (folds ?? []).filter((f) => f.start <= sel && f.end >= sel && f.end <= end + 1);
  if (containing.length === 0) {
    return new vscode.FoldingRange(sel, end);
  }
  containing.sort((a, b) => a.end - a.start - (b.end - b.start));
  return containing[0];
}

function flatten(list: DocumentSymbolLike[]): DocumentSymbolLike[] {
  const out: DocumentSymbolLike[] = [];
  for (const item of list) {
    out.push(item);
    if (item.children?.length) out.push(...flatten(item.children));
  }
  return out;
}
