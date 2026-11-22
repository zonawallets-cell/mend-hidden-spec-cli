// mend: one patch tool for every AI edit format. Node 22, standard library only.
// Implements SPEC.md: the command line, output and exit codes, safe paths, format
// detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits, and all-or-nothing writes.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');

// A patch's lines: split at \n, one trailing \r removed from each, and the empty
// piece after a final \n dropped.
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

interface FileLines {
  lines: string[];
  br: string;
  ends: boolean;
}

// A file's lines under section 3: CRLF when its first line feed follows a
// carriage return, LF otherwise; an empty file has no lines.
function parseText(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function renderText(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// The tree as the patch sees it: original bytes lazily read from disk, current
// bytes changed by edits. A null value means the file does not exist.
class Tree {
  private orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();

  get(p: string): string | null {
    if (!this.cur.has(p)) {
      let v: string | null = null;
      try {
        v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
      this.cur.set(p, v);
    }
    return this.cur.get(p) ?? null;
  }

  set(p: string, v: string | null): void {
    if (!this.cur.has(p)) this.get(p);
    this.cur.set(p, v);
  }

  original(p: string): string | null {
    if (!this.orig.has(p)) this.get(p);
    return this.orig.get(p) ?? null;
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.cur);
  }

  restore(s: Map<string, string | null>): void {
    this.cur = new Map(s);
  }

  keys(): string[] {
    return [...this.cur.keys()];
  }
}

// ---- Section 5: matching lines ---------------------------------------------

interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean; // a `\` line follows this body line in the patch
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineEq(lines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; only 0 with --strict) at which the old
// lines occur at least once, at or after `from`.
function findTier(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, oldLines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// The lines that replace a matched block: context lines are written as the
// file's own matched lines, never the patch's. At tier 2 every other line is
// re-indented from the old block's leading whitespace to the file's.
function buildNew(fileLines: string[], at: number, ops: Op[], tier: number): string[] {
  const out: string[] = [];
  const firstOld = ops.find((o) => o.kind !== 'add');
  const pfx = firstOld ? leadWs(firstOld.text) : '';
  const ffx = leadWs(fileLines[at] ?? '');
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[at + oi]);
      oi++;
    } else if (op.kind === 'del') {
      oi++;
    } else {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pfx)) {
        t = ffx + t.slice(pfx.length);
      }
      out.push(t);
    }
  }
  return out;
}

// One edit: applies itself to the tree, or throws EditFail. A failed edit
// leaves the tree untouched (the runner snapshots around each call).
interface Ctx {
  tree: Tree;
  strict: boolean;
  moves: { old: string; nw: string }[];
}
type Edit = (c: Ctx) => void;

function failUnsafe(p: string | null | undefined): void {
  if (p === undefined || p === null || !safePath(p)) {
    throw new EditFail('unsafe', p ?? '');
  }
}

// ---- Section 6: unified diffs ----------------------------------------------

interface Hunk {
  a: number; // the -A line number of the header
  ops: Op[];
}

interface Section {
  pairOld: string | null | undefined; // undefined: no ---/+++ pair; null: /dev/null
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

// The path after `--- ` / `+++ `: text after four characters, up to the first
// tab, surrounding spaces removed; /dev/null means no file; a leading a/ or
// b/ is removed.
function diffPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0].trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseHunkHead(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) throw new ParseErr(lineNo);
  return parseInt(m[1], 10);
}

// A hunk's body: lines starting with ' ', '-', '+' or '\', or empty ones.
// It ends at the first other line, a diff --git line, a --- line followed by
// a +++ line, or the end of the patch; trailing empty lines are not part of it.
function collectHunkBody(lines: string[], start: number): { ops: Op[]; next: number } {
  const raw: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      i++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const ops: Op[] = [];
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k];
    const noNL = k + 1 < raw.length && raw[k + 1].startsWith('\\');
    if (l === '') ops.push({ kind: 'ctx', text: '', noNL });
    else if (l[0] === ' ') ops.push({ kind: 'ctx', text: l.slice(1), noNL });
    else if (l[0] === '-') ops.push({ kind: 'del', text: l.slice(1), noNL });
    else if (l[0] === '+') ops.push({ kind: 'add', text: l.slice(1), noNL });
    // '\' lines are markers on the line before them, not lines themselves.
  }
  return { ops, next: i };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  const finish = (): void => {
    if (sec) edits.push(unifiedEdit(sec));
    sec = null;
  };
  const readHunk = (i: number): number => {
    const a = parseHunkHead(lines[i], i + 1);
    const { ops, next } = collectHunkBody(lines, i + 1);
    sec!.hunks.push({ a, ops });
    inHeader = false;
    return next;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (!m) throw new ParseErr(i + 1);
      finish();
      sec = newSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (sec && inHeader) {
        if (sec.pairOld === undefined) {
          sec.pairOld = diffPath(l);
          sec.pairNew = diffPath(lines[i + 1]);
        }
        i += 2;
        continue;
      }
      finish();
      sec = newSection();
      sec.pairOld = diffPath(l);
      sec.pairNew = diffPath(lines[i + 1]);
      inHeader = true;
      i += 2;
      continue;
    }
    if (sec === null) {
      if (l.startsWith('@@')) throw new ParseErr(i + 1);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new ParseErr(i + 2);
      if (l.startsWith('@@')) {
        i = readHunk(i);
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (sec.renameOld === undefined) sec.renameOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (sec.renameNew === undefined) sec.renameNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.delFile = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      i = readHunk(i);
      continue;
    }
    i++;
  }
  finish();
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// Apply a section's hunks in order, each to the result of the ones before it.
// d is the running sum of (new length minus old length) over hunks applied so far.
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = [...f.lines];
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    const oLines = h.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
    const lastNew = [...h.ops].reverse().find((o) => o.kind === 'ctx' || o.kind === 'add');
    const noNL = lastNew ? lastNew.noNL : false;
    if (oLines.length === 0) {
      const idx = Math.min(h.a + d, lines.length);
      const atEnd = idx === lines.length;
      const added = h.ops.filter((o) => o.kind === 'add').map((o) => o.text);
      lines.splice(idx, 0, ...added);
      if (atEnd) ends = !noNL;
      d += added.length;
      continue;
    }
    const found = findTier(lines, oLines, strict, 0);
    if (!found) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const reachesEnd = best + oLines.length === lines.length;
    const replacement = buildNew(lines, best, h.ops, found.tier);
    lines.splice(best, oLines.length, ...replacement);
    if (reachesEnd) ends = !noNL;
    d += replacement.length - oLines.length;
  }
  return { lines, br: f.br, ends };
}

function unifiedEdit(sec: Section): Edit {
  return (c: Ctx) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld ?? null;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew ?? null;
    let kind: 'create' | 'delete' | 'move' | 'change';
    if (sec.delFile) kind = 'delete';
    else if (sec.newFile) kind = 'create';
    else if (oldP === null) kind = 'create';
    else if (newP === null) kind = 'delete';
    else if (oldP !== newP) kind = 'move';
    else kind = 'change';
    if (kind === 'create') {
      failUnsafe(newP);
      const np = newP as string;
      if (c.tree.get(np) !== null) throw new EditFail('exists', np);
      const plus = sec.hunks.flatMap((h) => h.ops.filter((o) => o.kind === 'add'));
      const lastPlus = plus.length > 0 ? plus[plus.length - 1] : null;
      const text = renderText({
        lines: plus.map((o) => o.text),
        br: '\n',
        ends: plus.length > 0 ? !lastPlus!.noNL : false,
      });
      c.tree.set(np, text);
      return;
    }
    if (kind === 'delete') {
      failUnsafe(oldP);
      const op = oldP as string;
      if (c.tree.get(op) === null) throw new EditFail('missing', op);
      c.tree.set(op, null);
      return;
    }
    failUnsafe(oldP);
    failUnsafe(newP);
    const op = oldP as string;
    const np = newP as string;
    const cur = c.tree.get(op);
    if (cur === null) throw new EditFail('missing', op);
    if (kind === 'move' && c.tree.get(np) !== null) throw new EditFail('exists', np);
    const out = renderText(applyHunks(parseText(cur), sec.hunks, c.strict, op));
    if (kind === 'move') {
      c.tree.set(np, out);
      c.tree.set(op, null);
      c.moves.push({ old: op, nw: np });
    } else {
      c.tree.set(op, out);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks --------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // index just after the previous block's >>>>>>> line
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (trimEnd(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before SEARCH, after the previous block,
    // that is not blank and does not start with three backticks.
    let path: string | undefined;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new ParseErr(searchLine);
    // Find ======= then >>>>>>> REPLACE after the SEARCH line.
    let sep = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (trimEnd(lines[k]) === '<<<<<<< SEARCH') break;
      if (trimEnd(lines[k]) === '=======') {
        sep = k;
        break;
      }
    }
    let end = -1;
    if (sep !== -1) {
      for (let k = sep + 1; k < lines.length; k++) {
        if (trimEnd(lines[k]) === '<<<<<<< SEARCH') break;
        if (trimEnd(lines[k]) === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (sep === -1 || end === -1) throw new ParseErr(searchLine);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (c: Ctx) => {
    failUnsafe(path);
    if (oldLines.length === 0) {
      if (c.tree.get(path) !== null) throw new EditFail('exists', path);
      c.tree.set(
        path,
        renderText({ lines: [...newLines], br: '\n', ends: newLines.length > 0 }),
      );
      return;
    }
    const cur = c.tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    const f = parseText(cur);
    const found = findTier(f.lines, oldLines, c.strict, 0);
    if (!found) throw new EditFail('no-match', path);
    if (found.pos.length > 1) throw new EditFail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'del', text: t, noNL: false })),
      ...newLines.map((t): Op => ({ kind: 'add', text: t, noNL: false })),
    ];
    const replacement = buildNew(f.lines, found.pos[0], ops, found.tier);
    const lines = [...f.lines];
    lines.splice(found.pos[0], oldLines.length, ...replacement);
    c.tree.set(path, renderText({ lines, br: f.br, ends: f.ends }));
  };
}

// ---- Section 8: V4A patches -------------------------------------------------

interface Chunk {
  anchor: string | null; // null: no anchor (empty text after @@ is no anchor)
  ops: Op[];
  eof: boolean;
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1 || lines[first].trim() !== '*** Begin Patch') {
    throw new ParseErr(first === -1 ? 1 : first + 1);
  }
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const l = lines[i];
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      path = l.slice('*** Add File:'.length).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'del';
      path = l.slice('*** Delete File:'.length).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'upd';
      path = l.slice('*** Update File:'.length).trim();
    } else {
      throw new ParseErr(i + 1);
    }
    // The section's lines run to the next section start or *** End Patch.
    let j = i + 1;
    while (j < last) {
      const t = lines[j];
      if (t.startsWith('*** Add File:') || t.startsWith('*** Delete File:') || t.startsWith('*** Update File:')) break;
      j++;
    }
    // Blank lines at the end of a section are not part of it.
    let bodyEnd = j;
    while (bodyEnd > i + 1 && isBlank(lines[bodyEnd - 1])) bodyEnd--;
    const body = lines.slice(i + 1, bodyEnd);
    if (kind === 'add') {
      for (let k = 0; k < body.length; k++) {
        if (!(body[k].startsWith('+') || body[k] === '')) throw new ParseErr(i + 2 + k);
      }
      edits.push(v4aAddEdit(path, body));
    } else if (kind === 'del') {
      if (body.length > 0) throw new ParseErr(i + 2);
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, body, i + 1));
    }
    i = j;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function v4aAddEdit(path: string, body: string[]): Edit {
  return (c: Ctx) => {
    failUnsafe(path);
    if (c.tree.get(path) !== null) throw new EditFail('exists', path);
    const fileLines = body.map((l) => (l === '' ? '' : l.slice(1)));
    c.tree.set(path, renderText({ lines: fileLines, br: '\n', ends: fileLines.length > 0 }));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (c: Ctx) => {
    failUnsafe(path);
    if (c.tree.get(path) === null) throw new EditFail('missing', path);
    c.tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, body: string[], updLine: number): Edit {
  // Parse the chunks now, so a malformed chunk is a parse error.
  let moveTo: string | undefined;
  let idx = 0;
  if (body.length > 0 && body[0].startsWith('*** Move to:')) {
    moveTo = body[0].slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let seenChunk = false;
  for (; idx < body.length; idx++) {
    const l = body[idx];
    const lineNo = updLine + 1 + idx;
    if (l.startsWith('@@')) {
      if (cur) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
      seenChunk = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur) {
        cur.eof = true;
        chunks.push(cur);
        cur = null;
      }
      // A lone End of File ends no chunk and starts none.
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!cur) {
        if (seenChunk) throw new ParseErr(lineNo);
        cur = { anchor: null, ops: [], eof: false };
        seenChunk = true;
      }
      if (l === '') cur.ops.push({ kind: 'ctx', text: '', noNL: false });
      else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1), noNL: false });
      else if (l[0] === '-') cur.ops.push({ kind: 'del', text: l.slice(1), noNL: false });
      else cur.ops.push({ kind: 'add', text: l.slice(1), noNL: false });
      continue;
    }
    throw new ParseErr(lineNo);
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === undefined) throw new ParseErr(updLine);
  return (c: Ctx) => {
    failUnsafe(path);
    if (moveTo !== undefined) failUnsafe(moveTo);
    const curText = c.tree.get(path);
    if (curText === null) throw new EditFail('missing', path);
    if (moveTo !== undefined && c.tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const f = parseText(curText);
    let lines = [...f.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], c.strict, cursor);
        if (!found) throw new EditFail('no-match', path);
        cursor = found.pos[0] + 1;
      }
      const oLines = ch.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
      if (oLines.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const added = ch.ops.filter((o) => o.kind === 'add').map((o) => o.text);
        lines.splice(at, 0, ...added);
        cursor = at + added.length;
        continue;
      }
      const found = findTier(lines, oLines, c.strict, cursor);
      if (!found) throw new EditFail('no-match', path);
      let pos = found.pos[0];
      if (ch.eof) {
        const endPos = lines.length - oLines.length;
        if (!found.pos.includes(endPos)) throw new EditFail('no-match', path);
        pos = endPos;
      }
      const replacement = buildNew(lines, pos, ch.ops, found.tier);
      lines.splice(pos, oLines.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const out = renderText({ lines, br: f.br, ends: f.ends });
    if (moveTo !== undefined) {
      c.tree.set(moveTo, out);
      c.tree.set(path, null);
      c.moves.push({ old: path, nw: moveTo });
    } else {
      c.tree.set(path, out);
    }
  };
}

// ---- Section 9: JSON edits ---------------------------------------------------

interface JsonEdit {
  path: string;
  command: 'create' | 'str_replace' | 'insert';
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A wrong command or a missing or mistyped key is a parse fault.
function validateJsonEdit(v: unknown): JsonEdit | null {
  if (!isObj(v)) return null;
  if (typeof v.path !== 'string') return null;
  if (v.command === 'create') {
    if (typeof v.file_text !== 'string') return null;
    return { path: v.path, command: 'create', fileText: v.file_text };
  }
  if (v.command === 'str_replace') {
    if (typeof v.old_str !== 'string' || v.old_str === '') return null;
    if (v.new_str !== undefined && typeof v.new_str !== 'string') return null;
    return { path: v.path, command: 'str_replace', oldStr: v.old_str, newStr: v.new_str ?? '' };
  }
  if (v.command === 'insert') {
    if (typeof v.insert_line !== 'number' || !Number.isInteger(v.insert_line)) return null;
    if (typeof v.new_str !== 'string') return null;
    return { path: v.path, command: 'insert', insertLine: v.insert_line, newStr: v.new_str };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is at the array's first line.
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseErr(first + 1);
    for (const v of arr) {
      const e = validateJsonEdit(v);
      if (!e) throw new ParseErr(first + 1);
      edits.push(jsonEdit(e));
    }
  } else {
    // JSON Lines: one edit object a line, blank lines ignored.
    for (let k = 0; k < lines.length; k++) {
      if (isBlank(lines[k])) continue;
      let v: unknown;
      try {
        v = JSON.parse(lines[k]);
      } catch {
        throw new ParseErr(k + 1);
      }
      const e = validateJsonEdit(v);
      if (!e) throw new ParseErr(k + 1);
      edits.push(jsonEdit(e));
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function countOccurrences(text: string, needle: string): number {
  let n = 0;
  let at = 0;
  for (;;) {
    const p = text.indexOf(needle, at);
    if (p === -1) return n;
    n++;
    at = p + 1; // positions may overlap
  }
}

function jsonEdit(e: JsonEdit): Edit {
  return (c: Ctx) => {
    failUnsafe(e.path);
    if (e.command === 'create') {
      if (c.tree.get(e.path) !== null) throw new EditFail('exists', e.path);
      c.tree.set(e.path, e.fileText!);
      return;
    }
    const cur = c.tree.get(e.path);
    if (cur === null) throw new EditFail('missing', e.path);
    if (e.command === 'str_replace') {
      const f = parseText(cur);
      if (f.br === '\r\n') {
        const normText = cur.replace(/\r\n/g, '\n');
        const normOld = e.oldStr!.replace(/\r\n/g, '\n');
        const normNew = e.newStr!.replace(/\r\n/g, '\n');
        const n = countOccurrences(normText, normOld);
        if (n === 0) throw new EditFail('no-match', e.path);
        if (n > 1) throw new EditFail('ambiguous', e.path);
        const at = normText.indexOf(normOld);
        const replaced = normText.slice(0, at) + normNew + normText.slice(at + normOld.length);
        c.tree.set(e.path, replaced.replace(/\n/g, '\r\n'));
      } else {
        const n = countOccurrences(cur, e.oldStr!);
        if (n === 0) throw new EditFail('no-match', e.path);
        if (n > 1) throw new EditFail('ambiguous', e.path);
        const at = cur.indexOf(e.oldStr!);
        c.tree.set(e.path, cur.slice(0, at) + e.newStr! + cur.slice(at + e.oldStr!.length));
      }
      return;
    }
    // insert
    const f = parseText(cur);
    const line = e.insertLine!;
    if (line < 0 || line > f.lines.length) throw new EditFail('no-match', e.path);
    const ins = e.newStr! === '' ? [] : splitPatch(e.newStr!);
    const lines = [...f.lines];
    lines.splice(line, 0, ...ins);
    c.tree.set(e.path, renderText({ lines, br: f.br, ends: f.ends }));
  };
}

// ---- Section 4: detecting the format -----------------------------------------

function detectFormat(lines: string[]): string {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const ch = lines[first].trimStart()[0];
  if (ch === '[' || ch === '{') return 'json';
  for (const l of lines) {
    if (trimEnd(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  throw new ParseErr(0); // marker: no format detected
}

// ---- Sections 1, 2 and 10: invocation, output, atomicity --------------------

interface RunResult {
  code: number;
  out: string[];
}

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(argv: string[]): RunResult {
  // Options and PATCH may come in any order. -- ends the options.
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positional: string | undefined;
  let positionalCount = 0;
  let noMoreOptions = false;
  for (const a of argv) {
    if (!noMoreOptions && a === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return { code: 2, out: ['error: usage'] };
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return { code: 2, out: ['error: usage'] };
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return { code: 2, out: ['error: usage'] };
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    positionalCount++;
    if (positionalCount > 1) return { code: 2, out: ['error: usage'] };
    positional = a;
  }

  // Read the patch: from the PATCH file, or from standard input.
  let patchText: string;
  try {
    patchText = positional === undefined || positional === '-' ? readFileSync(0, 'utf8') : readFileSync(positional, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(patchText);

  // Detect and parse; a parse error is reported before any file is looked at.
  let edits: Edit[];
  try {
    const fmt = format === 'auto' ? detectFormat(lines) : format;
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseErr) {
      if (e.line === 0) return { code: 2, out: ['error: format'] };
      return { code: 2, out: [`error: parse ${e.line}`] };
    }
    throw e;
  }

  const tree = new Tree();
  const ctx: Ctx = { tree, strict, moves: [] };
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(ctx);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Exit 0: one line per changed path, in byte order, then the ok line.
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.keys()) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of ctx.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      const di = rows.findIndex((r) => r.line === `D ${m.old}`);
      const ai = rows.findIndex((r) => r.line === `A ${m.nw}`);
      if (di !== -1 && ai !== -1) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of tree.keys()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const linesOut = rows.map((r) => r.line);
  linesOut.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out: linesOut };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
