import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { SummaryJson, SummaryProvider, SummaryRequest } from './types';
import { SummarySchema, SYSTEM_PROMPT, buildUserMessage } from './prompt';

const SECRET_KEY = 'semanticFoldMode.anthropic.apiKey';

export class CloudProvider implements SummaryProvider {
  readonly id = 'cloud';

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

  async isAvailable(): Promise<boolean> {
    return !!(await this.resolveApiKey());
  }

  private async resolveApiKey(): Promise<string | undefined> {
    const stored = await this.context.secrets.get(SECRET_KEY);
    if (stored) return stored;
    const env = process.env.ANTHROPIC_API_KEY;
    return env && env.length > 0 ? env : undefined;
  }

  async summarize(req: SummaryRequest, _token: vscode.CancellationToken): Promise<SummaryJson> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new Error('No Anthropic API key set. Run "Semantic Fold Mode: Set Anthropic API Key" or export ANTHROPIC_API_KEY.');

    const cfg = vscode.workspace.getConfiguration('semanticFoldMode');
    const model = cfg.get<string>('cloud.model', 'claude-haiku-4-5');

    const client = new Anthropic({ apiKey });
    const userMessage = buildUserMessage(req);
    const start = Date.now();

    const response = await client.messages.parse({
      model,
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
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
