#!/usr/bin/env node
// Regenerates the OpenAPI types into a temp file and fails if they differ from the
// committed src/generated/schema.ts. CI runs this (`npm run check:generated`) so the
// TypeScript types cannot drift from docs/api/openapi.json.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const committed = join(root, 'src/generated/schema.ts');
const dir = mkdtempSync(join(tmpdir(), 'agents-schema-'));
const fresh = join(dir, 'schema.ts');

// Same command as `npm run generate`, with the output redirected.
const command = pkg.scripts.generate.replace(/-o\s+\S+/, `-o ${JSON.stringify(fresh)}`);
const run = spawnSync(command, { cwd: root, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
if (run.status !== 0) {
  rmSync(dir, { recursive: true, force: true });
  console.error('check:generated: openapi-typescript failed');
  process.exit(run.status ?? 1);
}

const a = readFileSync(committed, 'utf8');
const b = readFileSync(fresh, 'utf8');
rmSync(dir, { recursive: true, force: true });
if (a === b) {
  console.log('check:generated: src/generated/schema.ts is up to date');
  process.exit(0);
}

const al = a.split('\n');
const bl = b.split('\n');
let line = 0;
while (line < al.length && line < bl.length && al[line] === bl[line]) line++;
console.error('check:generated: src/generated/schema.ts is stale; run `npm run generate` and commit the result.');
console.error(`first difference at line ${line + 1}:`);
console.error(`  committed: ${al[line] ?? '<end of file>'}`);
console.error(`  generated: ${bl[line] ?? '<end of file>'}`);
process.exit(1);
