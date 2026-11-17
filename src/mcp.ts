// Model Context Protocol over streamable HTTP at POST /mcp (revision 2026-07-28
// era, with the legacy initialize handshake as a fallback). One JSON body per
// request; a body that is not JSON answers HTTP 400 with JSON-RPC -32700. Tools
// act on the same store as REST, so a repository or issue created over MCP is
// the same object over /api/v3, with stable ids.

import { mergePull, pullJson, issueJson, repoJson } from './rest.ts';
import { pullConflicts } from './rest.ts';
import { VIEWER } from './scenario.ts';
import { type Issue, type Pull, type Store } from './store.ts';

export const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError?: boolean;
}

function toolOk(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: ToolResult } | { rpcError: { code: number; message: string } } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = missingRequired(args, tool.inputSchema.required);
  if (missing !== null) {
    return { rpcError: { code: -32602, message: `Invalid params: missing required argument "${missing}" for tool "${name}"` } };
  }
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name) as string;
      const repo = store.createRepo(VIEWER.login, repoName, {
        description: asString(args.description),
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      if (repo === null) return { result: toolError(`Repository ${repoName} already exists`) };
      return { result: toolOk(repoJson(repo, store)) };
    }
    case 'get_repo': {
      const repo = store.getRepo(asString(args.owner) as string, asString(args.repo) as string);
      if (repo === undefined) return { result: toolError(`Repository ${args.owner}/${args.repo} not found`) };
      return { result: toolOk(repoJson(repo, store)) };
    }
    case 'create_issue': {
      const repo = store.getRepo(asString(args.owner) as string, asString(args.repo) as string);
      if (repo === undefined) return { result: toolError(`Repository ${args.owner}/${args.repo} not found`) };
      const now = new Date().toISOString();
      const issue: Issue = {
        id: store.newObjectId(),
        number: repo.nextNumber,
        title: asString(args.title) as string,
        body: asString(args.body) ?? null,
        state: 'open',
        labels: [],
        user: store.viewer(),
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return { result: toolOk(issueJson(repo, issue, store)) };
    }
    case 'list_issues': {
      const repo = store.getRepo(asString(args.owner) as string, asString(args.repo) as string);
      if (repo === undefined) return { result: toolError(`Repository ${args.owner}/${args.repo} not found`) };
      const state = asString(args.state) ?? 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      const listed = issues.map((issue) => issueJson(repo, issue, store));
      return { result: toolOk({ issues: listed, total_count: listed.length }) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(asString(args.owner) as string, asString(args.repo) as string);
      if (repo === undefined) return { result: toolError(`Repository ${args.owner}/${args.repo} not found`) };
      const head = asString(args.head) as string;
      const base = asString(args.base) as string;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return { result: toolError(`Head branch ${head} does not exist`) };
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return { result: toolError(`Base branch ${base} does not exist`) };
      const now = new Date().toISOString();
      const pull: Pull = {
        id: store.newObjectId(),
        number: repo.nextNumber,
        title: asString(args.title) as string,
        body: asString(args.body) ?? null,
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        headRef: head,
        baseRef: base,
        user: store.viewer(),
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return { result: toolOk(pullJson(repo, pull, store)) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(asString(args.owner) as string, asString(args.repo) as string);
      if (repo === undefined) return { result: toolError(`Repository ${args.owner}/${args.repo} not found`) };
      const number = asNumber(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { result: toolError(`Pull request #${number} not found`) };
      if (pull.merged) return { result: toolError(`Pull request #${number} is already merged`) };
      if (pull.state !== 'open') return { result: toolError(`Pull request #${number} is closed`) };
      if (pullConflicts(repo, pull)) return { result: toolError(`Pull request #${number} has a merge conflict`) };
      mergePull(repo, pull, 'squash');
      return { result: toolOk(pullJson(repo, pull, store)) };
    }
    case 'get_issue': {
      const repo = store.getRepo(asString(args.owner) as string, asString(args.repo) as string);
      if (repo === undefined) return { result: toolError(`Repository ${args.owner}/${args.repo} not found`) };
      const number = asNumber(args.issue_number);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return { result: toolError(`Issue #${number} not found`) };
      return { result: toolOk(issueJson(repo, issue, store)) };
    }
    case 'list_repos': {
      return { result: toolOk({ repositories: store.viewerRepos().map((repo) => repoJson(repo, store)) }) };
    }
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function jsonRpcResponse(status: number, payload: unknown): McpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) };
}

/** One POST to /mcp. Auth is enforced by the server before this runs. */
export function handleMcp(store: Store, bodyText: string): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonRpcResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRpcResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const record = body as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const method = record.method;
  // A notification (no id) gets no JSON-RPC answer.
  if (id === null || id === undefined) {
    return { status: 202, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '' };
  }
  if (typeof method !== 'string') {
    return jsonRpcResponse(400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }
  const params = (record.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return jsonRpcResponse(200, {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'DiscoverResult',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {}, logging: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      },
    });
  }
  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? '2025-11-25';
    const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return jsonRpcResponse(200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      },
    });
  }
  if (method === 'tools/list') {
    return jsonRpcResponse(200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof toolName !== 'string') {
      return jsonRpcResponse(200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: tools/call needs a tool name' } });
    }
    const outcome = callTool(store, toolName, args);
    if ('rpcError' in outcome) {
      return jsonRpcResponse(200, { jsonrpc: '2.0', id, error: outcome.rpcError });
    }
    return jsonRpcResponse(200, { jsonrpc: '2.0', id, result: outcome.result });
  }
  if (method === 'ping') {
    return jsonRpcResponse(200, { jsonrpc: '2.0', id, result: {} });
  }
  return jsonRpcResponse(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
