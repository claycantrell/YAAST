// Smoke test: file-level summary call against the real Anthropic API.
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  FILE_SYSTEM_PROMPT,
  FileSummarySchema,
  buildFileUserMessage,
} from '../providers/prompt';

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.SFM_MODEL ?? 'claude-haiku-4-5';

  const filePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../../sample/demo.ts');
  const content = fs.readFileSync(filePath, 'utf8');

  const client = new Anthropic({ apiKey });
  console.log(`[smoke:file] model=${model} path=${filePath} (${content.length} chars)`);
  const start = Date.now();

  const response = await client.messages.parse({
    model,
    max_tokens: 1024,
    system: [
      { type: 'text', text: FILE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    output_config: { format: zodOutputFormat(FileSummarySchema) },
    messages: [
      {
        role: 'user',
        content: buildFileUserMessage({
          path: filePath,
          languageId: filePath.endsWith('.tsx') ? 'typescriptreact' : 'typescript',
          content,
          truncated: false,
        }),
      },
    ],
  });

  const elapsed = Date.now() - start;
  console.log(`[smoke:file] ${elapsed}ms in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  const parsed = response.parsed_output;
  if (!parsed) {
    console.error('[smoke:file] FAIL: no parsed_output');
    process.exit(1);
  }

  console.log('\n[smoke:file] file summary:');
  console.log(JSON.stringify(parsed, null, 2));

  const failures: string[] = [];
  if (!parsed.headline) failures.push('empty headline');
  if (parsed.headline.length > 120) failures.push(`headline too long (${parsed.headline.length})`);
  if (!parsed.overview) failures.push('empty overview');
  if (!Array.isArray(parsed.main_features) || parsed.main_features.length === 0) {
    failures.push('main_features empty or not array');
  }

  if (failures.length) {
    console.error('\n[smoke:file] FAILURES:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[smoke:file] PASSED');
}

main().catch((err) => {
  console.error('[smoke:file] error:', err);
  process.exit(1);
});
