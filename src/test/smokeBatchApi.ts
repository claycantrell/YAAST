// Standalone smoke test for the batched summarization path.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  BATCH_SYSTEM_PROMPT,
  BatchSummarySchema,
  buildBatchUserMessage,
  type BatchItem,
} from '../providers/prompt';

const ITEMS: BatchItem[] = [
  {
    id: '0',
    languageId: 'typescript',
    symbolKind: 'Function',
    symbolPath: ['buildIndex'],
    signature: 'export function buildIndex(items: User[]): Map<string, User>',
    truncated: false,
    codeSlice: `export function buildIndex(items: User[]): Map<string, User> {
  const index = new Map<string, User>();
  for (const item of items) {
    if (item.id) index.set(item.id, item);
  }
  return index;
}`,
  },
  {
    id: '1',
    languageId: 'typescript',
    symbolKind: 'Function',
    symbolPath: ['tokenize'],
    signature: 'export function tokenize(text: string): string[]',
    truncated: false,
    codeSlice: `export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\\s+/).filter(Boolean);
}`,
  },
  {
    id: '2',
    languageId: 'typescript',
    symbolKind: 'Method',
    symbolPath: ['UserService', 'findById'],
    signature: 'async findById(id: string): Promise<User | undefined>',
    truncated: false,
    codeSlice: `async findById(id: string): Promise<User | undefined> {
  if (this.cache.has(id)) return this.cache.get(id);
  const user = await fetchUser(id);
  if (user) this.cache.set(id, user);
  return user;
}`,
  },
];

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.SFM_MODEL ?? 'claude-haiku-4-5';
  const client = new Anthropic({ apiKey });

  console.log(`[smoke:batch] model=${model} n=${ITEMS.length}`);
  const start = Date.now();

  const response = await client.messages.parse({
    model,
    max_tokens: 256 * ITEMS.length + 256,
    system: [
      { type: 'text', text: BATCH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    output_config: { format: zodOutputFormat(BatchSummarySchema) },
    messages: [{ role: 'user', content: buildBatchUserMessage(ITEMS) }],
  });

  const elapsed = Date.now() - start;
  console.log(`[smoke:batch] ${elapsed}ms`);
  console.log(`[smoke:batch] usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  const parsed = response.parsed_output;
  if (!parsed) {
    console.error('[smoke:batch] FAIL: no parsed_output');
    process.exit(1);
  }

  console.log(`[smoke:batch] returned ${parsed.summaries.length} summaries`);
  const failures: string[] = [];
  const ids = new Set(ITEMS.map((i) => i.id));
  const seenIds = new Set<string>();
  for (const s of parsed.summaries) {
    seenIds.add(s.id);
    if (!ids.has(s.id)) failures.push(`unknown id in response: ${s.id}`);
    console.log(`  - id=${s.id} headline=${JSON.stringify(s.headline)}`);
  }
  for (const i of ITEMS) {
    if (!seenIds.has(i.id)) failures.push(`missing id ${i.id} (${i.symbolPath.join('.')})`);
  }

  if (failures.length) {
    console.error('\n[smoke:batch] FAILURES:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[smoke:batch] PASSED');
}

main().catch((err) => {
  console.error('[smoke:batch] error:', err);
  process.exit(1);
});
