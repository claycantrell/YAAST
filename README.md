# YAAST — Yet Another AI Summary Tool

A VS Code / Cursor extension for navigating unfamiliar codebases

YAAST puts an AI-generated headline above every function, method, and class — and a file-level overview at the top of every file. Headers are inline, hover-on-demand, persisted to disk, and only regenerate when the underlying code changes.

There are a lot of AI summary tools. This one happens to be useful for *navigating* code rather than chatting about it.

## Install

Grab the latest `yaast.vsix` from [Releases](https://github.com/claycantrell/YAAST/releases/latest).

**Cursor:**
```bash
cursor --install-extension /path/to/yaast.vsix
```

**VS Code:**
```bash
code --install-extension /path/to/yaast.vsix
```

Or in either editor: **Extensions sidebar → ⋯ menu → "Install from VSIX…"**.

After install, run **`Cmd+Shift+P → "Semantic Fold Mode: Set Anthropic API Key"`** and paste your `sk-ant-...` key. It's stored in the OS keychain via SecretStorage — never written to disk in plaintext, never synced.

You'll need an API key from [console.anthropic.com](https://console.anthropic.com).

## How to use it

1. Open any code file. You'll see deterministic headers (`function buildIndex`, etc.) above each symbol, plus a top-of-file CodeLens: **`✨ Generate summaries for this file (N)`**. Click it.
2. One batched API call summarizes everything. Land in ~5–10s.
3. The 📘 banner at the top of the file shows the file's headline. Hover the banner (in the leading whitespace) for the full overview — purpose, main features, regenerate link.
4. Each function gets a `⟪ AI headline ⟫` inline. Hover the inline text for the full card — purpose, methods used, techniques, risks, confidence.
5. Edit a function. Only that function marks itself out-of-date. The class containing it stays fresh (we hash containers on their skeleton, not their full body). Click the inline lens to regenerate just that one.

## What's good about it

- **Ambient, not on-demand.** Summaries are already there when you open a file. 
- **Persistent.** Every summary lives on disk, keyed by content hash. Reopen the file later, no re-spend.
- **Selective regeneration.** Editing one function only invalidates that function. The page-level "regenerate" button only re-summarizes stale items.
- **Batched.** Up to 30 symbols per API call. ~50% input-token saving vs. one-by-one. Cap configurable.
- **Native to the editor.** Built on VS Code's symbol/folding/decoration/codelens APIs. No webviews, no chat panel.

## What it's not (yet)

- **Not a chatbot.** Doesn't answer questions about your code.
- **Not perfect.** AI summaries can be confidently wrong. The `Confidence: low/medium/high` field helps, but it's also AI-generated.
- **Not for secret code.** Source goes to Anthropic. Don't point it at code you can't share with a third party. (A local-Ollama provider is stubbed for the future.)
- **Not yet for non-developers.** Lives only in VS Code / Cursor. The summary engine could power a web UI for non-IDE readers, but that's not built.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `semanticFoldMode.enabled` | `true` | Master toggle. |
| `semanticFoldMode.provider` | `cloud` | `cloud` (Anthropic), `static` (no AI), `vscode-lm` and `local` are stubs. |
| `semanticFoldMode.cloud.model` | `claude-haiku-4-5` | Any Claude model id (`claude-sonnet-4-6`, `claude-opus-4-7`, etc.) |
| `semanticFoldMode.cloud.batchSize` | `30` | Max symbols per batched call. |
| `semanticFoldMode.cloud.maxBatchInputChars` | `60000` | Char budget per batch. Splits if exceeded. |
| `semanticFoldMode.autoFoldOnOpen` | `true` | Auto-collapse function bodies on open. |
| `semanticFoldMode.includeKinds` | `["Function","Method","Class"]` | Symbol kinds to summarize. |
| `semanticFoldMode.concurrency` | `3` | Max in-flight summary calls. |

## Costs

Default provider is Claude Haiku 4.5. Rough numbers:

- ~$0.02 per file with 30 functions in a single batched call.
- Disk cache means each unique chunk of code is paid for at most once.
- Editing one function regenerates only that function (~$0.001), not the page.

## Development

```bash
git clone https://github.com/claycantrell/YAAST
cd YAAST
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

The workflow at `.github/workflows/release.yml` builds and attaches `yaast.vsix` to a new GitHub Release.

## License

MIT
