import type * as vscode from 'vscode';
import type { SummaryJson, SummaryProvider, SummaryRequest } from './types';

export class StaticProvider implements SummaryProvider {
  readonly id = 'static';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async summarize(req: SummaryRequest, _token: vscode.CancellationToken): Promise<SummaryJson> {
    const calls = (req.staticCalls ?? []).slice(0, 4);
    const headlineParts = [req.symbolPath.at(-1) ?? 'symbol'];
    if (calls.length) headlineParts.push(`calls ${calls.slice(0, 2).join(', ')}`);
    return {
      headline: headlineParts.join(' · ').slice(0, 72),
      purpose: req.signature.slice(0, 120),
      methods_used: calls,
      techniques: [],
      risks: [],
      confidence: 'low',
    };
  }
}
