import type * as vscode from 'vscode';

export interface GraphNode {
  id: string;
  uri: string;
  filePath: string;
  symbolPath: string[];
  name: string;
  kind: vscode.SymbolKind;
  headline?: string;
  signature?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  count: number;
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  scannedFiles: number;
  unresolvedCallees: { caller: string; callee: string }[];
  builtAt: string;
  durationMs: number;
}
