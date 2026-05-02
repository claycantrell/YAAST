// Standalone smoke test: actually calls the Anthropic API with the same prompt,
// schema, and message shape the extension uses, and verifies structured output.
// Run via: ANTHROPIC_API_KEY=... node out/test/smokeApi.js
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { SummarySchema, SYSTEM_PROMPT, buildUserMessage } from '../providers/prompt';

const SAMPLE_CODE = `export function buildIndex(items: User[]): Map<string, User> {
  const index = new Map<string, User>();
  for (const item of items) {
    if (item.id) index.set(item.id, item);
  }
  return index;
}`;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const model = process.env.SFM_MODEL ?? 'claude-haiku-4-5';
  const client = new Anthropic({ apiKey });

  const userMessage = buildUserMessage({
    languageId: 'typescript',
    symbolKind: 'Function',
    symbolPath: ['buildIndex'],
    signature: 'export function buildIndex(items: User[]): Map<string, User>',
    truncated: false,
    codeSlice: SAMPLE_CODE,
  });

  console.log(`[smoke] model=${model}`);
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
  console.log(`[smoke] ${elapsed}ms`);
  console.log(`[smoke] usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens} cache_read=${response.usage.cache_read_input_tokens ?? 0} cache_create=${response.usage.cache_creation_input_tokens ?? 0}`);
  console.log(`[smoke] stop_reason=${response.stop_reason}`);

  const parsed = response.parsed_output;
  if (!parsed) {
    console.error('[smoke] FAIL: no parsed_output');
    process.exit(1);
  }

  console.log('\n[smoke] parsed summary:');
  console.log(JSON.stringify(parsed, null, 2));

  // Sanity assertions.
  const failures: string[] = [];
  if (!parsed.headline || parsed.headline.length === 0) failures.push('empty headline');
  if (parsed.headline.length > 120) failures.push(`headline too long (${parsed.headline.length} chars)`);
  if (!parsed.purpose) failures.push('empty purpose');
  if (!Array.isArray(parsed.methods_used)) failures.push('methods_used not array');
  if (!['low', 'medium', 'high'].includes(parsed.confidence)) failures.push(`bad confidence: ${parsed.confidence}`);

  if (failures.length) {
    console.error('\n[smoke] FAILURES:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n[smoke] PASSED');
}

main().catch((err) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});
