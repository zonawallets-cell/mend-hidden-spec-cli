// Edge-case tests for mend, covering SPEC sentences the practice set does not
// show: fuzzy tiers, ambiguity, multi-file patches, --strict, dry-run, stdin,
// CRLF, no-trailing-newline, empty/malformed patches, atomicity, unsafe
// paths, moves, V4A anchors/cursor/EOF, JSON insert/CRLF. Run: node edge-tests.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MAIN = new URL('./main.ts', import.meta.url).pathname;
let pass = 0;
let fail = 0;

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length + 1).split('/').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function check(name, { argv = [], stdin = null, files = {}, wantExit, wantOut, wantFiles }) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-edge-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], { cwd: dir, input: stdin ?? '', encoding: 'utf8' });
    const gotFiles = readTree(dir);
    const bad = [];
    if (r.status !== wantExit) bad.push(`exit ${r.status}, want ${wantExit}`);
    if (r.stdout !== wantOut) bad.push(`stdout ${JSON.stringify(r.stdout)}, want ${JSON.stringify(wantOut)}`);
    if (JSON.stringify(gotFiles) !== JSON.stringify(wantFiles)) {
      bad.push(`files ${JSON.stringify(gotFiles)}, want ${JSON.stringify(wantFiles)}`);
    }
    if (bad.length === 0) pass++;
    else {
      fail++;
      console.log(`FAIL ${name}\n  ${bad.join('\n  ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const U1 = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-hello world\n+hello there\n foo\n';
check('tier1 trailing-ws unified', {
  argv: ['p.diff'], files: { 'a.txt': 'hello world   \nfoo\n', 'p.diff': U1 },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'hello there\nfoo\n', 'p.diff': U1 },
});
check('strict blocks tier1', {
  argv: ['--strict', 'p.diff'], files: { 'a.txt': 'hello world   \nfoo\n', 'p.diff': U1 },
  wantExit: 1, wantOut: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
  wantFiles: { 'a.txt': 'hello world   \nfoo\n', 'p.diff': U1 },
});

const U2 = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n def f():\n-    return 1\n+    return 1\n+    return 2\n';
check('tier2 re-indent unified', {
  argv: ['p.diff'], files: { 'a.txt': '  def f():\n      return 1\n', 'p.diff': U2 },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': '  def f():\n      return 1\n      return 2\n', 'p.diff': U2 },
});

const SR_AMBIG = 'a.txt\n<<<<<<< SEARCH\ndup\n=======\nreplaced\n>>>>>>> REPLACE\n';
check('sr ambiguous twice', {
  argv: ['p.txt'], files: { 'a.txt': 'dup\nmid\ndup\n', 'p.txt': SR_AMBIG },
  wantExit: 1, wantOut: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n',
  wantFiles: { 'a.txt': 'dup\nmid\ndup\n', 'p.txt': SR_AMBIG },
});

const U_MULTI = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-1\n+one\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-2\n+two\n';
check('multi-file unified sorted', {
  argv: ['p.diff'], files: { 'a.txt': '1\n', 'b.txt': '2\n', 'p.diff': U_MULTI },
  wantExit: 0, wantOut: 'M a.txt\nM b.txt\nok: 2 files\n',
  wantFiles: { 'a.txt': 'one\n', 'b.txt': 'two\n', 'p.diff': U_MULTI },
});

check('check flag writes nothing', {
  argv: ['--check', 'p.diff'], files: { 'a.txt': 'hello world   \nfoo\n', 'p.diff': U1 },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'hello world   \nfoo\n', 'p.diff': U1 },
});

check('patch from stdin', {
  argv: [], stdin: U1, files: { 'a.txt': 'hello world   \nfoo\n' },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'hello there\nfoo\n' },
});

const SR_CRLF = 'a.txt\n<<<<<<< SEARCH\nx\n=======\nz\n>>>>>>> REPLACE\n';
check('sr on crlf file stays crlf', {
  argv: ['p.txt'], files: { 'a.txt': 'x\r\ny\r\n', 'p.txt': SR_CRLF },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'z\r\ny\r\n', 'p.txt': SR_CRLF },
});

const U_NOEOL = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+b2\n\\ No newline at end of file\n';
check('unified no-eol stays no-eol', {
  argv: ['p.diff'], files: { 'a.txt': 'a\nb', 'p.diff': U_NOEOL },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'a\nb2', 'p.diff': U_NOEOL },
});
const U_ADDEOL = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+b2\n';
check('unified hunk at eof adds eol', {
  argv: ['p.diff'], files: { 'a.txt': 'a\nb', 'p.diff': U_ADDEOL },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'a\nb2\n', 'p.diff': U_ADDEOL },
});

check('empty patch auto is format', {
  argv: [], stdin: '', files: {},
  wantExit: 2, wantOut: 'error: format\n', wantFiles: {},
});
check('empty patch named json is parse 1', {
  argv: ['--format=json'], stdin: '   \n', files: {},
  wantExit: 2, wantOut: 'error: parse 1\n', wantFiles: {},
});
check('bad hunk header parse 3', {
  argv: ['p.diff'],
  files: { 'p.diff': '--- a/x.txt\n+++ b/x.txt\n@@ -x +y @@\n' },
  wantExit: 2, wantOut: 'error: parse 3\n',
  wantFiles: { 'p.diff': '--- a/x.txt\n+++ b/x.txt\n@@ -x +y @@\n' },
});
check('sr missing separator parse 2', {
  argv: ['p.txt'],
  files: { 'p.txt': 'a.txt\n<<<<<<< SEARCH\nfoo\n>>>>>>> REPLACE\n' },
  wantExit: 2, wantOut: 'error: parse 2\n',
  wantFiles: { 'p.txt': 'a.txt\n<<<<<<< SEARCH\nfoo\n>>>>>>> REPLACE\n' },
});
check('v4a bad first line parse 1', {
  argv: ['--format=v4a', 'p.txt'], stdin: null,
  files: { 'p.txt': 'hello\n*** End Patch\n' },
  wantExit: 2, wantOut: 'error: parse 1\n',
  wantFiles: { 'p.txt': 'hello\n*** End Patch\n' },
});
check('v4a empty update parse 2', {
  argv: ['p.txt'],
  files: { 'p.txt': '*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n' },
  wantExit: 2, wantOut: 'error: parse 2\n',
  wantFiles: { 'p.txt': '*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n' },
});

const U_TX = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-1\n+one\n--- a/gone.txt\n+++ b/gone.txt\n@@ -1 +1 @@\n-2\n+two\n';
check('atomic: one failure writes nothing', {
  argv: ['p.diff'], files: { 'a.txt': '1\n', 'p.diff': U_TX },
  wantExit: 1, wantOut: 'error: missing gone.txt\nfailed: 1 of 2 edits\n',
  wantFiles: { 'a.txt': '1\n', 'p.diff': U_TX },
});

const U_UNSAFE = '--- a/../../etc/x\n+++ b/../../etc/x\n@@ -1 +1 @@\n-a\n+b\n';
check('unsafe path', {
  argv: ['p.diff'], files: { 'p.diff': U_UNSAFE },
  wantExit: 1, wantOut: 'error: unsafe ../../etc/x\nfailed: 1 of 1 edits\n',
  wantFiles: { 'p.diff': U_UNSAFE },
});

const U_MOVE = 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-hello\n+hello2\n';
check('unified rename prints R', {
  argv: ['p.diff'], files: { 'old.txt': 'hello\n', 'p.diff': U_MOVE },
  wantExit: 0, wantOut: 'R old.txt -> new.txt\nok: 1 file\n',
  wantFiles: { 'new.txt': 'hello2\n', 'p.diff': U_MOVE },
});

check('json insert out of range', {
  argv: ['--format=json'], stdin: '{"command":"insert","path":"a.txt","insert_line":5,"new_str":"x"}\n',
  files: { 'a.txt': 'a\nb\n' },
  wantExit: 1, wantOut: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
  wantFiles: { 'a.txt': 'a\nb\n' },
});
check('json array create byte for byte', {
  argv: ['--format=json'], stdin: '[{"command":"create","path":"n.txt","file_text":"hi"}]\n',
  files: {},
  wantExit: 0, wantOut: 'A n.txt\nok: 1 file\n',
  wantFiles: { 'n.txt': 'hi' },
});
check('json str_replace crlf normalizes', {
  argv: ['--format=json'], stdin: '{"command":"str_replace","path":"a.txt","old_str":"x","new_str":"z"}\n',
  files: { 'a.txt': 'x\r\ny\r\n' },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'z\r\ny\r\n' },
});
check('json str_replace ambiguous overlap', {
  argv: ['--format=json'], stdin: '{"command":"str_replace","path":"a.txt","old_str":"aa","new_str":"b"}\n',
  files: { 'a.txt': 'aaa\n' },
  wantExit: 1, wantOut: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n',
  wantFiles: { 'a.txt': 'aaa\n' },
});

const V_CURSOR = '*** Begin Patch\n*** Update File: a.txt\n@@ sec\n foo\n-old\n+new\n@@ sec\n foo\n-old\n+new\n*** End Patch\n';
check('v4a anchor cursor advances', {
  argv: ['p.txt'],
  files: { 'a.txt': 'head\nsec\nfoo\nold\nsec\nfoo\nold\n', 'p.txt': V_CURSOR },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'head\nsec\nfoo\nnew\nsec\nfoo\nnew\n', 'p.txt': V_CURSOR },
});
const V_EOF = '*** Begin Patch\n*** Update File: a.txt\n@@\n b\n-c\n+c2\n*** End of File\n*** End Patch\n';
check('v4a eof chunk at end', {
  argv: ['p.txt'], files: { 'a.txt': 'a\nb\nc\n', 'p.txt': V_EOF },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'a\nb\nc2\n', 'p.txt': V_EOF },
});
const V_EOF_BAD = '*** Begin Patch\n*** Update File: a.txt\n@@\n a\n-b\n+b2\n*** End of File\n*** End Patch\n';
check('v4a eof chunk not at end fails', {
  argv: ['p.txt'], files: { 'a.txt': 'a\nb\nc\n', 'p.txt': V_EOF_BAD },
  wantExit: 1, wantOut: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
  wantFiles: { 'a.txt': 'a\nb\nc\n', 'p.txt': V_EOF_BAD },
});
const V_ADD = '*** Begin Patch\n*** Add File: n.txt\n+line1\n\n+line3\n*** End Patch\n';
check('v4a add with empty line', {
  argv: ['p.txt'], files: { 'p.txt': V_ADD },
  wantExit: 0, wantOut: 'A n.txt\nok: 1 file\n',
  wantFiles: { 'n.txt': 'line1\n\nline3\n', 'p.txt': V_ADD },
});

check('usage unknown flag', {
  argv: ['--bogus'], stdin: '', files: {},
  wantExit: 2, wantOut: 'error: usage\n', wantFiles: {},
});
check('usage duplicate check', {
  argv: ['--check', '--check'], stdin: '', files: {},
  wantExit: 2, wantOut: 'error: usage\n', wantFiles: {},
});
check('usage two positionals', {
  argv: ['a.diff', 'b.diff'], files: {},
  wantExit: 2, wantOut: 'error: usage\n', wantFiles: {},
});
check('no-patch missing file', {
  argv: ['missing.diff'], files: {},
  wantExit: 2, wantOut: 'error: no-patch\n', wantFiles: {},
});
check('sr create existing file', {
  argv: ['p.txt'],
  files: { 'a.txt': 'x\n', 'p.txt': 'a.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n' },
  wantExit: 1, wantOut: 'error: exists a.txt\nfailed: 1 of 1 edits\n',
  wantFiles: { 'a.txt': 'x\n', 'p.txt': 'a.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n' },
});
const U_CREATE_NOEOL = '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n\\ No newline at end of file\n';
check('unified create no trailing break', {
  argv: ['p.diff'], files: { 'p.diff': U_CREATE_NOEOL },
  wantExit: 0, wantOut: 'A n.txt\nok: 1 file\n',
  wantFiles: { 'n.txt': 'hi', 'p.diff': U_CREATE_NOEOL },
});

const SR_INHERIT = 'a.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ny\n=======\nz\n>>>>>>> REPLACE\n';
check('sr second block inherits path', {
  argv: ['p.txt'], files: { 'a.txt': 'x\n', 'p.txt': SR_INHERIT },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'z\n', 'p.txt': SR_INHERIT },
});
const SR_FENCE = '```diff\na.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```\n';
check('sr path skips fence line', {
  argv: ['p.txt'], files: { 'a.txt': 'x\n', 'p.txt': SR_FENCE },
  wantExit: 0, wantOut: 'M a.txt\nok: 1 file\n',
  wantFiles: { 'a.txt': 'y\n', 'p.txt': SR_FENCE },
});
check('unified lone --- in header parse 3', {
  argv: ['p.diff'],
  files: { 'p.diff': 'diff --git a/x.txt b/x.txt\n--- a/x.txt\nindex abc\n' },
  wantExit: 2, wantOut: 'error: parse 3\n',
  wantFiles: { 'p.diff': 'diff --git a/x.txt b/x.txt\n--- a/x.txt\nindex abc\n' },
});
const V_MOVEONLY = '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n';
check('v4a pure move no chunks', {
  argv: ['p.txt'], files: { 'a.txt': 'keep\n', 'p.txt': V_MOVEONLY },
  wantExit: 0, wantOut: 'R a.txt -> b.txt\nok: 1 file\n',
  wantFiles: { 'b.txt': 'keep\n', 'p.txt': V_MOVEONLY },
});
check('dashdash ends options', {
  argv: ['--', '-weird.diff'], files: {},
  wantExit: 2, wantOut: 'error: no-patch\n', wantFiles: {},
});
const U_NOOP = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n b\n';
check('unified context-only hunk is noop', {
  argv: ['p.diff'], files: { 'a.txt': 'a\nb\n', 'p.diff': U_NOOP },
  wantExit: 0, wantOut: 'ok: 0 files\n',
  wantFiles: { 'a.txt': 'a\nb\n', 'p.diff': U_NOOP },
});
check('forced unified on json is parse 1', {
  argv: ['--format=unified'], stdin: '{"command":"create","path":"n.txt","file_text":"hi"}\n', files: {},
  wantExit: 2, wantOut: 'error: parse 1\n', wantFiles: {},
});
const U_NEWFILE = 'diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hello\n';
check('unified new file mode creates', {
  argv: ['p.diff'], files: { 'p.diff': U_NEWFILE },
  wantExit: 0, wantOut: 'A n.txt\nok: 1 file\n',
  wantFiles: { 'n.txt': 'hello\n', 'p.diff': U_NEWFILE },
});

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
