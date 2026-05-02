# Semantic Fold Mode

A VS Code extension that folds code symbols into compact, AI-summarized virtual headers — so a function collapses to one line that tells you *what it does*, not just `function foo(...) { ... }`.

Built on top of VS Code's native symbol and folding providers, with text decorations for headers, hovers for detail, and CodeLens for actions.

## Status

Pre-MVP scaffold. See `deep-research-report-3.md` for the full design.

## Architecture (one-liner)

```
DocumentSymbol + FoldingRange  →  DrawerTarget  →  SummaryProvider (LM | cloud | local | static)
                                                 ↓
                                Decorations + Hover + CodeLens
```

## Roadmap

1. **Foundation** — scaffold, settings, provider interface (this commit).
2. **Indexing** — `collectDrawerTargets` from existing providers, Tree-sitter fallback.
3. **Rendering** — virtual headers via decorations, hover cards, CodeLens actions.
4. **Summaries + cache** — VS Code LM / cloud / local backends, JSON schema validation, repair pass, stale-while-revalidate cache.
5. **Reactivity + privacy** — debounce, cancellation, SecretStorage, Workspace Trust gating.
6. **Hardening + release** — tests, eval corpus, telemetry, Marketplace package.

## Development

```bash
npm install
npm run build
# F5 in VS Code to launch Extension Development Host
```

## License

MIT
