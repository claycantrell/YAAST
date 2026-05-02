import * as vscode from 'vscode';

export interface DrawerTarget {
  id: string;
  pathKey: string;
  symbolPath: string[];
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

  return flatten(documentSymbols).map(({ sym, path }) => {
    const fullRange = toRange(sym.range);
    const selectionRange = toRange(sym.selectionRange);
    const uriStr = doc.uri.toString();
    return {
      id: `${uriStr}#${path.join('.')}:${selectionRange.start.line}`,
      pathKey: `${uriStr}#${path.join('.')}`,
      symbolPath: path,
      uri: uriStr,
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

function flatten(
  list: DocumentSymbolLike[],
  ancestors: string[] = [],
): Array<{ sym: DocumentSymbolLike; path: string[] }> {
  const out: Array<{ sym: DocumentSymbolLike; path: string[] }> = [];
  for (const item of list) {
    const path = [...ancestors, item.name];
    out.push({ sym: item, path });
    if (item.children?.length) out.push(...flatten(item.children, path));
  }
  return out;
}
