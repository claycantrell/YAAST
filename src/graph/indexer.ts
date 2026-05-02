import * as vscode from 'vscode';
import { collectDrawerTargets, type DrawerTarget } from '../extraction/symbols';
import type { CallGraph, GraphEdge, GraphNode } from './types';

const INCLUDE_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Constructor,
]);

const FILE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py}';

// Common identifiers we don't want to treat as callees.
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in',
  'of', 'new', 'delete', 'void', 'await', 'async', 'yield', 'this', 'super',
  'class', 'function', 'const', 'let', 'var', 'import', 'export', 'from',
  'default', 'true', 'false', 'null', 'undefined', 'as', 'is',
  // common built-ins worth ignoring (noisy)
  'console', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math',
  'Date', 'Error', 'Promise', 'Map', 'Set', 'Symbol', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'require', 'module',
  // Python keywords
  'def', 'lambda', 'pass', 'with', 'global', 'nonlocal', 'and', 'or', 'not',
  'print', 'len', 'range', 'list', 'dict', 'tuple', 'int', 'str', 'float',
  'bool', 'set', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
]);

const CALL_REGEX = /\b([A-Za-z_$][\w$]*)\s*\(/g;

export interface IndexProgress {
  step: 'scanning' | 'extracting' | 'resolving' | 'done';
  scanned: number;
  total: number;
  message?: string;
}

export type ProgressCallback = (p: IndexProgress) => void;

interface IndexedSymbol {
  target: DrawerTarget;
  uri: vscode.Uri;
  filePath: string;
}

export async function buildCallGraph(
  cancel: vscode.CancellationToken,
  onProgress: ProgressCallback,
  headlineFor: (pathKey: string) => string | undefined,
  signatureFor?: (pathKey: string) => string | undefined,
): Promise<CallGraph> {
  const start = Date.now();
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    throw new Error('Open a workspace folder first.');
  }

  onProgress({ step: 'scanning', scanned: 0, total: 0, message: 'finding files' });
  const exclude = '{**/node_modules/**,**/dist/**,**/out/**,**/.next/**,**/build/**,**/.venv/**,**/__pycache__/**,**/.git/**,**/.vscode-test/**}';
  const uris = await vscode.workspace.findFiles(FILE_GLOB, exclude, 5000);
  if (cancel.isCancellationRequested) throw new Error('cancelled');

  onProgress({ step: 'extracting', scanned: 0, total: uris.length });

  const indexed: IndexedSymbol[] = [];
  const nameToSymbols = new Map<string, IndexedSymbol[]>();

  // Limit concurrency for openTextDocument so we don't try to mass-load 5K files.
  const concurrency = 8;
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= uris.length) return;
      if (cancel.isCancellationRequested) return;
      const uri = uris[idx];
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const targets = await collectDrawerTargets(doc);
        for (const t of targets) {
          if (!INCLUDE_KINDS.has(t.kind)) continue;
          const filePath = vscode.workspace.asRelativePath(uri);
          const entry: IndexedSymbol = { target: t, uri, filePath };
          indexed.push(entry);
          const list = nameToSymbols.get(t.name);
          if (list) list.push(entry);
          else nameToSymbols.set(t.name, [entry]);
        }
      } catch {
        // skip files that fail to open
      } finally {
        done++;
        if (done % 25 === 0 || done === uris.length) {
          onProgress({ step: 'extracting', scanned: done, total: uris.length });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (cancel.isCancellationRequested) throw new Error('cancelled');

  onProgress({ step: 'resolving', scanned: 0, total: indexed.length });

  const nodes: GraphNode[] = indexed.map(({ target, uri, filePath }) => ({
    id: target.pathKey,
    uri: uri.toString(),
    filePath,
    symbolPath: target.symbolPath,
    name: target.name,
    kind: target.kind,
    headline: headlineFor(target.pathKey),
    signature: signatureFor?.(target.pathKey),
  }));

  const edgeKey = (s: string, t: string) => `${s}${t}`;
  const edgeMap = new Map<string, GraphEdge>();
  const unresolvedCallees: { caller: string; callee: string }[] = [];

  for (let i = 0; i < indexed.length; i++) {
    if (cancel.isCancellationRequested) throw new Error('cancelled');
    const { target, uri } = indexed[i];
    let body: string;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      body = doc.getText(target.fullRange);
    } catch {
      continue;
    }

    const stripped = stripStringsAndComments(body);
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    CALL_REGEX.lastIndex = 0;
    while ((match = CALL_REGEX.exec(stripped)) !== null) {
      const callee = match[1];
      if (KEYWORDS.has(callee)) continue;
      if (callee === target.name) continue; // skip self
      if (seen.has(callee)) continue;
      seen.add(callee);

      const candidates = nameToSymbols.get(callee);
      if (!candidates || candidates.length === 0) {
        unresolvedCallees.push({ caller: target.pathKey, callee });
        continue;
      }
      let resolved: IndexedSymbol | undefined;
      if (candidates.length === 1) {
        resolved = candidates[0];
      } else {
        const sameFile = candidates.find((c) => c.uri.toString() === uri.toString());
        if (sameFile) resolved = sameFile;
      }
      if (!resolved) {
        unresolvedCallees.push({ caller: target.pathKey, callee });
        continue;
      }
      const k = edgeKey(target.pathKey, resolved.target.pathKey);
      const existing = edgeMap.get(k);
      if (existing) existing.count++;
      else edgeMap.set(k, { source: target.pathKey, target: resolved.target.pathKey, count: 1 });
    }

    if ((i + 1) % 50 === 0) {
      onProgress({ step: 'resolving', scanned: i + 1, total: indexed.length });
    }
  }

  onProgress({ step: 'done', scanned: indexed.length, total: indexed.length });

  return {
    nodes,
    edges: Array.from(edgeMap.values()),
    scannedFiles: uris.length,
    unresolvedCallees: unresolvedCallees.slice(0, 200),
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}

function stripStringsAndComments(src: string): string {
  // Crude but effective: replace string contents and comments with whitespace
  // so we don't pick up function-name lookalikes inside them.
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Line comment //
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Block comment /* ... */
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Python comment #
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // String literals
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (ch === quote) {
          out += ch;
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
