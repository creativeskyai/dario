// Regression test for dario#35 — scrubFrameworkIdentifiers must not
// corrupt filesystem paths or URLs that happen to contain a framework
// identifier. Before the fix, `/Users/foo/.openclaw/workspace/` became
// `/Users/foo/./workspace/` because `\b` word boundaries fired between
// `.` and `o`.

import { scrubFrameworkIdentifiers } from '../dist/cc-template.js';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log('\n======================================================================');
console.log('  dario#35 — path preservation in scrubFrameworkIdentifiers');
console.log('======================================================================');

// Paths must survive unchanged
assertEq(
  scrubFrameworkIdentifiers('/Users/foo/.openclaw/workspace/'),
  '/Users/foo/.openclaw/workspace/',
  'unix hidden dir .openclaw preserved',
);
assertEq(
  scrubFrameworkIdentifiers('C:\\Users\\foo\\.openclaw\\workspace'),
  'C:\\Users\\foo\\.openclaw\\workspace',
  'windows path with .openclaw preserved',
);
assertEq(
  scrubFrameworkIdentifiers('~/.openclaw/config.json'),
  '~/.openclaw/config.json',
  'tilde-expanded openclaw path preserved',
);
assertEq(
  scrubFrameworkIdentifiers('https://openclaw.dev/docs'),
  'https://openclaw.dev/docs',
  'URL host openclaw.dev preserved',
);
assertEq(
  scrubFrameworkIdentifiers('/tmp/aider-cache/session.db'),
  '/tmp/aider-cache/session.db',
  'aider path segment preserved',
);
assertEq(
  scrubFrameworkIdentifiers('load ~/.cursor/settings.json'),
  'load ~/.cursor/settings.json',
  'cursor in dotfile path preserved',
);

// Prose scrubbing must still work
assertEq(
  scrubFrameworkIdentifiers('powered by openclaw'),
  'powered by ',
  'prose "powered by openclaw" — openclaw stripped (powered-by pattern needs a trailing word)',
);
assertEq(
  scrubFrameworkIdentifiers('this request came from openclaw today'),
  'this request came from  today',
  'standalone openclaw in prose still stripped',
);
assertEq(
  scrubFrameworkIdentifiers('running openclaw with aider alongside cursor'),
  'running  with  alongside ',
  'multiple identifiers in prose still stripped',
);
assertEq(
  scrubFrameworkIdentifiers('gpt-4 is not claude'),
  ' is not claude',
  'gpt-4 stripped (claude passes through — not in pattern)',
);

// Mixed: path in same string as prose
assertEq(
  scrubFrameworkIdentifiers('use openclaw, config at ~/.openclaw/config'),
  'use , config at ~/.openclaw/config',
  'prose stripped but path segment preserved in same string',
);

console.log('\n======================================================================');
console.log(`  ${pass} pass, ${fail} fail`);
console.log('======================================================================\n');

if (fail > 0) process.exit(1);
