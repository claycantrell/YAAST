# Call Graph (experimental)

Read-only workspace-level call graph as a navigation surface, layered on top of YAAST's existing AI summaries.

## Data model

```ts
interface GraphNode {
  id: string;            // pathKey (uri#a.b.c) — same identity as DrawerTarget
  uri: string;
  symbolPath: string[];
  name: string;
  kind: SymbolKind;
  headline?: string;     // from SummaryCache, undefined if not yet generated
  filePath: string;      // for grouping
}

interface GraphEdge {
  source: string;        // caller pathKey
  target: string;        // callee pathKey
  count: number;         // how many call sites in caller's body
}

interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt: string;
  scannedFiles: number;
  unresolvedCallees: string[];   // identifiers we couldn't map to a node
}
```

## Indexing

1. Enumerate workspace files matching `includeKinds` languages (TS/JS/TSX/JSX/Python for v1).
2. For each file: `executeDocumentSymbolProvider` → flatten → keep Function/Method/Class kinds.
3. Build a `Map<name, GraphNode[]>` for callee resolution.
4. For each function: take its `fullRange` slice, regex-extract `\b([A-Za-z_$][\w$]*)\s*\(`, drop keywords/built-ins, look up in the name map.
5. Edges added when callee resolves to ≥1 node. Multiple matches → pick same-file first, then unique workspace match, otherwise drop (ambiguous).

Indexing is on-demand only — opening the graph triggers it. No background work.

## Rendering

Webview at the side, Cytoscape.js. Default layout: `cose` (force-directed). Toggle to `dagre` for hierarchical. File-based grouping via Cytoscape compound nodes.

## Out of v1

- TS compiler API for type-aware resolution
- Cross-language edges
- Live updates on edit
- Data-flow edges
- Persistence — recompute on each open
