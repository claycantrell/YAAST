import * as vscode from 'vscode';
import type { SummaryProvider } from './types';
import { VsCodeLmProvider } from './vscodeLm';
import { CloudProvider } from './cloud';
import { LocalProvider } from './local';
import { StaticProvider } from './static';

export class SummaryProviderRegistry {
  private readonly providers: Record<string, SummaryProvider>;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.providers = {
      'vscode-lm': new VsCodeLmProvider(context, output),
      cloud: new CloudProvider(context, output),
      local: new LocalProvider(context, output),
      static: new StaticProvider(),
    };
  }

  get(id: string): SummaryProvider {
    return this.providers[id] ?? this.providers.static;
  }

  active(): SummaryProvider {
    const id = vscode.workspace.getConfiguration('semanticFoldMode').get<string>('provider', 'vscode-lm');
    return this.get(id);
  }
}
