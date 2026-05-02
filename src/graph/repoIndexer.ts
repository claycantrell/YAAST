import * as vscode from 'vscode';
import * as path from 'node:path';
import { collectDrawerTargets } from '../extraction/symbols';

const FILE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py}';
const EXCLUDE =
  '{**/node_modules/**,**/dist/**,**/out/**,**/.next/**,**/.open-next/**,**/build/**,**/target/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.git/**,**/.vscode-test/**,**/coverage/**,**/.turbo/**,**/.cache/**,**/.parcel-cache/**,**/.svelte-kit/**,**/.nuxt/**,**/.output/**,**/.expo/**,**/.docusaurus/**,**/.claude/**,**/playwright-report/**,**/test-results/**,**/storybook-static/**,**/.yarn/**,**/.pnpm-store/**,**/*.min.js,**/*.bundle.js,**/*.d.ts}';

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PY_EXTS = ['.py'];

const IMPORT_REGEXES: RegExp[] = [
  // ES: import x from 'y' / import 'y' / import * as x from 'y' / import { a, b } from 'y'
  /\bimport\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  // ES dynamic
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // ES re-exports
  /\bexport\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // Python: from x import ... and import x[, y]
  /^\s*from\s+([A-Za-z_.][\w.]*)\s+import\s+/gm,
  /^\s*import\s+([A-Za-z_.][\w.]*)/gm,
];

export interface FileNode {
  id: string; // workspace-relative path, normalized to forward slashes
  uri: string;
  basename: string;
  folder: string; // top-level folder, e.g. "src/lib/offline"
  language: string;
  symbolCount: number;
  loc: number;
  fileSummaryHeadline?: string;
}

export interface FileEdge {
  source: string;
  target: string;
  importCount: number;
}

export interface ExternalNode {
  id: string; // e.g. "react", "@anthropic-ai/sdk"
  usageCount: number;
}

export interface RepoGraph {
  files: FileNode[];
  edges: FileEdge[];
  externals: ExternalNode[];
  scannedFiles: number;
  unresolvedImports: number;
  builtAt: string;
  durationMs: number;
}

export interface IndexProgress {
  step: 'scanning' | 'parsing' | 'resolving' | 'done';
  scanned: number;
  total: number;
  message?: string;
}
export type ProgressCallback = (p: IndexProgress) => void;

interface PathAliasEntry {
  prefix: string; // e.g. "@/"
  basePaths: string[]; // workspace-relative paths, e.g. ["src/"]
}

export async function buildRepoGraph(
  cancel: vscode.CancellationToken,
  onProgress: ProgressCallback,
  fileSummaryHeadlineFor: (uri: string) => string | undefined,
): Promise<RepoGraph> {
  const start = Date.now();
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error('Open a workspace folder first.');

  onProgress({ step: 'scanning', scanned: 0, total: 0, message: 'finding files' });
  const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE, 8000);
  if (cancel.isCancellationRequested) throw new Error('cancelled');

  const aliases = await loadPathAliases(root);

  // Build a lookup from workspace-relative path → URI for resolution.
  const allRelPaths = new Set<string>();
  const relToUri = new Map<string, vscode.Uri>();
  for (const u of uris) {
    const rel = normRel(vscode.workspace.asRelativePath(u, false));
    allRelPaths.add(rel);
    relToUri.set(rel, u);
  }

  onProgress({ step: 'parsing', scanned: 0, total: uris.length });

  const files = new Map<string, FileNode>();
  const edgeMap = new Map<string, FileEdge>();
  const externalCount = new Map<string, number>();
  let unresolvedImports = 0;

  const concurrency = 8;
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < uris.length) {
      if (cancel.isCancellationRequested) return;
      const idx = cursor++;
      const uri = uris[idx];
      const rel = normRel(vscode.workspace.asRelativePath(uri, false));
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const targets = await collectDrawerTargets(doc);
        const symbolCount = targets.length;

        files.set(rel, {
          id: rel,
          uri: uri.toString(),
          basename: path.basename(rel),
          folder: path.dirname(rel),
          language: doc.languageId,
          symbolCount,
          loc: doc.lineCount,
          fileSummaryHeadline: fileSummaryHeadlineFor(uri.toString()),
        });

        const stripped = stripCommentsOnly(text, doc.languageId);
        const isPython = doc.languageId === 'python' || rel.endsWith('.py');
        const importSpecs = extractImportSpecs(stripped, isPython);

        for (const spec of importSpecs) {
          const targetRel = resolveSpecToRelPath(spec, rel, allRelPaths, aliases, isPython);
          if (!targetRel) {
            // Treat as external if it's a bare module or unresolved relative.
            if (isBareImport(spec)) {
              const pkg = topLevelPackage(spec);
              externalCount.set(pkg, (externalCount.get(pkg) ?? 0) + 1);
            } else {
              unresolvedImports++;
            }
            continue;
          }
          if (targetRel === rel) continue; // self-import (rare)
          const k = `${rel}${targetRel}`;
          const existing = edgeMap.get(k);
          if (existing) existing.importCount++;
          else edgeMap.set(k, { source: rel, target: targetRel, importCount: 1 });
        }
      } catch {
        // ignore unreadable files
      } finally {
        done++;
        if (done % 25 === 0 || done === uris.length) {
          onProgress({ step: 'parsing', scanned: done, total: uris.length });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (cancel.isCancellationRequested) throw new Error('cancelled');

  onProgress({ step: 'done', scanned: uris.length, total: uris.length });

  // Drop edges whose target file we never indexed (very rare here since we resolved to relToUri).
  const nodes = Array.from(files.values());
  const validIds = new Set(nodes.map((n) => n.id));
  const edges = Array.from(edgeMap.values()).filter(
    (e) => validIds.has(e.source) && validIds.has(e.target),
  );

  const externals = Array.from(externalCount.entries())
    .map(([id, usageCount]) => ({ id, usageCount }))
    .sort((a, b) => b.usageCount - a.usageCount);

  return {
    files: nodes,
    edges,
    externals,
    scannedFiles: uris.length,
    unresolvedImports,
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}

function normRel(p: string): string {
  return p.replace(/\\/g, '/');
}

function isBareImport(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  if (spec.startsWith('@/') || spec.startsWith('~/')) return false;
  // Python uses dots for relative; treat anything without leading dot as bare.
  return true;
}

function topLevelPackage(spec: string): string {
  // For "@scope/name/sub" → "@scope/name"; for "name/sub" → "name".
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0];
}

function extractImportSpecs(stripped: string, isPython: boolean): string[] {
  const out: string[] = [];
  for (const re of IMPORT_REGEXES) {
    if (!isPython && re.source.startsWith('^\\s*from') ) continue;
    if (!isPython && re.source.startsWith('^\\s*import\\s+([A-Za-z_')) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

function resolveSpecToRelPath(
  spec: string,
  fromRel: string,
  allPaths: Set<string>,
  aliases: PathAliasEntry[],
  isPython: boolean,
): string | undefined {
  if (isPython) {
    return resolvePythonSpec(spec, fromRel, allPaths);
  }
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const baseDir = path.posix.dirname(fromRel);
    const joined = path.posix.normalize(path.posix.join(baseDir, spec));
    return tryFileVariants(joined, allPaths, JS_EXTS);
  }
  for (const a of aliases) {
    if (spec.startsWith(a.prefix)) {
      const tail = spec.slice(a.prefix.length);
      for (const base of a.basePaths) {
        const candidate = path.posix.normalize(path.posix.join(base, tail));
        const hit = tryFileVariants(candidate, allPaths, JS_EXTS);
        if (hit) return hit;
      }
      return undefined;
    }
  }
  return undefined; // bare module
}

function resolvePythonSpec(
  spec: string,
  fromRel: string,
  allPaths: Set<string>,
): string | undefined {
  // Relative: from .foo import x  → spec "foo" with leading dots stripped from the from-clause.
  // Our regex captures "foo" (no leading dots) so we miss explicit "from . import" pure-relative.
  // For absolute "a.b.c" we try to resolve to "a/b/c.py" or "a/b/c/__init__.py".
  const parts = spec.split('.');
  const baseDir = path.posix.dirname(fromRel);
  const candidates = [
    path.posix.normalize(path.posix.join(baseDir, ...parts)),
    parts.join('/'),
  ];
  for (const c of candidates) {
    const hit = tryFileVariants(c, allPaths, PY_EXTS);
    if (hit) return hit;
  }
  return undefined;
}

function tryFileVariants(
  basePathNoExt: string,
  allPaths: Set<string>,
  exts: string[],
): string | undefined {
  if (allPaths.has(basePathNoExt)) return basePathNoExt; // exact (rare for source files)
  for (const ext of exts) {
    const candidate = basePathNoExt + ext;
    if (allPaths.has(candidate)) return candidate;
  }
  for (const ext of exts) {
    const candidate = path.posix.join(basePathNoExt, 'index' + ext);
    if (allPaths.has(candidate)) return candidate;
  }
  if (exts === PY_EXTS) {
    const init = path.posix.join(basePathNoExt, '__init__.py');
    if (allPaths.has(init)) return init;
  }
  return undefined;
}

async function loadPathAliases(root: vscode.WorkspaceFolder): Promise<PathAliasEntry[]> {
  const aliases: PathAliasEntry[] = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const uri = vscode.Uri.joinPath(root.uri, name);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      const parsed = parseJsonWithComments(text);
      const compilerOptions = (parsed?.compilerOptions ?? {}) as {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
      const baseUrl: string = compilerOptions.baseUrl ?? '.';
      const paths: Record<string, string[]> = compilerOptions.paths ?? {};
      const baseDir = path.posix.normalize(baseUrl).replace(/^\.\//, '');
      for (const [rawPrefix, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const prefix = rawPrefix.replace(/\*$/, '');
        const basePaths = targets.map((t) => {
          const stripped = t.replace(/\*$/, '').replace(/^\.\//, '');
          return path.posix.normalize(path.posix.join(baseDir, stripped));
        });
        aliases.push({ prefix, basePaths });
      }
      break;
    } catch {
      // missing file is fine; try the next one
    }
  }
  // Common Next.js fallback
  if (!aliases.some((a) => a.prefix === '@/')) {
    aliases.push({ prefix: '@/', basePaths: ['src/'] });
  }
  return aliases;
}

function parseJsonWithComments(text: string): Record<string, unknown> | undefined {
  // tsconfig.json allows // and /* */ comments and trailing commas.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stripCommentsOnly(src: string, languageId: string): string {
  // Strips comments while preserving string contents — we need the actual path
  // inside `from 'foo'`. False-positive imports inside string literals (rare)
  // are acceptable for v1.
  let out = '';
  let i = 0;
  const n = src.length;
  const isPy = languageId === 'python';
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (!isPy && c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (!isPy && c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (isPy && c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
