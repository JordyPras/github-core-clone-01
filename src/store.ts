// The in-memory store: users, repositories, git objects, issues, pull requests.
// Everything the four surfaces (REST, GraphQL, MCP, git smart HTTP) read and write
// lives here, so a repository or issue created over one surface is the same object
// over the others, with stable ids across reads.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { VIEWER, TEAMMATE, STRANGER, ORG, type ScenarioUser } from './scenario.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface StoreUser {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: StoreUser;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  user: StoreUser;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  user: StoreUser;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
}

// ---------------------------------------------------------------- crypto / git objects

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree-entry sort: entries sort by name, directories as if their name ended in '/'. */
export function treeEntrySortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => (treeEntrySortKey(a) < treeEntrySortKey(b) ? -1 : treeEntrySortKey(a) > treeEntrySortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitFields {
  tree: string;
  parents: string[];
  author: string; // "Name <email> <epochSec> +0000"
  committer: string;
  message: string;
}

export function buildCommit(fields: CommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  lines.push('');
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(fields.message, 'utf8')]);
}

export interface TagFields {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(fields: TagFields): Buffer {
  const lines = [`object ${fields.object}`, `type ${fields.type}`, `tag ${fields.tag}`, `tagger ${fields.tagger}`, ''];
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(fields.message, 'utf8')]);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message: message.replace(/\n+$/, '') };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

/** Parse "Name <email> 1700000000 +0000" into its parts. */
export function parseIdent(ident: string): { name: string; email: string; epochSec: number; tz: string } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (m === null) return { name: ident, email: '', epochSec: 0, tz: '+0000' };
  return { name: m[1], email: m[2], epochSec: Number(m[3]), tz: m[4] };
}

export function formatIdent(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

export function isoOfEpoch(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

// ---------------------------------------------------------------- reachability / trees

/** All objects reachable from `tips`, following commits, trees and tags (never gitlinks). */
export function collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(repo, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build (and store) a tree from a flat path map, creating intermediate trees. */
export function buildTreeFromPaths(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  // Group paths by directory.
  const byDir = new Map<string, Array<{ name: string; oid: string; mode: string }>>();
  const subdirs = new Map<string, Set<string>>();
  for (const [path, value] of files) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)?.push({ name, oid: value.oid, mode: value.mode });
    // Record every ancestor directory.
    let cur = dir;
    while (cur !== '') {
      const parentSlash = cur.lastIndexOf('/');
      const parent = parentSlash < 0 ? '' : cur.slice(0, parentSlash);
      const base = parentSlash < 0 ? cur : cur.slice(parentSlash + 1);
      if (!subdirs.has(parent)) subdirs.set(parent, new Set());
      subdirs.get(parent)?.add(base);
      cur = parent;
    }
  }
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = [];
    for (const file of byDir.get(dir) ?? []) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
    for (const sub of subdirs.get(dir) ?? []) entries.push({ mode: '40000', name: sub, oid: buildDir(dir === '' ? sub : `${dir}/${sub}`) });
    const data = buildTree(entries);
    return storeObject(repo, 'tree', data);
  };
  return buildDir('');
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

export function countLines(data: Buffer | undefined): number {
  if (data === undefined || data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Line counts for a modified file: lines only in the new blob vs only in the old blob. */
export function lineDiffCounts(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldData === undefined ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === undefined ? [] : newData.toString('utf8').split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

export function diffFileMaps(
  repo: Repo,
  oldFiles: Map<string, { oid: string; mode: string }>,
  newFiles: Map<string, { oid: string; mode: string }>,
): FileDiff[] {
  const out: FileDiff[] = [];
  const names = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const name of [...names].sort()) {
    const oldEntry = oldFiles.get(name);
    const newEntry = newFiles.get(name);
    if (oldEntry !== undefined && newEntry === undefined) {
      const oldObj = repo.objects.get(oldEntry.oid);
      out.push({ filename: name, status: 'deleted', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: countLines(oldObj?.data) });
    } else if (oldEntry === undefined && newEntry !== undefined) {
      const newObj = repo.objects.get(newEntry.oid);
      out.push({ filename: name, status: 'added', oldOid: null, newOid: newEntry.oid, additions: countLines(newObj?.data), deletions: 0 });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldObj = repo.objects.get(oldEntry.oid);
      const newObj = repo.objects.get(newEntry.oid);
      const counts = lineDiffCounts(oldObj?.data, newObj?.data);
      out.push({ filename: name, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions: counts.additions, deletions: counts.deletions });
    }
  }
  return out;
}

/** The merge-base of two commits: the nearest common ancestor (BFS by generation). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOf = (start: string): Map<string, number> => {
    const depth = new Map<string, number>();
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length > 0) {
      const [oid, d] = queue.shift() as [string, number];
      if (depth.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      depth.set(oid, d);
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
    }
    return depth;
  };
  const aAncestors = ancestorsOf(a);
  const bAncestors = ancestorsOf(b);
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const [oid, d] of aAncestors) {
    if (!bAncestors.has(oid)) continue;
    const total = d + (bAncestors.get(oid) as number);
    if (total < bestDepth) {
      bestDepth = total;
      best = oid;
    }
  }
  return best;
}

/** Whether `ancestor` is an ancestor of (or equal to) `tip`. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** Commits reachable from `tip`, newest first (by commit time, then insertion order). */
export function listCommits(repo: Repo, tip: string): Array<{ oid: string; commit: ParsedCommit }> {
  const seen = new Set<string>();
  const commits: Array<{ oid: string; commit: ParsedCommit }> = [];
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    const commit = parseCommit(obj.data);
    commits.push({ oid, commit });
    for (const parent of commit.parents) stack.push(parent);
  }
  commits.sort((a, b) => {
    const ta = parseIdent(a.commit.committer).epochSec;
    const tb = parseIdent(b.commit.committer).epochSec;
    return tb - ta;
  });
  return commits;
}

/** Follow tag objects to the commit they point at (null when it never resolves). */
export function resolveToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') current = parseTag(obj.data).object;
    else return null;
  }
  return null;
}

// ---------------------------------------------------------------- pack files

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackObjectInput {
  type: GitObjectType;
  data: Buffer;
}

/** Serialize plain (undeltified) objects as a pack version 2 with a SHA-1 trailer. */
export function writePack(objects: PackObjectInput[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    const code = PACK_TYPE_CODES[obj.type];
    const size = obj.data.length;
    // Type+size varint header.
    const headerBytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    chunks.push(Buffer.from(headerBytes));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ReadPackResult {
  objects: Array<{ type: GitObjectType; oid: string; data: Buffer }>;
  error: string | null;
}

/** Apply a git binary delta to `base`, per the delta format. Returns null on malformed input. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) return -1;
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) return null;
  const targetSize = readSize();
  if (targetSize < 0) return null;
  const parts: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const opcode = delta[pos] as number;
    pos += 1;
    if ((opcode & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((opcode & (1 << i)) !== 0) {
          if (pos >= delta.length) return null;
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((opcode & (0x10 << i)) !== 0) {
          if (pos >= delta.length) return null;
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) return null;
      parts.push(base.subarray(offset, offset + size));
      written += size;
    } else if (opcode !== 0) {
      if (pos + opcode > delta.length) return null;
      parts.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      written += opcode;
    } else {
      return null;
    }
  }
  if (written !== targetSize) return null;
  return Buffer.concat(parts);
}

/**
 * Inflate one zlib stream starting at `pos`, whose inflated size is `expectedSize`.
 * Node's inflateSync stops at the stream end and ignores trailing bytes, but does not
 * report how many bytes it consumed, so the stream end is found by binary search over
 * the prefix length: a prefix shorter than the stream throws (or yields the wrong
 * length), a prefix at or past its end inflates to exactly the expected output.
 */
function inflateEntry(data: Buffer, pos: number, expectedSize: number): { data: Buffer; next: number } | null {
  const tryPrefix = (length: number): Buffer | null => {
    try {
      const out = inflateSync(data.subarray(pos, pos + length));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  const max = data.length - pos;
  if (tryPrefix(max) === null) return null;
  let lo = 1;
  let hi = max;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryPrefix(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const out = tryPrefix(lo);
  if (out === null) return null;
  return { data: out, next: pos + lo };
}

/**
 * Parse a packfile (plain objects, OFS_DELTA and REF_DELTA), resolving deltas.
 * `lookupBase` resolves a REF_DELTA base that is not in the pack (e.g. an object the
 * repository already holds); without it such a delta fails to resolve.
 */
export function readPack(
  data: Buffer,
  lookupBase?: (oid: string) => { type: GitObjectType; data: Buffer } | null,
): ReadPackResult {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'PACK') {
    return { objects: [], error: 'not a packfile' };
  }
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { objects: [], error: `unsupported pack version ${version}` };
  const count = data.readUInt32BE(8);
  if (data.length < 32) return { objects: [], error: 'pack truncated' };
  const trailer = data.subarray(data.length - 20);
  const body = data.subarray(0, data.length - 20);
  const trailerCheck = createHash('sha1').update(body).digest();
  if (!trailer.equals(trailerCheck)) return { objects: [], error: 'pack checksum mismatch' };

  interface RawEntry {
    type: number;
    data: Buffer;
    offset: number;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    if (pos >= body.length) return { objects: [], error: 'pack truncated' };
    const startOffset = pos;
    let byte = body[pos] as number;
    pos += 1;
    const type = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (pos >= body.length) return { objects: [], error: 'pack truncated' };
      byte = body[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      // OFS_DELTA: negative offset varint.
      byte = body[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= body.length) return { objects: [], error: 'pack truncated' };
        byte = body[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = startOffset - offset;
    } else if (type === 7) {
      if (pos + 20 > body.length) return { objects: [], error: 'pack truncated' };
      baseOid = body.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (PACK_TYPES[type] === undefined) {
      return { objects: [], error: `unknown pack object type ${type}` };
    }
    const inflated = inflateEntry(body, pos, size);
    if (inflated === null) return { objects: [], error: 'pack entry did not inflate' };
    pos = inflated.next;
    const entry: RawEntry = { type, data: inflated.data, offset: startOffset, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(startOffset, entry);
  }

  // Resolve deltas (a delta's base may itself be a delta; resolve recursively).
  const resolved = new Map<number, { type: GitObjectType; oid: string; data: Buffer }>();
  const resolveEntry = (entry: RawEntry, depth: number): { type: GitObjectType; oid: string; data: Buffer } | null => {
    if (depth > 64) return null;
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (entry.type === 6 || entry.type === 7) {
      let base: { type: GitObjectType; oid: string; data: Buffer } | null = null;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) return null;
        base = resolveEntry(baseEntry, depth + 1);
      } else if (entry.baseOid !== undefined) {
        // REF_DELTA against an object already in the pack: find it by oid among
        // the already-resolved plain entries.
        for (const other of raw) {
          if (other.type !== 6 && other.type !== 7) {
            const type = PACK_TYPES[other.type] as GitObjectType;
            if (hashObject(type, other.data) === entry.baseOid) {
              base = resolveEntry(other, depth + 1);
              break;
            }
          }
        }
        if (base === null && lookupBase !== undefined) {
          const found = lookupBase(entry.baseOid);
          if (found !== null) base = { type: found.type, oid: entry.baseOid, data: found.data };
        }
      }
      if (base === null) return null;
      const data = applyDelta(base.data, entry.data);
      if (data === null) return null;
      const out = { type: base.type, oid: hashObject(base.type, data), data };
      resolved.set(entry.offset, out);
      return out;
    }
    const type = PACK_TYPES[entry.type] as GitObjectType;
    const out = { type, oid: hashObject(type, entry.data), data: entry.data };
    resolved.set(entry.offset, out);
    return out;
  };
  const objects: Array<{ type: GitObjectType; oid: string; data: Buffer }> = [];
  for (const entry of raw) {
    const resolvedEntry = resolveEntry(entry, 0);
    if (resolvedEntry === null) return { objects: [], error: 'pack delta did not resolve' };
    objects.push(resolvedEntry);
  }
  return { objects, error: null };
}

// ---------------------------------------------------------------- store

export class Store {
  readonly users = new Map<string, StoreUser>();
  readonly repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectId = 1;
  nextCommentId = 1;

  constructor() {
    const addUser = (u: ScenarioUser, type: 'User' | 'Organization'): void => {
      this.users.set(u.login, { id: u.id, login: u.login, name: u.name, email: u.email, type });
    };
    addUser(VIEWER, 'User');
    addUser(TEAMMATE, 'User');
    addUser(STRANGER, 'User');
    this.users.set(ORG, { id: 2000, login: ORG, name: ORG, email: `${ORG}@example.invalid`, type: 'Organization' });
  }

  viewer(): StoreUser {
    return this.users.get(VIEWER.login) as StoreUser;
  }

  userFor(login: string): StoreUser {
    const found = this.users.get(login);
    if (found !== undefined) return found;
    // Any other login is a plain user the suite may name.
    const user: StoreUser = { id: 9000 + this.users.size, login, name: login, email: `${login}@example.invalid`, type: 'User' };
    this.users.set(login, user);
    return user;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; default_branch?: string }): Repo | null {
    if (this.getRepo(owner, name) !== undefined) return null;
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.default_branch ?? 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    // GitHub's default labels: the scenario's issue templates name them, so a
    // repository is born with them and issues may use them at once.
    const defaults: Array<[string, string, string]> = [
      ['bug', 'd73a4a', "Something isn't working"],
      ['documentation', '0075ca', 'Improvements or additions to documentation'],
      ['enhancement', 'a2eeef', 'New feature or request'],
      ['good first issue', '7057ff', 'Good for newcomers'],
      ['help wanted', '008672', 'Extra attention is needed'],
      ['question', 'd876e3', 'Further information is requested'],
    ];
    for (const [labelName, color, description] of defaults) {
      repo.labels.push({ id: this.newObjectId(), name: labelName, color, description });
    }
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  newObjectId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  newCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

// ---------------------------------------------------------------- global ids (GraphQL, opaque)

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const segments = text.split(':');
    if (segments.length < 2) return null;
    return { kind: segments[0], parts: segments.slice(1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return globalId('IssueComment', repo.id, issue.number, comment.id);
}

export function userGlobalId(user: StoreUser): string {
  return globalId('User', user.login);
}

export function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository' || parsed.parts.length !== 1) return null;
  const dbId = Number(parsed.parts[0]);
  if (!Number.isInteger(dbId)) return null;
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

export function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue' || parsed.parts.length !== 2) return null;
  const dbId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== dbId) continue;
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

export function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest' || parsed.parts.length !== 2) return null;
  const dbId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== dbId) continue;
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}
