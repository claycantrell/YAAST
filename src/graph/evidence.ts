import * as vscode from 'vscode';
import { collectDrawerTargets } from '../extraction/symbols';

export interface FileEvidence {
  id: string;          // short id like "f001" used in cluster prompt/response
  path: string;        // workspace-relative
  uri: string;
  basename: string;
  language: string;
  topSymbols: string[]; // up to N top-level symbol names (functions/classes/methods)
  symbolCount: number;
  loc: number;
}

const TOP_SYMBOL_LIMIT = 8;
const INCLUDE_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Constructor,
]);

export async function gatherEvidence(
  uris: vscode.Uri[],
  cancel: vscode.CancellationToken,
  onProgress: (scanned: number, total: number) => void,
): Promise<FileEvidence[]> {
  const out: FileEvidence[] = [];
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < uris.length) {
      if (cancel.isCancellationRequested) return;
      const idx = cursor++;
      const uri = uris[idx];
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const targets = await collectDrawerTargets(doc);
        const topSymbols = targets
          .filter((t) => INCLUDE_KINDS.has(t.kind) && t.symbolPath.length === 1)
          .map((t) => t.name)
          .slice(0, TOP_SYMBOL_LIMIT);
        const path = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        out.push({
          id: '', // assigned after sort
          path,
          uri: uri.toString(),
          basename: path.split('/').pop() ?? path,
          language: doc.languageId,
          topSymbols,
          symbolCount: targets.length,
          loc: doc.lineCount,
        });
      } catch {
        // ignore unreadable
      } finally {
        done++;
        if (done % 25 === 0 || done === uris.length) onProgress(done, uris.length);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));

  // Sort by path so IDs are deterministic across runs.
  out.sort((a, b) => a.path.localeCompare(b.path));
  for (let i = 0; i < out.length; i++) {
    out[i].id = `f${(i + 1).toString().padStart(4, '0')}`;
  }
  return out;
}
