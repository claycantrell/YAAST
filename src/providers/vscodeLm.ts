import * as vscode from 'vscode';
import type { SummaryJson, SummaryProvider, SummaryRequest } from './types';

export class VsCodeLmProvider implements SummaryProvider {
  readonly id = 'vscode-lm';

  constructor(_context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

  async isAvailable(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return models.length > 0;
    } catch {
      return false;
    }
  }

  async summarize(_req: SummaryRequest, _token: vscode.CancellationToken): Promise<SummaryJson> {
    this.output.appendLine('vscode-lm summarize: not yet implemented');
    throw new Error('VsCodeLmProvider.summarize not yet implemented');
  }
}
