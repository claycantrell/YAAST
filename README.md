# Semantic Fold Mode

A VS Code / Cursor extension that folds code symbols into compact, AI-summarized virtual headers — so a function collapses to one line that tells you *what it does*, not just `function foo(...) { ... }`.

Built on top of VS Code's native symbol and folding providers, with text decorations for headers, hover cards for detail, and CodeLens for actions. Powered by the Anthropic Claude API (default model: `claude-haiku-4-5`).

## Install

Download the latest `semantic-fold-mode.vsix` from the [Releases page](https://github.com/claycantrell/semantic-fold-mode/releases/latest), then:

**Cursor:**
```bash
cursor --install-extension /path/to/semantic-fold-mode.vsix
```

**VS Code:**
```bash
code --install-extension /path/to/semantic-fold-mode.vsix
```

Or in either editor: **Extensions sidebar → ⋯ menu → "Install from VSIX…"**.

After install, run **Cmd+Shift+P → "Semantic Fold Mode: Set Anthropic API Key"** and paste your `sk-ant-...` key. It's stored in the OS keychain via VS Code's SecretStorage — never written to disk in plaintext, never synced.

You'll need an API key from <https://console.anthropic.com>.

## How it works

1. Open a code file. Each function/method/class is detected via VS Code's symbol provider.
2. Click the top-of-file CodeLens **`✨ Generate summaries for this file (N)`**. One batched API call summarizes all eligible symbols.
3. Each function's body is folded behind a virtual header showing the AI-generated headline. Hover for purpose, methods used, techniques, risks, and confidence.
4. Edit a function — only that function's summary marks itself out-of-date. Click the inline lens or the regenerate link in its hover card to refresh just that one. Other functions stay untouched.
5. Summaries persist on disk (`globalStorage`), so reopening files later doesn't re-spend tokens.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `semanticFoldMode.enabled` | `true` | Master toggle. |
| `semanticFoldMode.provider` | `cloud` | `cloud` (Anthropic), `static` (no AI), `vscode-lm` and `local` are stubs. |
| `semanticFoldMode.cloud.model` | `claude-haiku-4-5` | Any Claude model id. |
| `semanticFoldMode.cloud.batchSize` | `30` | Max symbols per batched call. |
| `semanticFoldMode.cloud.maxBatchInputChars` | `60000` | Char budget per batch. Splits if exceeded. |
| `semanticFoldMode.autoFoldOnOpen` | `true` | Auto-collapse function bodies on open. |
| `semanticFoldMode.includeKinds` | `["Function","Method","Class"]` | Symbol kinds to summarize. |
| `semanticFoldMode.concurrency` | `3` | Max in-flight summary calls. |

## Architecture

```
DocumentSymbol + FoldingRange  →  DrawerTarget (with skeleton hash for containers)
                                          ↓
                          SummaryProvider.summarizeBatch (Claude / static)
                                          ↓
                  Decorations (header) + Hover (detail + regenerate link)
                  CodeLens (top-of-file generate, per-symbol regenerate when needed)
                  SummaryCache (in-memory + on-disk JSON, keyed by content hash)
```

Containers (Class, Interface, Namespace, Module, Enum) are hashed on a *skeleton* — the declaration line plus each direct child's declaration line — instead of the full body. So editing a method body invalidates the method but not its parent class.

## Costs

Default provider is Claude Haiku 4.5. Rough estimates:

- ~$0.02 per file with 30 functions in a single batched call.
- Disk cache means each unique chunk of code is paid for at most once.
- Editing one function regenerates only that function (~$0.001), not the page.

## Development

```bash
git clone https://github.com/claycantrell/semantic-fold-mode
cd semantic-fold-mode
npm install
npm run build           # bundle into dist/extension.js
npm test                # integration test (downloads VS Code on first run)
# F5 in VS Code/Cursor to launch the Extension Development Host
```

To package and install locally:

```bash
npm run install:cursor  # builds .vsix and installs into Cursor
npm run package         # just builds the .vsix without installing
```

## Releasing

Tag-driven via GitHub Actions. Bump `version` in `package.json`, then:

```bash
git tag v0.1.1
git push --tags
```

The workflow at `.github/workflows/release.yml` builds and attaches `semantic-fold-mode.vsix` to a new GitHub Release.

## License

MIT
