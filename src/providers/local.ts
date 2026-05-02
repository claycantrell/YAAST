import * as vscode from 'vscode';
import type { SummaryJson, SummaryProvider, SummaryRequest } from './types';

export class LocalProvider implements SummaryProvider {
  readonly id = 'local';

  constructor(_context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

  async isAvailable(): Promise<boolean> {
    const endpoint = vscode.workspace.getConfiguration('semanticFoldMode').get<string>('local.endpoint', '');
    return !!endpoint;
  }

  async summarize(_req: SummaryRequest, _token: vscode.CancellationToken): Promise<SummaryJson> {
    this.output.appendLine('local summarize: not yet implemented');
    throw new Error('LocalProvider.summarize not yet implemented');
  }
}
