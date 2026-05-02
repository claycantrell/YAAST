import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { SummaryJson } from '../providers/types';

export interface SummaryRecord {
  cacheKey: string;
  targetId: string;
  semanticHash: string;
  sourceHash: string;
  promptVersion: string;
  schemaVersion: string;
  providerId: string;
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
  private readonly memory = new Map<string, SummaryRecord>();

  constructor(private readonly context: vscode.ExtensionContext) {}

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
      [semanticHash, args.providerId, args.promptVersion, args.schemaVersion, args.settingsProfile].join('\x1f'),
    );
    return { sourceHash, semanticHash, cacheKey };
  }

  get(cacheKey: string): SummaryRecord | undefined {
    return this.memory.get(cacheKey);
  }

  set(record: SummaryRecord): void {
    this.memory.set(record.cacheKey, record);
  }

  async clear(): Promise<void> {
    this.memory.clear();
    await this.context.workspaceState.update('semanticFoldMode.cacheIndex', undefined);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
