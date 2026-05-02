import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { FileSummaryJson, SummaryJson } from '../providers/types';

export interface FileSummaryRecord {
  cacheKey: string;
  uri: string;
  skeletonHash: string;
  promptVersion: string;
  schemaVersion: string;
  providerId: string;
  modelId?: string;
  summary: FileSummaryJson;
  generatedAt: string;
  latencyMs: number;
}

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

export interface ClusterRecord {
  evidenceHash: string;
  modelId: string;
  promptVersion: string;
  generatedAt: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  clusters: Array<{
    id: string;
    label: string;
    description: string;
    file_paths: string[];
  }>;
}

export class SummaryCache {
  private readonly byCacheKey = new Map<string, SummaryRecord>();
  private readonly pathToCacheKey = new Map<string, string>();
  private readonly fileByUri = new Map<string, FileSummaryRecord>();
  private readonly clusterByHash = new Map<string, ClusterRecord>();
  private readonly dirUri: vscode.Uri;
  private readonly fileDirUri: vscode.Uri;
  private readonly clusterDirUri: vscode.Uri;
  private initialized = false;

  constructor(context: vscode.ExtensionContext) {
    this.dirUri = vscode.Uri.joinPath(context.globalStorageUri, 'summaries');
    this.fileDirUri = vscode.Uri.joinPath(context.globalStorageUri, 'file-summaries');
    this.clusterDirUri = vscode.Uri.joinPath(context.globalStorageUri, 'clusters');
  }

  async init(): Promise<{ loaded: number; filesLoaded: number; clustersLoaded: number }> {
    if (this.initialized) {
      return {
        loaded: this.byCacheKey.size,
        filesLoaded: this.fileByUri.size,
        clustersLoaded: this.clusterByHash.size,
      };
    }
    this.initialized = true;
    for (const dir of [this.dirUri, this.fileDirUri, this.clusterDirUri]) {
      try {
        await vscode.workspace.fs.createDirectory(dir);
      } catch {
        // best-effort
      }
    }
    let loaded = 0;
    let filesLoaded = 0;
    let clustersLoaded = 0;
    const decoder = new TextDecoder();
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.dirUri);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dirUri, name));
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
      // ignore
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.fileDirUri);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.fileDirUri, name));
          const record = JSON.parse(decoder.decode(bytes)) as FileSummaryRecord;
          if (!record.cacheKey || !record.uri || !record.summary) continue;
          this.fileByUri.set(record.uri, record);
          filesLoaded++;
        } catch {
          // skip
        }
      }
    } catch {
      // ignore
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.clusterDirUri);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.clusterDirUri, name));
          const record = JSON.parse(decoder.decode(bytes)) as ClusterRecord;
          if (!record.evidenceHash || !Array.isArray(record.clusters)) continue;
          this.clusterByHash.set(record.evidenceHash, record);
          clustersLoaded++;
        } catch {
          // skip corrupt
        }
      }
    } catch {
      // ignore
    }
    return { loaded, filesLoaded, clustersLoaded };
  }

  getCluster(evidenceHash: string): ClusterRecord | undefined {
    return this.clusterByHash.get(evidenceHash);
  }

  async setCluster(record: ClusterRecord): Promise<void> {
    this.clusterByHash.set(record.evidenceHash, record);
    try {
      const fileUri = vscode.Uri.joinPath(this.clusterDirUri, `${record.evidenceHash}.json`);
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      await vscode.workspace.fs.writeFile(fileUri, bytes);
    } catch {
      // best-effort
    }
  }

  fileIdentity(args: {
    skeleton: string;
    providerId: string;
    promptVersion: string;
    schemaVersion: string;
    settingsProfile: string;
  }): { skeletonHash: string; cacheKey: string } {
    const skeletonHash = sha256(normalize(args.skeleton));
    const cacheKey = sha256(
      [
        'file',
        skeletonHash,
        args.providerId,
        args.promptVersion,
        args.schemaVersion,
        args.settingsProfile,
      ].join('\x1f'),
    );
    return { skeletonHash, cacheKey };
  }

  getFileByUri(uri: string): FileSummaryRecord | undefined {
    return this.fileByUri.get(uri);
  }

  async setFile(record: FileSummaryRecord): Promise<void> {
    this.fileByUri.set(record.uri, record);
    try {
      const safeName = sha256(record.uri).slice(0, 32);
      const fileUri = vscode.Uri.joinPath(this.fileDirUri, `${safeName}.json`);
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      await vscode.workspace.fs.writeFile(fileUri, bytes);
    } catch {
      // best-effort
    }
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
    this.fileByUri.clear();
    this.clusterByHash.clear();
    for (const dir of [this.dirUri, this.fileDirUri, this.clusterDirUri]) {
      try {
        await vscode.workspace.fs.delete(dir, { recursive: true });
      } catch {
        // best-effort
      }
      try {
        await vscode.workspace.fs.createDirectory(dir);
      } catch {
        // best-effort
      }
    }
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
