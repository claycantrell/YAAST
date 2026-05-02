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
npm run build           # bundle to dist/extension.js
npm test                # run integration test (downloads VS Code on first run)
# F5 in VS Code to launch Extension Development Host
```

## Install into Cursor (or VS Code)

```bash
npm run install:cursor  # builds .vsix and installs into Cursor
# Or for VS Code:
npm run package
code --install-extension semantic-fold-mode.vsix --force
```

After install, restart Cursor/VS Code, then run **Cmd+Shift+P → "Semantic Fold Mode: Set Anthropic API Key"** to configure the key (stored in OS keychain via SecretStorage). The extension also falls back to `ANTHROPIC_API_KEY` from the environment, but apps launched from the Dock may not inherit your shell env, so the explicit command is more reliable.

## License

MIT
