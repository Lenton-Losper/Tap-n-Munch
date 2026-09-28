#!/usr/bin/env node
/**
 * Re-runnable mutation proof for the terminal variant guards (Sprint 2026-09-28 brief).
 *
 * For each mutation: apply ONE exact source edit (refused if the target text is not found exactly
 * once), print the mutated line back, run the variant suites, EXPECT RED, restore, and finally run
 * them once more on the restored tree and EXPECT GREEN. The source is restored in a finally block
 * even if jest crashes.
 *
 *   node scripts/variant-mutations.mjs            # all
 *   node scripts/variant-mutations.mjs M2         # one
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  'src/lib/__tests__/variantPricing.test.ts',
  'src/lib/__tests__/variantWireContract.test.ts',
  'src/components/__tests__/variantPickerRender.test.tsx',
];

const MUTATIONS = {
  M1: {
    what: 'buildRoundItems drops selectedVariants',
    file: 'src/lib/serviceRound.ts',
    from: `      ...(hasSelection(line.selectedVariants)
        ? {selectedVariants: {...line.selectedVariants}}
        : {}),
    });`,
    to: `      ...(false && hasSelection(line.selectedVariants)
        ? {selectedVariants: {...line.selectedVariants}}
        : {}),
    });`,
  },
  M2: {
    what: 'line merge key ignores the selection (cart and round)',
    file: 'src/lib/variantPricing.ts',
    from: `  if (entries.length === 0) {
    return menuItemId;
  }`,
    to: `  if (entries.length >= 0) {
    return menuItemId;
  }`,
  },
  M3: {
    what: 'add allowed with a required group missing',
    file: 'src/lib/variantPricing.ts',
    from: `    group => !group.required || canonical[group.name] !== undefined,`,
    to: `    group => true || !group.required || canonical[group.name] !== undefined,`,
  },
  M4: {
    what: 'POS sale omits X-FlashTap-Variant-Protocol',
    file: 'src/lib/api.ts',
    from: `        'x-idempotency-key': idempotencyKey,
        ...VARIANT_PROTOCOL_HEADERS,`,
    to: `        'x-idempotency-key': idempotencyKey,
        ...(false ? VARIANT_PROTOCOL_HEADERS : {}),`,
  },
  M5: {
    what: 'round send omits X-FlashTap-Variant-Protocol',
    file: 'src/lib/api.ts',
    // Indented two deeper since the merge with term-cancel: sendRound's fetch now sits in a try.
    from: `          'x-idempotency-key': params.idempotencyKey,
          ...VARIANT_PROTOCOL_HEADERS,`,
    to: `          'x-idempotency-key': params.idempotencyKey,
          ...(false ? VARIANT_PROTOCOL_HEADERS : {}),`,
  },
};

function runSuites() {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/jest/bin/jest.js'), ...SUITES, '--ci', '--colors=false'],
    {cwd: ROOT, encoding: 'utf8'},
  );
  const out = `${r.stdout}\n${r.stderr}`;
  const summary = out.split('\n').filter(l => /^Tests:/.test(l)).join(' ');
  const failed = out.split('\n').filter(l => /^\s+● /.test(l)).map(l => l.trim());
  return {green: r.status === 0, summary, failed: [...new Set(failed)]};
}

const wanted = process.argv.slice(2);
const ids = wanted.length ? wanted : Object.keys(MUTATIONS);
let ok = true;

for (const id of ids) {
  const m = MUTATIONS[id];
  const file = path.join(ROOT, m.file);
  const original = readFileSync(file, 'utf8');
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.error(`${id}: target found ${hits} times in ${m.file}; refusing`);
    ok = false;
    continue;
  }
  try {
    writeFileSync(file, original.replace(m.from, m.to));
    const mutatedLine = m.to.split('\n').find(l => /false|true \|\||>= 0/.test(l));
    const printed = readFileSync(file, 'utf8').split('\n').find(l => l === mutatedLine);
    console.log(`${id} (${m.what}) mutated line: ${printed ?? '<NOT FOUND>'}`);
    const res = runSuites();
    console.log(`${id}: ${res.green ? 'GREEN (mutation SURVIVED)' : 'RED (caught)'} ${res.summary}`);
    for (const f of res.failed) console.log(`   ${f}`);
    if (res.green || !printed) ok = false;
  } finally {
    writeFileSync(file, original);
  }
}

const restored = runSuites();
console.log(`restored: ${restored.green ? 'GREEN' : 'RED'} ${restored.summary}`);
if (!restored.green) ok = false;
process.exit(ok ? 0 : 1);
