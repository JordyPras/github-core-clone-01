// GitHub GraphQL v4: a small executor for the documents `gh` and `github-mcp-server`
// send (viewer, repository, issues, pullRequests, mutations, node, introspection,
// batching). No GraphQL library: a hand-written parser + resolver table. A GraphQL
// failure is HTTP 200 with an `errors` array; an unknown repository is data null
// with no errors; an unauthenticated request is 401 (enforced by the server, not here).

import { Buffer } from 'node:buffer';
import {
  commentGlobalId,
  globalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  userGlobalId,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  type StoreUser,
} from './store.ts';
import { pullConflicts, pullFiles, mergePull, userJson } from './rest.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: ArgumentNode[]; selections: SelectionNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parse(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (true) {
      this.skipIgnored();
      if (this.pos >= this.text.length) break;
      if (this.peekWord() === 'fragment') {
        this.pos += 'fragment'.length;
        const name = this.readName();
        this.skipIgnored();
        if (!this.consumeWord('on')) throw new ParseError('fragment needs "on"');
        const typeCondition = this.readName();
        const selections = this.readSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      operations.push(this.readOperation());
    }
    return { operations, fragments };
  }

  private peekWord(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    return match === null ? '' : match[0];
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private readName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new ParseError(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private consumeWord(word: string): boolean {
    this.skipIgnored();
    if (this.text.startsWith(word, this.pos) && !/[A-Za-z0-9_]/.test(this.text[this.pos + word.length] ?? '')) {
      this.pos += word.length;
      return true;
    }
    return false;
  }

  private expect(char: string): void {
    this.skipIgnored();
    if (this.text[this.pos] !== char) throw new ParseError(`expected ${char} at ${this.pos}`);
    this.pos += 1;
  }

  private readOperation(): OperationNode {
    let type: OperationNode['type'] = 'query';
    let name: string | null = null;
    const word = this.peekWord();
    if (word === 'query' || word === 'mutation' || word === 'subscription') {
      type = word as OperationNode['type'];
      this.pos += word.length;
      this.skipIgnored();
      if (this.pos < this.text.length && this.text[this.pos] !== '(' && this.text[this.pos] !== '{') {
        name = this.readName();
      }
    } else if (this.text[this.pos] === '{') {
      type = 'query';
    } else {
      throw new ParseError(`unexpected token at ${this.pos}`);
    }
    const variables: OperationNode['variables'] = [];
    this.skipIgnored();
    if (this.text[this.pos] === '(') {
      this.pos += 1;
      for (;;) {
        this.skipIgnored();
        if (this.text[this.pos] === ')') {
          this.pos += 1;
          break;
        }
        if (this.text[this.pos] !== '$') throw new ParseError('variable definition needs $');
        this.pos += 1;
        const varName = this.readName();
        this.expect(':');
        this.readType();
        let defaultValue: ValueNode | null = null;
        this.skipIgnored();
        if (this.text[this.pos] === '=') {
          this.pos += 1;
          defaultValue = this.readValue();
        }
        variables.push({ name: varName, defaultValue });
      }
    }
    const selections = this.readSelectionSet();
    return { type, name, variables, selections };
  }

  private readType(): void {
    this.skipIgnored();
    if (this.text[this.pos] === '[') {
      this.pos += 1;
      this.readType();
      this.expect(']');
    } else {
      this.readName();
    }
    this.skipIgnored();
    if (this.text[this.pos] === '!') this.pos += 1;
  }

  private readSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.pos >= this.text.length) throw new ParseError('unterminated selection set');
      if (this.text[this.pos] === '}') {
        this.pos += 1;
        break;
      }
      selections.push(this.readSelection());
    }
    return selections;
  }

  private readSelection(): SelectionNode {
    this.skipIgnored();
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipIgnored();
      if (this.peekWord() === 'on') {
        this.pos += 2;
        const typeCondition = this.readName();
        return { kind: 'inlineFragment', typeCondition, selections: this.readSelectionSet() };
      }
      const name = this.readName();
      return { kind: 'fragmentSpread', name };
    }
    const first = this.readName();
    let name = first;
    let alias: string | null = null;
    this.skipIgnored();
    if (this.text[this.pos] === ':') {
      this.pos += 1;
      alias = first;
      name = this.readName();
    }
    const args: ArgumentNode[] = [];
    this.skipIgnored();
    if (this.text[this.pos] === '(') {
      this.pos += 1;
      for (;;) {
        this.skipIgnored();
        if (this.text[this.pos] === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.readName();
        this.expect(':');
        args.push({ name: argName, value: this.readValue() });
      }
    }
    let selections: SelectionNode[] = [];
    this.skipIgnored();
    if (this.text[this.pos] === '{') selections = this.readSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private readValue(): ValueNode {
    this.skipIgnored();
    const char = this.text[this.pos];
    if (char === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (char === '"') return { kind: 'string', value: this.readString() };
    if (char === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.text[this.pos] === ']') {
          this.pos += 1;
          break;
        }
        values.push(this.readValue());
      }
      return { kind: 'list', values };
    }
    if (char === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        this.skipIgnored();
        if (this.text[this.pos] === '}') {
          this.pos += 1;
          break;
        }
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.readValue() });
      }
      return { kind: 'object', fields };
    }
    if (char === undefined) throw new ParseError('unexpected end of document');
    const match = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (match !== null && /[0-9]/.test(match[0][0] as string)) {
      this.pos += match[0].length;
      return match[0].includes('.') || /[eE]/.test(match[0]) ? { kind: 'float', value: Number(match[0]) } : { kind: 'int', value: Number(match[0]) };
    }
    const word = this.readName();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private readString(): string {
    // Current char is the opening quote.
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw new ParseError('unterminated string');
      const char = this.text[this.pos] as string;
      if (char === '"') {
        this.pos += 1;
        return out;
      }
      if (char === '\\') {
        this.pos += 1;
        const escaped = this.text[this.pos] as string;
        this.pos += 1;
        if (escaped === 'n') out += '\n';
        else if (escaped === 't') out += '\t';
        else if (escaped === 'r') out += '\r';
        else if (escaped === 'u') {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += escaped;
        continue;
      }
      out += char;
      this.pos += 1;
    }
  }
}

// ---------------------------------------------------------------- values

export interface GraphQLContext {
  store: Store;
  viewer: StoreUser;
}

type Variables = Record<string, unknown>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => evalValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(args: ArgumentNode[], variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- node values

interface ValueObject {
  __typename: string;
  [key: string]: unknown;
}

function repoValue(repo: Repo): ValueObject {
  return { __typename: 'Repository', repo };
}

function userValue(user: StoreUser): ValueObject {
  return { __typename: 'User', user };
}

function issueValue(repo: Repo, issue: Issue): ValueObject {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): ValueObject {
  return { __typename: 'PullRequest', repo, pull };
}

function commentValue(repo: Repo, issue: Issue, comment: Comment): ValueObject {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  value: ValueObject;
}

function buildConnection<T extends ConnectionItem>(
  items: T[],
  args: Record<string, unknown>,
  order: 'asc' | 'desc',
): ValueObject {
  const sorted = items.slice().sort((a, b) => (order === 'desc' ? b.number - a.number : a.number - b.number));
  const totalCount = sorted.length;
  const after = numberFromCursor(args.after);
  let filtered = sorted;
  if (after !== null) {
    filtered = sorted.filter((entry) => (order === 'desc' ? entry.number < after : entry.number > after));
  }
  const first = typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0 ? args.first : filtered.length;
  const page = filtered.slice(0, first);
  const hasNextPage = filtered.length > page.length;
  const edges = page.map((entry) => ({ __typename: 'Edge', node: entry.value, cursor: cursorFor(entry.number) }));
  return {
    __typename: 'Connection',
    nodes: page.map((entry) => entry.value),
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null,
    },
    totalCount,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): ValueObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  let issues = repo.issues.slice();
  if (states !== null) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const items = issues.map((issue) => ({ number: issue.number, value: issueValue(repo, issue) }));
  const connection = buildConnection(items, args, direction);
  connection.__typename = 'IssueConnection';
  for (const edge of connection.edges as ValueObject[]) edge.__typename = 'IssueEdge';
  return connection;
}

function pullConnection(repo: Repo, args: Record<string, unknown>): ValueObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  let pulls = repo.pulls.slice();
  if (states !== null) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state.toUpperCase()));
  }
  const items = pulls.map((pull) => ({ number: pull.number, value: pullValue(repo, pull) }));
  const connection = buildConnection(items, args, direction);
  connection.__typename = 'PullRequestConnection';
  for (const edge of connection.edges as ValueObject[]) edge.__typename = 'PullRequestEdge';
  return connection;
}

function commentConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): ValueObject {
  const items = issue.comments.map((comment) => ({ number: comment.id, value: commentValue(repo, issue, comment) }));
  const connection = buildConnection(items, args, 'asc');
  connection.__typename = 'IssueCommentConnection';
  for (const edge of connection.edges as ValueObject[]) edge.__typename = 'IssueCommentEdge';
  return connection;
}

function labelConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): ValueObject {
  const items = issue.labels.map((label, index) => ({
    number: index + 1,
    value: { __typename: 'Label', name: label.name, color: label.color, description: label.description },
  }));
  const connection = buildConnection(items, args, 'asc');
  connection.__typename = 'LabelConnection';
  for (const edge of connection.edges as ValueObject[]) edge.__typename = 'LabelEdge';
  return connection;
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): ValueObject {
  const files = pullFiles(repo, pull);
  const items = files.map((file, index) => ({
    number: index + 1,
    value: {
      __typename: 'PullRequestChangedFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: String(file.status).toUpperCase(),
    },
  }));
  const connection = buildConnection(items, args, 'asc');
  connection.__typename = 'PullRequestChangedFileConnection';
  for (const edge of connection.edges as ValueObject[]) edge.__typename = 'PullRequestChangedFileEdge';
  return connection;
}

// ---------------------------------------------------------------- introspection

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

const SCALAR = (name: string): TypeRef => ({ kind: 'SCALAR', name, ofType: null });
const OBJECT = (name: string): TypeRef => ({ kind: 'OBJECT', name, ofType: null });
const NON_NULL = (ofType: TypeRef): TypeRef => ({ kind: 'NON_NULL', name: null, ofType });
const LIST = (ofType: TypeRef): TypeRef => ({ kind: 'LIST', name: null, ofType });

interface FieldDef {
  name: string;
  type: TypeRef;
  args: Array<{ name: string; type: TypeRef }>;
}

const FIELD = (name: string, type: TypeRef, args: Array<{ name: string; type: TypeRef }> = []): FieldDef => ({ name, type, args });

const SCHEMA_TYPES: Record<string, { kind: string; fields?: FieldDef[]; enumValues?: string[]; inputFields?: Array<{ name: string; type: TypeRef }> }> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      FIELD('viewer', OBJECT('User')),
      FIELD('repository', OBJECT('Repository'), [
        { name: 'owner', type: NON_NULL(SCALAR('String')) },
        { name: 'name', type: NON_NULL(SCALAR('String')) },
      ]),
      FIELD('node', OBJECT('Node'), [{ name: 'id', type: NON_NULL(SCALAR('ID')) }]),
      FIELD('__type', OBJECT('__Type'), [{ name: 'name', type: NON_NULL(SCALAR('String')) }]),
      FIELD('__schema', OBJECT('__Schema')),
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      FIELD('createIssue', OBJECT('CreateIssuePayload'), [{ name: 'input', type: NON_NULL(OBJECT('CreateIssueInput')) }]),
      FIELD('closeIssue', OBJECT('CloseIssuePayload'), [{ name: 'input', type: NON_NULL(OBJECT('CloseIssueInput')) }]),
      FIELD('createPullRequest', OBJECT('CreatePullRequestPayload'), [{ name: 'input', type: NON_NULL(OBJECT('CreatePullRequestInput')) }]),
      FIELD('mergePullRequest', OBJECT('MergePullRequestPayload'), [{ name: 'input', type: NON_NULL(OBJECT('MergePullRequestInput')) }]),
      FIELD('addComment', OBJECT('AddCommentPayload'), [{ name: 'input', type: NON_NULL(OBJECT('AddCommentInput')) }]),
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      FIELD('id', NON_NULL(SCALAR('ID'))),
      FIELD('databaseId', SCALAR('Int')),
      FIELD('name', NON_NULL(SCALAR('String'))),
      FIELD('nameWithOwner', NON_NULL(SCALAR('String'))),
      FIELD('owner', NON_NULL(OBJECT('User'))),
      FIELD('defaultBranchRef', OBJECT('Ref')),
      FIELD('viewerPermission', OBJECT('RepositoryPermission')),
      FIELD('hasIssuesEnabled', NON_NULL(SCALAR('Boolean'))),
      FIELD('url', NON_NULL(SCALAR('String'))),
      FIELD('description', SCALAR('String')),
      FIELD('isPrivate', NON_NULL(SCALAR('Boolean'))),
      FIELD('createdAt', SCALAR('String')),
      FIELD('updatedAt', SCALAR('String')),
      FIELD('issue', OBJECT('Issue'), [{ name: 'number', type: NON_NULL(SCALAR('Int')) }]),
      FIELD('issues', NON_NULL(OBJECT('IssueConnection')), [
        { name: 'first', type: SCALAR('Int') },
        { name: 'after', type: SCALAR('String') },
        { name: 'states', type: LIST(NON_NULL(OBJECT('IssueState'))) },
        { name: 'orderBy', type: OBJECT('IssueOrder') },
      ]),
      FIELD('pullRequest', OBJECT('PullRequest'), [{ name: 'number', type: NON_NULL(SCALAR('Int')) }]),
      FIELD('pullRequests', NON_NULL(OBJECT('PullRequestConnection')), [
        { name: 'first', type: SCALAR('Int') },
        { name: 'after', type: SCALAR('String') },
        { name: 'states', type: LIST(NON_NULL(OBJECT('PullRequestState'))) },
        { name: 'orderBy', type: OBJECT('IssueOrder') },
      ]),
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      FIELD('id', NON_NULL(SCALAR('ID'))),
      FIELD('databaseId', SCALAR('Int')),
      FIELD('number', NON_NULL(SCALAR('Int'))),
      FIELD('title', NON_NULL(SCALAR('String'))),
      FIELD('body', SCALAR('String')),
      FIELD('state', NON_NULL(OBJECT('IssueState'))),
      FIELD('url', NON_NULL(SCALAR('String'))),
      FIELD('author', OBJECT('User')),
      FIELD('createdAt', SCALAR('String')),
      FIELD('updatedAt', SCALAR('String')),
      FIELD('closedAt', SCALAR('String')),
      FIELD('labels', OBJECT('LabelConnection')),
      FIELD('comments', OBJECT('IssueCommentConnection')),
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      FIELD('id', NON_NULL(SCALAR('ID'))),
      FIELD('databaseId', SCALAR('Int')),
      FIELD('number', NON_NULL(SCALAR('Int'))),
      FIELD('title', NON_NULL(SCALAR('String'))),
      FIELD('body', SCALAR('String')),
      FIELD('state', NON_NULL(OBJECT('PullRequestState'))),
      FIELD('merged', NON_NULL(SCALAR('Boolean'))),
      FIELD('mergedAt', SCALAR('String')),
      FIELD('headRefName', NON_NULL(SCALAR('String'))),
      FIELD('baseRefName', NON_NULL(SCALAR('String'))),
      FIELD('mergeable', NON_NULL(OBJECT('MergeableState'))),
      FIELD('url', NON_NULL(SCALAR('String'))),
      FIELD('author', OBJECT('User')),
      FIELD('createdAt', SCALAR('String')),
      FIELD('updatedAt', SCALAR('String')),
      FIELD('closedAt', SCALAR('String')),
      FIELD('files', OBJECT('PullRequestChangedFileConnection'), [
        { name: 'first', type: SCALAR('Int') },
        { name: 'after', type: SCALAR('String') },
      ]),
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      FIELD('id', NON_NULL(SCALAR('ID'))),
      FIELD('login', NON_NULL(SCALAR('String'))),
      FIELD('name', SCALAR('String')),
      FIELD('email', SCALAR('String')),
      FIELD('url', NON_NULL(SCALAR('String'))),
    ],
  },
  Ref: { kind: 'OBJECT', fields: [FIELD('name', NON_NULL(SCALAR('String')))] },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      FIELD('nodes', LIST(OBJECT('Issue'))),
      FIELD('edges', LIST(OBJECT('IssueEdge'))),
      FIELD('pageInfo', NON_NULL(OBJECT('PageInfo'))),
      FIELD('totalCount', NON_NULL(SCALAR('Int'))),
    ],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: [FIELD('node', OBJECT('Issue')), FIELD('cursor', NON_NULL(SCALAR('String')))],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      FIELD('nodes', LIST(OBJECT('PullRequest'))),
      FIELD('edges', LIST(OBJECT('PullRequestEdge'))),
      FIELD('pageInfo', NON_NULL(OBJECT('PageInfo'))),
      FIELD('totalCount', NON_NULL(SCALAR('Int'))),
    ],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: [FIELD('node', OBJECT('PullRequest')), FIELD('cursor', NON_NULL(SCALAR('String')))],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      FIELD('nodes', LIST(OBJECT('PullRequestChangedFile'))),
      FIELD('edges', LIST(OBJECT('PullRequestChangedFileEdge'))),
      FIELD('pageInfo', NON_NULL(OBJECT('PageInfo'))),
      FIELD('totalCount', NON_NULL(SCALAR('Int'))),
    ],
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: [FIELD('node', OBJECT('PullRequestChangedFile')), FIELD('cursor', NON_NULL(SCALAR('String')))],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [
      FIELD('path', NON_NULL(SCALAR('String'))),
      FIELD('additions', SCALAR('Int')),
      FIELD('deletions', SCALAR('Int')),
      FIELD('changeType', SCALAR('String')),
    ],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: [
      FIELD('nodes', LIST(OBJECT('IssueComment'))),
      FIELD('edges', LIST(OBJECT('IssueCommentEdge'))),
      FIELD('pageInfo', NON_NULL(OBJECT('PageInfo'))),
      FIELD('totalCount', NON_NULL(SCALAR('Int'))),
    ],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [FIELD('node', OBJECT('IssueComment')), FIELD('cursor', NON_NULL(SCALAR('String')))],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      FIELD('id', NON_NULL(SCALAR('ID'))),
      FIELD('body', NON_NULL(SCALAR('String'))),
      FIELD('author', OBJECT('User')),
      FIELD('createdAt', SCALAR('String')),
      FIELD('updatedAt', SCALAR('String')),
    ],
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: [
      FIELD('nodes', LIST(OBJECT('Label'))),
      FIELD('edges', LIST(OBJECT('LabelEdge'))),
      FIELD('pageInfo', NON_NULL(OBJECT('PageInfo'))),
      FIELD('totalCount', NON_NULL(SCALAR('Int'))),
    ],
  },
  LabelEdge: {
    kind: 'OBJECT',
    fields: [FIELD('node', OBJECT('Label')), FIELD('cursor', NON_NULL(SCALAR('String')))],
  },
  Label: {
    kind: 'OBJECT',
    fields: [
      FIELD('id', NON_NULL(SCALAR('ID'))),
      FIELD('name', NON_NULL(SCALAR('String'))),
      FIELD('color', NON_NULL(SCALAR('String'))),
      FIELD('description', SCALAR('String')),
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      FIELD('hasNextPage', NON_NULL(SCALAR('Boolean'))),
      FIELD('hasPreviousPage', NON_NULL(SCALAR('Boolean'))),
      FIELD('startCursor', SCALAR('String')),
      FIELD('endCursor', SCALAR('String')),
    ],
  },
  Node: { kind: 'INTERFACE', fields: [FIELD('id', NON_NULL(SCALAR('ID')))] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: NON_NULL(OBJECT('IssueOrderField')) },
      { name: 'direction', type: NON_NULL(OBJECT('OrderDirection')) },
    ],
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: NON_NULL(SCALAR('ID')) },
      { name: 'title', type: NON_NULL(SCALAR('String')) },
      { name: 'body', type: SCALAR('String') },
      { name: 'clientMutationId', type: SCALAR('String') },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'issueId', type: NON_NULL(SCALAR('ID')) },
      { name: 'clientMutationId', type: SCALAR('String') },
    ],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: NON_NULL(SCALAR('ID')) },
      { name: 'baseRefName', type: NON_NULL(SCALAR('String')) },
      { name: 'headRefName', type: NON_NULL(SCALAR('String')) },
      { name: 'title', type: NON_NULL(SCALAR('String')) },
      { name: 'body', type: SCALAR('String') },
      { name: 'clientMutationId', type: SCALAR('String') },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: NON_NULL(SCALAR('ID')) },
      { name: 'mergeMethod', type: OBJECT('PullRequestMergeMethod') },
      { name: 'clientMutationId', type: SCALAR('String') },
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: NON_NULL(SCALAR('ID')) },
      { name: 'body', type: NON_NULL(SCALAR('String')) },
      { name: 'clientMutationId', type: SCALAR('String') },
    ],
  },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: [FIELD('issue', OBJECT('Issue')), FIELD('clientMutationId', SCALAR('String'))],
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: [FIELD('issue', OBJECT('Issue')), FIELD('clientMutationId', SCALAR('String'))],
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: [FIELD('pullRequest', OBJECT('PullRequest')), FIELD('clientMutationId', SCALAR('String'))],
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: [FIELD('pullRequest', OBJECT('PullRequest')), FIELD('clientMutationId', SCALAR('String'))],
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: [FIELD('commentEdge', OBJECT('IssueCommentEdge')), FIELD('clientMutationId', SCALAR('String'))],
  },
  __Type: {
    kind: 'OBJECT',
    fields: [
      FIELD('name', SCALAR('String')),
      FIELD('kind', NON_NULL(SCALAR('String'))),
      FIELD('description', SCALAR('String')),
      FIELD('fields', LIST(OBJECT('__Field')), [{ name: 'includeDeprecated', type: SCALAR('Boolean') }]),
      FIELD('enumValues', LIST(OBJECT('__EnumValue')), [{ name: 'includeDeprecated', type: SCALAR('Boolean') }]),
      FIELD('inputFields', LIST(OBJECT('__InputValue'))),
      FIELD('interfaces', LIST(OBJECT('__Type'))),
      FIELD('possibleTypes', LIST(OBJECT('__Type'))),
    ],
  },
  __Field: {
    kind: 'OBJECT',
    fields: [
      FIELD('name', NON_NULL(SCALAR('String'))),
      FIELD('description', SCALAR('String')),
      FIELD('args', LIST(OBJECT('__InputValue'))),
      FIELD('type', NON_NULL(OBJECT('__Type'))),
    ],
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: [
      FIELD('name', NON_NULL(SCALAR('String'))),
      FIELD('description', SCALAR('String')),
      FIELD('type', NON_NULL(OBJECT('__Type'))),
      FIELD('defaultValue', SCALAR('String')),
    ],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: [
      FIELD('name', NON_NULL(SCALAR('String'))),
      FIELD('description', SCALAR('String')),
      FIELD('isDeprecated', NON_NULL(SCALAR('Boolean'))),
      FIELD('deprecationReason', SCALAR('String')),
    ],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: [
      FIELD('queryType', NON_NULL(OBJECT('__Type'))),
      FIELD('mutationType', OBJECT('__Type')),
      FIELD('types', LIST(OBJECT('__Type'))),
      FIELD('directives', LIST(OBJECT('__Directive'))),
    ],
  },
  __Directive: {
    kind: 'OBJECT',
    fields: [FIELD('name', NON_NULL(SCALAR('String'))), FIELD('description', SCALAR('String'))],
  },
};

function typeRefValue(ref: TypeRef): ValueObject {
  return { __typename: '__Type', name: ref.name, kind: ref.kind, ofType: ref.ofType === null ? null : typeRefValue(ref.ofType) };
}

function introspectionType(name: string): ValueObject | null {
  const def = SCHEMA_TYPES[name];
  if (def === undefined) return null;
  const value: ValueObject = { __typename: '__Type', name, kind: def.kind, description: null };
  if (def.fields !== undefined) {
    value.fields = def.fields.map((field) => ({
      __typename: '__Field',
      name: field.name,
      description: null,
      args: field.args.map((arg) => ({ __typename: '__InputValue', name: arg.name, description: null, type: typeRefValue(arg.type), defaultValue: null })),
      type: typeRefValue(field.type),
    }));
  } else {
    value.fields = null;
  }
  if (def.enumValues !== undefined) {
    value.enumValues = def.enumValues.map((enumName) => ({ __typename: '__EnumValue', name: enumName, description: null, isDeprecated: false, deprecationReason: null }));
  } else {
    value.enumValues = null;
  }
  if (def.inputFields !== undefined) {
    value.inputFields = def.inputFields.map((input) => ({ __typename: '__InputValue', name: input.name, description: null, type: typeRefValue(input.type), defaultValue: null }));
  } else {
    value.inputFields = null;
  }
  value.interfaces = null;
  value.possibleTypes = null;
  return value;
}

// ---------------------------------------------------------------- resolvers

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

function findRepoByGlobalId(ctx: GraphQLContext, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository' || parsed.parts.length !== 1) return null;
  const dbId = Number(parsed.parts[0]);
  if (!Number.isInteger(dbId)) return null;
  for (const repo of ctx.store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueByGlobalId(ctx: GraphQLContext, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue' || parsed.parts.length !== 2) return null;
  const dbId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id !== dbId) continue;
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(ctx: GraphQLContext, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest' || parsed.parts.length !== 2) return null;
  const dbId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id !== dbId) continue;
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

type Resolver = (parent: ValueObject, args: Record<string, unknown>, ctx: GraphQLContext) => unknown;

const RESOLVERS: Record<string, Resolver> = {
  'Query.viewer': (parent, args, ctx) => userValue(ctx.viewer),
  'Query.repository': (parent, args, ctx) => {
    if (typeof args.owner !== 'string' || typeof args.name !== 'string') throw new GraphQLError('repository needs owner and name');
    const repo = ctx.store.getRepo(args.owner, args.name);
    return repo === undefined ? null : repoValue(repo);
  },
  'Query.node': (parent, args, ctx) => {
    if (typeof args.id !== 'string') throw new GraphQLError('node needs an id');
    const parsed = parseGlobalId(args.id);
    if (parsed === null) return null;
    if (parsed.kind === 'Repository') {
      const repo = findRepoByGlobalId(ctx, args.id);
      return repo === null ? null : repoValue(repo);
    }
    if (parsed.kind === 'Issue') {
      const found = findIssueByGlobalId(ctx, args.id);
      return found === null ? null : issueValue(found.repo, found.issue);
    }
    if (parsed.kind === 'PullRequest') {
      const found = findPullByGlobalId(ctx, args.id);
      return found === null ? null : pullValue(found.repo, found.pull);
    }
    if (parsed.kind === 'User') {
      return userValue(ctx.store.userFor(parsed.parts[0]));
    }
    return null;
  },
  'Query.__type': (parent, args) => (typeof args.name === 'string' ? introspectionType(args.name) : null),
  'Query.__schema': () => ({
    __typename: '__Schema',
    queryType: introspectionType('Query'),
    mutationType: introspectionType('Mutation'),
    types: Object.keys(SCHEMA_TYPES).map((name) => introspectionType(name)),
    directives: [],
  }),
  'Repository.id': (parent) => repoGlobalId(parent.repo as Repo),
  'Repository.databaseId': (parent) => (parent.repo as Repo).id,
  'Repository.name': (parent) => (parent.repo as Repo).name,
  'Repository.nameWithOwner': (parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
  'Repository.owner': (parent, args, ctx) => userValue(ctx.store.userFor((parent.repo as Repo).owner)),
  'Repository.defaultBranchRef': (parent) => {
    const repo = parent.repo as Repo;
    return repo.refs.has(`refs/heads/${repo.default_branch}`) ? { __typename: 'Ref', name: repo.default_branch } : null;
  },
  'Repository.viewerPermission': () => 'ADMIN',
  'Repository.hasIssuesEnabled': () => true,
  'Repository.url': (parent) => `https://github.com/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
  'Repository.description': (parent) => (parent.repo as Repo).description,
  'Repository.isPrivate': (parent) => (parent.repo as Repo).private,
  'Repository.createdAt': (parent) => (parent.repo as Repo).created_at,
  'Repository.updatedAt': (parent) => (parent.repo as Repo).updated_at,
  'Repository.issue': (parent, args) => {
    const repo = parent.repo as Repo;
    if (typeof args.number !== 'number') throw new GraphQLError('issue needs a number');
    const issue = repo.issues.find((entry) => entry.number === args.number);
    return issue === undefined ? null : issueValue(repo, issue);
  },
  'Repository.issues': (parent, args) => issueConnection(parent.repo as Repo, args),
  'Repository.pullRequest': (parent, args) => {
    const repo = parent.repo as Repo;
    if (typeof args.number !== 'number') throw new GraphQLError('pullRequest needs a number');
    const pull = repo.pulls.find((entry) => entry.number === args.number);
    return pull === undefined ? null : pullValue(repo, pull);
  },
  'Repository.pullRequests': (parent, args) => pullConnection(parent.repo as Repo, args),
  'Issue.id': (parent) => issueGlobalId(parent.repo as Repo, parent.issue as Issue),
  'Issue.databaseId': (parent) => (parent.issue as Issue).id,
  'Issue.number': (parent) => (parent.issue as Issue).number,
  'Issue.title': (parent) => (parent.issue as Issue).title,
  'Issue.body': (parent) => (parent.issue as Issue).body,
  'Issue.state': (parent) => (parent.issue as Issue).state.toUpperCase(),
  'Issue.url': (parent) => `https://github.com/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}/issues/${(parent.issue as Issue).number}`,
  'Issue.author': (parent) => userValue((parent.issue as Issue).user),
  'Issue.createdAt': (parent) => (parent.issue as Issue).created_at,
  'Issue.updatedAt': (parent) => (parent.issue as Issue).updated_at,
  'Issue.closedAt': (parent) => (parent.issue as Issue).closed_at,
  'Issue.labels': (parent, args) => labelConnection(parent.repo as Repo, parent.issue as Issue, args),
  'Issue.comments': (parent, args) => commentConnection(parent.repo as Repo, parent.issue as Issue, args),
  'PullRequest.id': (parent) => pullGlobalId(parent.repo as Repo, parent.pull as Pull),
  'PullRequest.databaseId': (parent) => (parent.pull as Pull).id,
  'PullRequest.number': (parent) => (parent.pull as Pull).number,
  'PullRequest.title': (parent) => (parent.pull as Pull).title,
  'PullRequest.body': (parent) => (parent.pull as Pull).body,
  'PullRequest.state': (parent) => (parent.pull as Pull).state.toUpperCase(),
  'PullRequest.merged': (parent) => (parent.pull as Pull).merged,
  'PullRequest.mergedAt': (parent) => (parent.pull as Pull).merged_at,
  'PullRequest.headRefName': (parent) => (parent.pull as Pull).headRef,
  'PullRequest.baseRefName': (parent) => (parent.pull as Pull).baseRef,
  'PullRequest.mergeable': (parent) => {
    const pull = parent.pull as Pull;
    if (pull.state !== 'open') return 'UNKNOWN';
    return pullConflicts(parent.repo as Repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  },
  'PullRequest.url': (parent) => `https://github.com/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}/pull/${(parent.pull as Pull).number}`,
  'PullRequest.author': (parent) => userValue((parent.pull as Pull).user),
  'PullRequest.createdAt': (parent) => (parent.pull as Pull).created_at,
  'PullRequest.updatedAt': (parent) => (parent.pull as Pull).updated_at,
  'PullRequest.closedAt': (parent) => (parent.pull as Pull).closed_at,
  'PullRequest.files': (parent, args) => filesConnection(parent.repo as Repo, parent.pull as Pull, args),
  'IssueComment.id': (parent) => commentGlobalId(parent.repo as Repo, parent.issue as Issue, parent.comment as Comment),
  'IssueComment.body': (parent) => (parent.comment as Comment).body,
  'IssueComment.author': (parent) => userValue((parent.comment as Comment).user),
  'IssueComment.createdAt': (parent) => (parent.comment as Comment).created_at,
  'IssueComment.updatedAt': (parent) => (parent.comment as Comment).updated_at,
  'User.id': (parent) => userGlobalId(parent.user as StoreUser),
  'User.login': (parent) => (parent.user as StoreUser).login,
  'User.name': (parent) => (parent.user as StoreUser).name,
  'User.email': (parent) => (parent.user as StoreUser).email,
  'User.url': (parent) => `https://github.com/${(parent.user as StoreUser).login}`,
  'Mutation.createIssue': (parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(ctx, input.repositoryId);
    if (repo === null) throw new GraphQLError('createIssue: unknown repository');
    if (typeof input.title !== 'string' || input.title === '') throw new GraphQLError('createIssue: title is required');
    const now = new Date().toISOString();
    const issue: Issue = {
      id: ctx.store.newObjectId(),
      number: repo.nextNumber,
      title: input.title,
      body: typeof input.body === 'string' ? input.body : null,
      state: 'open',
      labels: [],
      user: ctx.viewer,
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  },
  'Mutation.closeIssue': (parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = findIssueByGlobalId(ctx, input.issueId);
    if (found === null) throw new GraphQLError('closeIssue: unknown issue');
    found.issue.state = 'closed';
    found.issue.closed_at = new Date().toISOString();
    found.issue.updated_at = new Date().toISOString();
    return { __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  },
  'Mutation.createPullRequest': (parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(ctx, input.repositoryId);
    if (repo === null) throw new GraphQLError('createPullRequest: unknown repository');
    const headRef = input.headRefName as string | undefined;
    const baseRef = input.baseRefName as string | undefined;
    if (typeof headRef !== 'string' || typeof baseRef !== 'string') throw new GraphQLError('createPullRequest: headRefName and baseRefName are required');
    if (repo.refs.get(`refs/heads/${headRef}`) === undefined) throw new GraphQLError('createPullRequest: head branch does not exist');
    if (repo.refs.get(`refs/heads/${baseRef}`) === undefined) throw new GraphQLError('createPullRequest: base branch does not exist');
    if (typeof input.title !== 'string' || input.title === '') throw new GraphQLError('createPullRequest: title is required');
    const now = new Date().toISOString();
    const pull: Pull = {
      id: ctx.store.newObjectId(),
      number: repo.nextNumber,
      title: input.title,
      body: typeof input.body === 'string' ? input.body : null,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      baseRef,
      user: ctx.viewer,
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  },
  'Mutation.mergePullRequest': (parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = findPullByGlobalId(ctx, input.pullRequestId);
    if (found === null) throw new GraphQLError('mergePullRequest: unknown pull request');
    if (found.pull.merged) throw new GraphQLError('mergePullRequest: pull request is already merged');
    if (found.pull.state !== 'open') throw new GraphQLError('mergePullRequest: pull request is closed');
    if (pullConflicts(found.repo, found.pull)) throw new GraphQLError('mergePullRequest: merge conflict');
    const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
    mergePull(found.repo, found.pull, method);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(found.repo, found.pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  },
  'Mutation.addComment': (parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (typeof input.body !== 'string' || input.body === '') throw new GraphQLError('addComment: body is required');
    const issueFound = findIssueByGlobalId(ctx, input.subjectId);
    const pullFound = issueFound === null ? findPullByGlobalId(ctx, input.subjectId) : null;
    const now = new Date().toISOString();
    const comment: Comment = { id: ctx.store.newCommentId(), body: input.body, user: ctx.viewer, created_at: now, updated_at: now };
    if (issueFound !== null) {
      issueFound.issue.comments.push(comment);
      issueFound.issue.updated_at = now;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentValue(issueFound.repo, issueFound.issue, comment), cursor: cursorFor(comment.id) },
        clientMutationId: (input.clientMutationId as string | undefined) ?? null,
      };
    }
    if (pullFound !== null) {
      pullFound.pull.comments.push(comment);
      pullFound.pull.updated_at = now;
      const pseudoIssue = { number: pullFound.pull.number } as Issue;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentValue(pullFound.repo, pseudoIssue, comment), cursor: cursorFor(comment.id) },
        clientMutationId: (input.clientMutationId as string | undefined) ?? null,
      };
    }
    throw new GraphQLError('addComment: unknown subject');
  },
};

// ---------------------------------------------------------------- execution

interface ErrorEntry {
  message: string;
  path: Array<string | number>;
}

function resolveField(parent: ValueObject, fieldName: string, args: Record<string, unknown>, ctx: GraphQLContext): unknown {
  const key = `${parent.__typename}.${fieldName}`;
  const resolver = RESOLVERS[key];
  if (resolver !== undefined) return resolver(parent, args, ctx);
  // Plain-data parents (connections, edges, pageInfo, payloads, introspection
  // values, type refs) expose their fields directly.
  if (fieldName in parent) return parent[fieldName];
  throw new GraphQLError(`Cannot query field "${fieldName}" on type "${parent.__typename}".`);
}

function executeSelections(
  parent: ValueObject,
  selections: SelectionNode[],
  variables: Variables,
  ctx: GraphQLContext,
  doc: DocumentNode,
  errors: ErrorEntry[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) {
        // The Node interface resolves through concrete types; an inline fragment
        // on an interface the parent implements also applies.
        if (!(parent.__typename === 'Repository' || parent.__typename === 'Issue' || parent.__typename === 'PullRequest' || parent.__typename === 'User') || selection.typeCondition !== 'Node') {
          continue;
        }
      }
      Object.assign(out, executeSelections(parent, selection.selections, variables, ctx, doc, errors, path));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".`, path: [...path] });
        continue;
      }
      if (fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(parent, fragment.selections, variables, ctx, doc, errors, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = parent.__typename;
      continue;
    }
    let value: unknown;
    try {
      const args = evalArgs(selection.args, variables);
      value = resolveField(parent, selection.name, args, ctx);
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, selection.selections, variables, ctx, doc, errors, fieldPath);
  }
  return out;
}

function completeValue(
  value: unknown,
  selections: SelectionNode[],
  variables: Variables,
  ctx: GraphQLContext,
  doc: DocumentNode,
  errors: ErrorEntry[],
  path: Array<string | number>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(entry, selections, variables, ctx, doc, errors, [...path, index]));
  }
  if (typeof value === 'object') {
    return executeSelections(value as ValueObject, selections, variables, ctx, doc, errors, path);
  }
  return value;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: ErrorEntry[];
}

export function executeGraphQL(body: unknown, ctx: GraphQLContext): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(entry, ctx));
  }
  return executeOne(body, ctx);
}

function executeOne(body: unknown, ctx: GraphQLContext): GraphQLResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query.', path: [] }] };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.query !== 'string') {
    return { data: null, errors: [{ message: 'Request body must include a query string.', path: [] }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(record.query).parse();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Document parse error', path: [] }] };
  }
  const variables = (record.variables ?? {}) as Variables;
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) {
    return { data: null, errors: [{ message: 'Variables must be an object.', path: [] }] };
  }
  let operation: OperationNode | undefined;
  if (typeof record.operationName === 'string' && record.operationName !== '') {
    operation = doc.operations.find((entry) => entry.name === record.operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${record.operationName}".`, path: [] }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Document contains no operations.', path: [] }] };
  } else {
    return { data: null, errors: [{ message: 'Document contains multiple operations; operationName is required.', path: [] }] };
  }
  const mergedVariables: Variables = { ...variables };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue !== null) {
      mergedVariables[variable.name] = evalValue(variable.defaultValue, mergedVariables);
    }
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: ValueObject = { __typename: rootType };
  const errors: ErrorEntry[] = [];
  const data = executeSelections(root, operation.selections, mergedVariables, ctx, doc, errors, []);
  const result: GraphQLResult = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

// Re-exported for the MCP module.
export { userJson };
