import type * as vscode from 'vscode';

export interface SummaryJson {
  headline: string;
  purpose: string;
  methods_used: string[];
  techniques: string[];
  risks: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface SummaryRequest {
  languageId: string;
  symbolKind: string;
  symbolPath: string[];
  signature: string;
  containerSignature?: string;
  staticCalls?: string[];
  visibleImports?: string[];
  truncated: boolean;
  codeSlice: string;
}

export interface BatchSummaryItem extends SummaryRequest {
  id: string;
}

export interface BatchSummaryResult {
  id: string;
  summary: SummaryJson;
}

export interface FileSummaryRequest {
  path: string;
  languageId: string;
  content: string;
  truncated: boolean;
}

export interface FileSummaryJson {
  headline: string;
  overview: string;
  main_features: string[];
}

export interface SummaryProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  summarize(req: SummaryRequest, token: vscode.CancellationToken): Promise<SummaryJson>;
  summarizeBatch?(
    items: BatchSummaryItem[],
    token: vscode.CancellationToken,
  ): Promise<BatchSummaryResult[]>;
  summarizeFile?(
    req: FileSummaryRequest,
    token: vscode.CancellationToken,
  ): Promise<FileSummaryJson>;
}
