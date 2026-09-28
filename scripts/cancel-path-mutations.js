#!/usr/bin/env node
/**
 * MUTATION CHECKS FOR THE CANCELLATION PATH. (Sprint 2026-09-28 brief — Riviera #160.)
 *
 * Each entry breaks ONE guard on ONE exact line, prints the line it changed, runs the test that is
 * supposed to catch it, and expects RED. The file is restored whatever happens. A mutation whose
 * `find` text is absent or ambiguous is reported as an ERROR, never as a pass — an edit that
 * landed nowhere proves nothing.
 *
 *   node scripts/cancel-path-mutations.js            # all
 *   node scripts/cancel-path-mutations.js M-c        # one
 *
 * Exit code 0 only when every selected mutation went RED and the suite is GREEN again afterwards.
 */
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JEST = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const MUTATIONS = [
  {
    id: 'M-a1',
    defect: 'a 200 with the line absent from applied is treated as confirmed',
    file: 'src/lib/amendTabLines.ts',
    find: "  const applied = result.applied.find(row => row.line_id === lineId);",
    replace:
      "  const applied = result.applied.find(row => row.line_id === lineId) ?? (result.refused.some(r => r.line_id === lineId) ? undefined : {line_id: lineId, action: 'voided' as const});",
    test: 'src/components/__tests__/amendSheetOutcomes.test.tsx',
    name: 'MUTATION GUARD \\(a\\)',
  },
  {
    id: 'M-a2',
    defect: 'the sheet closes after a request (closing read as success)',
    file: 'src/components/AmendLineSheet.tsx',
    find: '        setVerdict(\n          verdictFor(',
    replace: '        onClose();\n        setVerdict(\n          verdictFor(',
    test: 'src/components/__tests__/amendSheetOutcomes.test.tsx',
    name: 'MUTATION GUARD \\(a\\)',
  },
  {
    id: 'M-b',
    defect: 'the sheet shows the line as removed before the server answers (optimistic)',
    file: 'src/components/AmendLineSheet.tsx',
    find: '      const voiding = isReduction(line.quantity, nextQuantity);\n',
    replace:
      "      const voiding = isReduction(line.quantity, nextQuantity);\n      setVerdict({tone: 'success', title: `${line.name_snapshot} removed — it is off the bill.`});\n",
    test: 'src/components/__tests__/amendSheetOutcomes.test.tsx',
    name: 'MUTATION GUARD \\(b\\)',
  },
  {
    id: 'M-c',
    defect: 'the basket stays editable after an unknown round outcome',
    file: 'src/context/ServiceSessionContext.tsx',
    find: '  const locked = () => lockRef.current != null;',
    replace: '  const locked = () => false;',
    test: 'src/screens/__tests__/roundSendUnknownOutcome.test.tsx',
    name: 'MUTATION GUARD \\(c\\)',
  },
  {
    id: 'M-d',
    defect: 'a 401 PIN_MISMATCH is refreshed and re-POSTed (two lockout strikes)',
    file: 'src/lib/api.ts',
    find: "  if (err && err.status === 401 && err.code !== 'PIN_MISMATCH') {\n    const newToken",
    replace: '  if (err && err.status === 401) {\n    const newToken',
    test: 'src/lib/__tests__/cancelPathWireContract.test.ts',
    name: '401 PIN_MISMATCH',
  },
  {
    id: 'M-e',
    defect: 'the amend call has no deadline',
    file: 'src/lib/api.ts',
    find: '    {timeoutMs: AMEND_TIMEOUT_MS},',
    replace: '    undefined,',
    test: 'src/lib/__tests__/cancelPathWireContract.test.ts',
    name: 'a TIMEOUT rejects',
  },
  {
    id: 'M-f',
    defect: 'a round 5xx is reported as a plain failure instead of an unknown outcome',
    file: 'src/lib/api.ts',
    find: '  if (response.status >= 500) {\n    throw new RoundOutcomeUnknownError(',
    replace: '  if (false && response.status >= 500) {\n    throw new RoundOutcomeUnknownError(',
    test: 'src/lib/__tests__/cancelPathWireContract.test.ts',
    name: 'is an UNKNOWN outcome',
  },
  {
    id: 'M-g',
    defect: 'the sheet can be dismissed while a request is in flight',
    file: 'src/components/AmendLineSheet.tsx',
    find: '    if (inFlightRef.current) {\n      return;\n    }\n    reset();\n    onClose();',
    replace: '    reset();\n    onClose();',
    test: 'src/components/__tests__/amendSheetOutcomes.test.tsx',
    name: 'back button and Leave-it do nothing while busy',
  },
  {
    id: 'M-h',
    defect: 'the tab is not re-read after an amend outcome',
    file: 'src/components/AmendLineSheet.tsx',
    find: '        // After ANY outcome. The screen re-reads what the server has; nothing is patched here.\n        onRefetchRef.current();',
    replace: '        // After ANY outcome. The screen re-reads what the server has; nothing is patched here.',
    test: 'src/components/__tests__/amendSheetOutcomes.test.tsx',
    name: 'keeps the sheet open, re-reads the tab',
  },
  {
    id: 'M-i',
    defect: 'a malformed 200 body is defaulted to empty arrays (well formed)',
    file: 'src/lib/amendTabLines.ts',
    find: "  if (!isObject(data) || !Array.isArray(data.applied) || !Array.isArray(data.refused)) {",
    replace: '  if (!isObject(data)) {',
    test: 'src/lib/__tests__/amendOutcome.test.ts',
    name: 'NOT well formed',
  },
  {
    id: 'M-j',
    defect: 'a cooked line is not tappable',
    file: 'src/screens/ServiceTableScreen.tsx',
    find: '  const tappable = onEdit != null;',
    replace: "  const tappable = onEdit != null && !line.is_voided && line.kitchen_state !== 'cooked';",
    test: 'src/screens/__tests__/serviceTableCookedLineTap.test.tsx',
    name: 'COOKED line is pressable',
  },
];

function runJest(test, name) {
  const args = [JEST, test, '--silent'];
  if (name) {
    args.push('-t', name);
  }
  const r = spawnSync(process.execPath, args, {cwd: ROOT, encoding: 'utf8'});
  const out = `${r.stdout}\n${r.stderr}`;
  const summary = (out.match(/Tests:.*$/m) || ['Tests: (no summary)'])[0];
  return {code: r.status, summary};
}

const only = process.argv.slice(2);
const selected = only.length ? MUTATIONS.filter(m => only.includes(m.id)) : MUTATIONS;
let failed = 0;

for (const m of selected) {
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    console.log(`${m.id} ERROR: find text occurs ${count} times in ${m.file}`);
    failed += 1;
    continue;
  }
  const mutated = original.replace(m.find, m.replace);
  try {
    fs.writeFileSync(abs, mutated);
    const at = mutated.indexOf(m.replace);
    const lineNo = mutated.slice(0, at).split('\n').length;
    console.log(`${m.id} [${m.defect}]`);
    const findLines = new Set(m.find.split('\n'));
    const changed = m.replace.split('\n').filter(l => l.trim() && !findLines.has(l));
    const removed = m.find.split('\n').filter(l => l.trim() && !m.replace.split('\n').includes(l));
    console.log(`  ${m.file}:${lineNo}`);
    for (const l of removed) {
      console.log(`    - ${l.trim()}`);
    }
    for (const l of changed) {
      console.log(`    + ${l.trim()}`);
    }
    const r = runJest(m.test, m.name);
    const red = r.code !== 0 && /failed/.test(r.summary);
    console.log(`  ${red ? 'RED (caught)' : 'GREEN (NOT CAUGHT)'} — ${r.summary}`);
    if (!red) {
      failed += 1;
    }
  } finally {
    fs.writeFileSync(abs, original);
  }
}

const tests = [...new Set(selected.map(m => m.test))];
for (const t of tests) {
  const r = runJest(t);
  console.log(`restored ${t}: ${r.code === 0 ? 'GREEN' : 'RED'} — ${r.summary}`);
  if (r.code !== 0) {
    failed += 1;
  }
}
process.exit(failed ? 1 : 0);
