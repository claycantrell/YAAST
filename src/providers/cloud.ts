import * as vscode from 'vscode';
import type { SummaryJson, SummaryProvider, SummaryRequest } from './types';

export class CloudProvider implements SummaryProvider {
  readonly id = 'cloud';

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

  async isAvailable(): Promise<boolean> {
    const key = await this.context.secrets.get('semanticFoldMode.cloud.apiKey');
    return !!key;
  }

  async summarize(_req: SummaryRequest, _token: vscode.CancellationToken): Promise<SummaryJson> {
    this.output.appendLine('cloud summarize: not yet implemented');
    throw new Error('CloudProvider.summarize not yet implemented');
  }
}
