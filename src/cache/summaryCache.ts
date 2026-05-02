import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { SummaryJson } from '../providers/types';

export interface SummaryRecord {
  cacheKey: string;
  pathKey: string;
  targetId: string;
  semanticHash: string;
  sourceHash: string;
  promptVersion: string;
  schemaVersion: string;
  providerId: string;
  modelId?: string;
  summary: SummaryJson;
  generatedAt: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface CacheIdentity {
  sourceHash: string;
  semanticHash: string;
  cacheKey: string;
}

export class SummaryCache {
  private readonly byCacheKey = new Map<string, SummaryRecord>();
  private readonly pathToCacheKey = new Map<string, string>();
  private readonly dirUri: vscode.Uri;
  private initialized = false;

  constructor(context: vscode.ExtensionContext) {
    this.dirUri = vscode.Uri.joinPath(context.globalStorageUri, 'summaries');
  }

  async init(): Promise<{ loaded: number }> {
    if (this.initialized) return { loaded: this.byCacheKey.size };
    this.initialized = true;
    try {
      await vscode.workspace.fs.createDirectory(this.dirUri);
    } catch {
      // best-effort
    }
    let loaded = 0;
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.dirUri);
      const decoder = new TextDecoder();
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) continue;
        if (!name.endsWith('.json')) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(this.dirUri, name),
          );
          const record = JSON.parse(decoder.decode(bytes)) as SummaryRecord;
          if (!record.cacheKey || !record.pathKey || !record.summary) continue;
          this.byCacheKey.set(record.cacheKey, record);
          this.pathToCacheKey.set(record.pathKey, record.cacheKey);
          loaded++;
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // dir may not exist yet on first run; ignore
    }
    return { loaded };
  }

  identity(args: {
    sourceSlice: string;
    semanticSlice: string;
    providerId: string;
    promptVersion: string;
    schemaVersion: string;
    settingsProfile: string;
  }): CacheIdentity {
    const sourceHash = sha256(normalize(args.sourceSlice));
    const semanticHash = sha256(normalize(args.semanticSlice));
    const cacheKey = sha256(
      [semanticHash, args.providerId, args.promptVersion, args.schemaVersion, args.settingsProfile].join(
        '\x1f',
      ),
    );
    return { sourceHash, semanticHash, cacheKey };
  }

  getByCacheKey(cacheKey: string): SummaryRecord | undefined {
    return this.byCacheKey.get(cacheKey);
  }

  getByPathKey(pathKey: string): SummaryRecord | undefined {
    const cacheKey = this.pathToCacheKey.get(pathKey);
    return cacheKey ? this.byCacheKey.get(cacheKey) : undefined;
  }

  async set(record: SummaryRecord): Promise<void> {
    this.byCacheKey.set(record.cacheKey, record);
    this.pathToCacheKey.set(record.pathKey, record.cacheKey);
    try {
      const fileUri = vscode.Uri.joinPath(this.dirUri, `${record.cacheKey}.json`);
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      await vscode.workspace.fs.writeFile(fileUri, bytes);
    } catch {
      // disk write best-effort; in-memory copy still serves the session
    }
  }

  async clear(): Promise<void> {
    this.byCacheKey.clear();
    this.pathToCacheKey.clear();
    try {
      await vscode.workspace.fs.delete(this.dirUri, { recursive: true });
    } catch {
      // best-effort
    }
    try {
      await vscode.workspace.fs.createDirectory(this.dirUri);
    } catch {
      // best-effort
    }
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
