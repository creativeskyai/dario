// Unit tests for src/subagent.ts (v3.26, direction #2 — CC sub-agent hook).
// Covers the pure helpers (buildSubagentFile, computeSubagentStatus) plus a
// round-trip of install / loadStatus / remove against a temp HOME pointing
// into the OS temp directory. The filesystem round-trip is kept narrow —
// one create, one read, one remove — so the test stays fast and
// sandbox-safe on Windows / macOS / Linux.

import { installSubagent, removeSubagent, loadSubagentStatus, buildSubagentFile, computeSubagentStatus, getSubagentPath, SUBAGENT_NAME, SUBAGENT_FILENAME } from '../dist/subagent.js';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ======================================================================
//  buildSubagentFile — frontmatter + version marker
// ======================================================================
header('buildSubagentFile — pinned structure');
{
  const body = buildSubagentFile('9.9.9');
  check('starts with --- frontmatter delimiter', body.startsWith('---\n'));
  check('contains a name: frontmatter field', /^name: dario$/m.test(body));
  check('description present in frontmatter', /^description: .+/m.test(body));
  check('tools line restricts to Bash + Read', /^tools: Bash, Read$/m.test(body));
  check('version marker embeds the passed version', body.includes('<!-- dario-sub-agent-version: 9.9.9 -->'));
  check('mentions dario doctor as a safe operation', body.includes('dario doctor'));
  check('calls out that dario proxy must not be run from the sub-agent', body.includes('dario proxy'));
  check('warns against dumping credentials', /credential|bearer|token/i.test(body));
}

// ======================================================================
//  buildSubagentFile — deterministic / idempotent
// ======================================================================
header('buildSubagentFile — pure over its version argument');
{
  const a = buildSubagentFile('1.2.3');
  const b = buildSubagentFile('1.2.3');
  check('same version → byte-identical output', a === b);

  const c = buildSubagentFile('4.5.6');
  check('different version → different output', a !== c);
  check('different version → only version marker changes', a.replace('1.2.3', '4.5.6') === c);
}

// ======================================================================
//  computeSubagentStatus — file absent
// ======================================================================
header('computeSubagentStatus — file absent → not installed');
{
  const s = computeSubagentStatus('/fake/path', false, null, true, '3.26.0');
  check('installed is false', s.installed === false);
  check('fileVersion is null', s.fileVersion === null);
  check('current is false', s.current === false);
  check('agentsDirExists propagated', s.agentsDirExists === true);
  check('path propagated', s.path === '/fake/path');

  const s2 = computeSubagentStatus('/fake/path', false, null, false, '3.26.0');
  check('agentsDirExists=false when CC agents dir missing', s2.agentsDirExists === false);
}

// ======================================================================
//  computeSubagentStatus — file present, version extracted
// ======================================================================
header('computeSubagentStatus — file present with version marker');
{
  const body = buildSubagentFile('3.26.0');
  const s = computeSubagentStatus('/fake/path', true, body, true, '3.26.0');
  check('installed is true', s.installed === true);
  check('fileVersion parsed from marker', s.fileVersion === '3.26.0');
  check('current = true when versions match', s.current === true);

  const sOld = computeSubagentStatus('/fake/path', true, buildSubagentFile('3.25.0'), true, '3.26.0');
  check('fileVersion reflects old version', sOld.fileVersion === '3.25.0');
  check('current = false when versions differ', sOld.current === false);
}

// ======================================================================
//  computeSubagentStatus — file present without marker (externally edited)
// ======================================================================
header('computeSubagentStatus — body lacks version marker → fileVersion null, current false');
{
  const garbledBody = '---\nname: dario\n---\nhand-edited by user\n';
  const s = computeSubagentStatus('/fake/path', true, garbledBody, true, '3.26.0');
  check('installed still true (file exists)', s.installed === true);
  check('fileVersion null (no marker found)', s.fileVersion === null);
  check('current false (can\'t verify match)', s.current === false);
}

// ======================================================================
//  install / loadStatus / remove — filesystem round-trip
// ======================================================================
header('install → loadStatus → remove round-trip (isolated HOME)');
{
  // Point HOME at a throwaway temp dir so getSubagentPath()'s homedir()
  // resolves into the sandbox, not the real user's config. On Windows
  // the variable is USERPROFILE; on POSIX it's HOME. Set both to be safe.
  const sandbox = mkdtempSync(join(tmpdir(), 'dario-subagent-test-'));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  try {
    // getSubagentPath has already been imported with the original HOME, but
    // it calls homedir() every invocation (not at import), so the reassign
    // above takes effect for subsequent calls.
    const expected = join(sandbox, '.claude', 'agents', SUBAGENT_FILENAME);
    check('getSubagentPath honors reassigned HOME', getSubagentPath() === expected);

    // status before install — file absent, agents dir absent
    const s0 = loadSubagentStatus();
    check('pre-install: installed=false', s0.installed === false);
    check('pre-install: agentsDirExists=false', s0.agentsDirExists === false);

    // install — creates directory + file
    const r1 = installSubagent();
    check('install action = created', r1.action === 'created');
    check('install reports the expected path', r1.path === expected);
    check('file now exists on disk', existsSync(expected));

    // Content matches buildSubagentFile for the reported version
    const onDisk = readFileSync(expected, 'utf-8');
    check('on-disk content matches buildSubagentFile(version)', onDisk === buildSubagentFile(r1.version));

    // Status after install — installed + current
    const s1 = loadSubagentStatus();
    check('post-install: installed=true', s1.installed === true);
    check('post-install: agentsDirExists=true', s1.agentsDirExists === true);
    check('post-install: fileVersion matches', s1.fileVersion === r1.version);
    check('post-install: current=true', s1.current === true);

    // Re-install with no change — action=unchanged
    const r2 = installSubagent();
    check('re-install with identical content → action=unchanged', r2.action === 'unchanged');

    // Simulate a stale install — overwrite with an older version marker
    const staleBody = buildSubagentFile('0.0.1');
    writeFileSync(expected, staleBody, 'utf-8');
    const r3 = installSubagent();
    check('install after stale file → action=updated', r3.action === 'updated');

    // remove — file gone, idempotent
    const r4 = removeSubagent();
    check('remove: removed=true', r4.removed === true);
    check('remove: file no longer exists', !existsSync(expected));
    const r5 = removeSubagent();
    check('remove idempotent: removed=false when absent', r5.removed === false);

    // install leaves the directory; a later remove doesn't clean it up
    // (matches the intentional design — user might have other sub-agents)
    installSubagent();
    removeSubagent();
    check('agents dir persists after remove (other sub-agents untouched)', existsSync(join(sandbox, '.claude', 'agents')));
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ======================================================================
//  install — agents dir already exists (don't clobber other sub-agents)
// ======================================================================
header('install — agents dir already populated → only dario.md touched');
{
  const sandbox = mkdtempSync(join(tmpdir(), 'dario-subagent-test-'));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  try {
    const agentsDir = join(sandbox, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const other = join(agentsDir, 'not-dario.md');
    writeFileSync(other, '---\nname: not-dario\n---\n\nUnrelated sub-agent.\n', 'utf-8');

    installSubagent();
    check('dario.md installed alongside existing sub-agent', existsSync(join(agentsDir, SUBAGENT_FILENAME)));
    check('existing unrelated sub-agent untouched', readFileSync(other, 'utf-8').includes('not-dario'));

    removeSubagent();
    check('remove only unlinks dario.md', existsSync(other));
    check('dario.md gone', !existsSync(join(agentsDir, SUBAGENT_FILENAME)));
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ======================================================================
//  SUBAGENT_NAME / SUBAGENT_FILENAME — exported constants
// ======================================================================
header('SUBAGENT_NAME / SUBAGENT_FILENAME exported');
{
  check('SUBAGENT_NAME === "dario"', SUBAGENT_NAME === 'dario');
  check('SUBAGENT_FILENAME === "dario.md"', SUBAGENT_FILENAME === 'dario.md');
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
