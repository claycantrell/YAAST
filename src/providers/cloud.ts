import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { SummaryJson, SummaryProvider, SummaryRequest } from './types';

const SECRET_KEY = 'semanticFoldMode.anthropic.apiKey';

const SummarySchema = z.object({
  headline: z.string(),
  purpose: z.string(),
  methods_used: z.array(z.string()),
  techniques: z.array(z.string()),
  risks: z.array(z.string()),
  confidence: z.enum(['low', 'medium', 'high']),
});

const SYSTEM_PROMPT = `You summarize a single code symbol for an IDE drawer UI.

Return a single JSON object that conforms exactly to the supplied schema.
Base every claim only on the supplied code and metadata.
Do not invent runtime behavior, performance characteristics, or dependencies.
Prefer short, concrete phrasing suitable for editor UI.

Field guidance:
- "headline" reads like a compact virtual header (<= 72 chars, no trailing period).
- "purpose" is one short sentence (<= 120 chars).
- "methods_used" lists direct callees, helpers, or APIs visible in the code (max 6).
- "techniques" describes implementation patterns, not generic fluff (max 5).
- "risks" mentions caveats only if supported by the code (max 3).
- "confidence" is "low" | "medium" | "high".
- Do not repeat the symbol name in "headline" unless it improves clarity.
- If evidence is insufficient, use empty arrays and lower confidence.`;

export class CloudProvider implements SummaryProvider {
  readonly id = 'cloud';

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

  async isAvailable(): Promise<boolean> {
    const key = await this.context.secrets.get(SECRET_KEY);
    return !!key;
  }

  async summarize(req: SummaryRequest, _token: vscode.CancellationToken): Promise<SummaryJson> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) throw new Error('No Anthropic API key set. Run "Semantic Fold Mode: Set Anthropic API Key".');

    const cfg = vscode.workspace.getConfiguration('semanticFoldMode');
    const model = cfg.get<string>('cloud.model', 'claude-haiku-4-5');

    const client = new Anthropic({ apiKey });

    const userMessage = buildUserMessage(req);
    const start = Date.now();

    const response = await client.messages.parse({
      model,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: { format: zodOutputFormat(SummarySchema) },
      messages: [{ role: 'user', content: userMessage }],
    });

    const elapsed = Date.now() - start;
    const usage = response.usage;
    this.output.appendLine(
      `[cloud] ${req.symbolPath.join('.')} ${elapsed}ms in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0}`,
    );

    const parsed = response.parsed_output;
    if (!parsed) throw new Error('Anthropic response did not parse against the schema');
    return parsed as SummaryJson;
  }

  static async setApiKey(context: vscode.ExtensionContext): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: 'Anthropic API key (sk-ant-...)',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-api03-...',
    });
    if (!value) return;
    await context.secrets.store(SECRET_KEY, value.trim());
    vscode.window.showInformationMessage('Anthropic API key saved.');
  }
}

function buildUserMessage(req: SummaryRequest): string {
  const lines = [
    'Generate a compact summary for one code symbol.',
    '',
    'Metadata:',
    `language: ${req.languageId}`,
    `symbol_kind: ${req.symbolKind}`,
    `symbol_path: ${JSON.stringify(req.symbolPath)}`,
    `signature: ${req.signature}`,
  ];
  if (req.containerSignature) lines.push(`container_signature: ${req.containerSignature}`);
  if (req.staticCalls?.length) lines.push(`static_calls: ${JSON.stringify(req.staticCalls)}`);
  if (req.visibleImports?.length) lines.push(`visible_imports: ${JSON.stringify(req.visibleImports)}`);
  lines.push(`truncated: ${req.truncated}`);
  lines.push('', 'Code:', req.codeSlice);
  return lines.join('\n');
}
