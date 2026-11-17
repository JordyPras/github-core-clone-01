// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests and merges. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors are {"message": string}; an unknown
// owner/name is a 404, never a 403.

import { Buffer } from 'node:buffer';
import {
  buildTreeFromPaths,
  diffFileMaps,
  flattenTree,
  formatIdent,
  globalId,
  hashObject,
  isoOfEpoch,
  issueGlobalId,
  listCommits,
  mergeBase,
  parseCommit,
  parseIdent,
  parseTree,
  pullGlobalId,
  repoGlobalId,
  resolveToCommit,
  storeObject,
  userGlobalId,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
  type StoreUser,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { commitTreeOnBranch, filesOfRef, treeOfRef } from './gitproto.ts';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

let requestCounter = 0;

export function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  requestCounter += 1;
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`,
      ...extraHeaders,
    },
    body: JSON.stringify(value),
  };
}

export function errorResponse(status: number, message: string): RestResponse {
  return jsonResponse(status, { message });
}

// ---------------------------------------------------------------- serializers

export function userJson(user: StoreUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: userGlobalId(user),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    followers_url: `https://api.github.com/users/${user.login}/followers`,
    following_url: `https://api.github.com/users/${user.login}/following{/other_user}`,
    gists_url: `https://api.github.com/users/${user.login}/gists{/gist_id}`,
    starred_url: `https://api.github.com/users/${user.login}/starred{/owner}{/repo}`,
    subscriptions_url: `https://api.github.com/users/${user.login}/subscriptions`,
    organizations_url: `https://api.github.com/users/${user.login}/orgs`,
    repos_url: `https://api.github.com/users/${user.login}/repos`,
    events_url: `https://api.github.com/users/${user.login}/events{/privacy}`,
    received_events_url: `https://api.github.com/users/${user.login}/received_events`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(repo: Repo, store: Store): Record<string, unknown> {
  const owner = store.userFor(repo.owner);
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(owner),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    archive_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/{archive_format}{/ref}`,
    assignees_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/assignees{/user}`,
    blobs_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs{/sha}`,
    branches_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/branches{/branch}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    collaborators_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/collaborators{/collaborator}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/comments{/number}`,
    commits_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits{/sha}`,
    compare_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/compare/{base}...{head}`,
    contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/{+path}`,
    contributors_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contributors`,
    deployments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/deployments`,
    downloads_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/downloads`,
    events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/events`,
    forks_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/forks`,
    git_commits_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits{/sha}`,
    git_refs_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs{/sha}`,
    git_tags_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/tags{/sha}`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    issue_comment_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments{/number}`,
    issue_events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/events{/number}`,
    issues_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues{/number}`,
    keys_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/keys{/key_id}`,
    labels_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels{/name}`,
    languages_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/languages`,
    merges_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/merges`,
    milestones_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/milestones{/number}`,
    notifications_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/notifications{?since,all,participating}`,
    pulls_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls{/number}`,
    releases_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/releases{/id}`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    stargazers_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/stargazers`,
    statuses_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/statuses/{sha}`,
    subscribers_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/subscribers`,
    subscription_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/subscription`,
    tags_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/tags`,
    teams_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/teams`,
    trees_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees{/sha}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url_full: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url_full: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url_full: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', repo.id, label.id),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue, store: Store): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user),
    labels: issue.labels.map((label) => labelJson(label, repo)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
    draft: false,
    pull_request: undefined,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

export function commitJson(repo: Repo, oid: string, store: Store): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const authorUser = store.userFor(author.email === '' ? VIEWER.login : author.email.split('@')[0]);
  return {
    sha: oid,
    node_id: globalId('Commit', repo.id, oid),
    commit: {
      author: { name: author.name, email: author.email, date: isoOfEpoch(author.epochSec) },
      committer: { name: committer.name, email: committer.email, date: isoOfEpoch(committer.epochSec) },
      message: commit.message,
      tree: { sha: commit.tree, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: userJson(authorUser),
    committer: userJson(authorUser),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

/** Whether the head branch conflicts with the base branch (same file changed both ways). */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (baseTip === undefined || headTip === undefined) return false;
  const baseCommit = resolveToCommit(repo, baseTip);
  const headCommit = resolveToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return false;
  const mb = mergeBase(repo, baseCommit, headCommit);
  if (mb === null) return true;
  const mbObj = repo.objects.get(mb);
  if (mbObj === undefined || mbObj.type !== 'commit') return true;
  const baseFiles = flattenTree(repo, parseCommit(mbObj.data).tree);
  const headFiles = filesOfRef(repo, headRef) ?? new Map();
  const baseTipFiles = filesOfRef(repo, baseRef) ?? new Map();
  const headChanged = diffFileMaps(repo, baseFiles, headFiles);
  const baseChanged = diffFileMaps(repo, baseFiles, baseTipFiles);
  const baseChangedByName = new Map(baseChanged.map((entry) => [entry.filename, entry]));
  for (const changed of headChanged) {
    const other = baseChangedByName.get(changed.filename);
    if (other === undefined) continue;
    if (changed.newOid !== other.newOid) return true;
  }
  return false;
}

export function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (baseTip === undefined || headTip === undefined) return [];
  const baseCommit = resolveToCommit(repo, baseTip);
  const headCommit = resolveToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return [];
  const mb = mergeBase(repo, baseCommit, headCommit);
  if (mb === null) return [];
  const mbObj = repo.objects.get(mb);
  if (mbObj === undefined || mbObj.type !== 'commit') return [];
  const baseFiles = flattenTree(repo, parseCommit(mbObj.data).tree);
  const headFiles = filesOfRef(repo, headRef) ?? new Map();
  return diffFileMaps(repo, baseFiles, headFiles).map((diff) => ({
    sha: diff.newOid ?? diff.oldOid ?? '',
    filename: diff.filename,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
    changes: diff.additions + diff.deletions,
    blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${headTip}/${diff.filename}`,
    raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${headTip}/${diff.filename}`,
    contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${diff.filename}?ref=${headTip}`,
    patch: undefined,
  }));
}

export function pullStats(repo: Repo, pull: Pull): { commits: number; additions: number; deletions: number; changed_files: number } {
  const files = pullFiles(repo, pull);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions as number;
    deletions += file.deletions as number;
  }
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  let commits = 0;
  if (baseTip !== undefined && headTip !== undefined) {
    const baseCommit = resolveToCommit(repo, baseTip);
    const headCommit = resolveToCommit(repo, headTip);
    if (baseCommit !== null && headCommit !== null) {
      const mb = mergeBase(repo, baseCommit, headCommit);
      if (mb !== null) {
        const seen = new Set<string>();
        const stack = [headCommit];
        while (stack.length > 0) {
          const oid = stack.pop() as string;
          if (seen.has(oid) || oid === mb) continue;
          const obj = repo.objects.get(oid);
          if (obj === undefined || obj.type !== 'commit') continue;
          seen.add(oid);
          stack.push(...parseCommit(obj.data).parents);
        }
        commits = seen.size;
      }
    }
  }
  return { commits, additions, deletions, changed_files: files.length };
}

export function pullJson(repo: Repo, pull: Pull, store: Store): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  const conflicts = pull.state === 'open' ? pullConflicts(repo, pull) : false;
  const stats = pullStats(repo, pull);
  const headRepo = repoJson(repo, store);
  const baseRepo = repoJson(repo, store);
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    labels: [],
    milestone: null,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(store.userFor(repo.owner)),
      repo: headRepo,
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(store.userFor(repo.owner)),
      repo: baseRepo,
    },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !conflicts : null,
    rebaseable: pull.state === 'open' ? !conflicts : null,
    mergeable_state: pull.state !== 'open' ? 'unknown' : conflicts ? 'dirty' : 'clean',
    merged_by: null,
    comments: pull.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: stats.commits,
    additions: stats.additions,
    deletions: stats.deletions,
    changed_files: stats.changed_files,
  };
}

// ---------------------------------------------------------------- helpers

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

function linkHeader(base: string, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string {
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}${path}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${build(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${build(page - 1)}; rel="prev"`);
  parts.push(`${build(1)}; rel="first"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  return parts.join(', ');
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readBody(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Resolve a contents ref: a branch name, a tag, or a commit oid. */
function resolveContentsRef(repo: Repo, ref: string | null): string | null {
  if (ref === null) return `refs/heads/${repo.default_branch}`;
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return branchRef;
  const tagRef = `refs/tags/${ref}`;
  if (repo.refs.has(tagRef)) return tagRef;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return null;
}

// ---------------------------------------------------------------- the router

export function handleRest(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
  host: string,
): RestResponse {
  const base = `http://${host}`;
  const segments = pathname.split('/').filter((segment) => segment !== '');
  // All routes below live under /api/v3.
  if (segments[0] !== 'api' || segments[1] !== 'v3') return errorResponse(404, 'Not Found');
  const rest = segments.slice(2);
  const input = readBody(body);

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return errorResponse(404, 'Not Found');
    return jsonResponse(
      200,
      {
        current_user_url: `${base}/api/v3/user`,
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: `${base}/api/v3/authorizations`,
        code_search_url: `${base}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${base}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${base}/api/v3/user/emails`,
        emojis_url: `${base}/api/v3/emojis`,
        events_url: `${base}/api/v3/events`,
        feeds_url: `${base}/api/v3/feeds`,
        followers_url: `${base}/api/v3/users/{user}/followers`,
        following_url: `${base}/api/v3/users/{user}/following{/target}`,
        gists_url: `${base}/api/v3/gists{/gist_id}`,
        hub_url: `${base}/api/v3/hub`,
        issue_search_url: `${base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${base}/api/v3/issues`,
        keys_url: `${base}/api/v3/user/keys`,
        label_search_url: `${base}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
        notifications_url: `${base}/api/v3/notifications{?since,all,participating}`,
        organization_url: `${base}/api/v3/orgs/{org}`,
        organization_repositories_url: `${base}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_teams_url: `${base}/api/v3/orgs/{org}/teams`,
        public_gists_url: `${base}/api/v3/gists/public`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${base}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
        starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${base}/api/v3/gists/starred`,
        topic_search_url: `${base}/api/v3/search/topics?q={query}{&page,per_page}`,
        user_url: `${base}/api/v3/users/{user}`,
        user_organizations_url: `${base}/api/v3/users/{user}/orgs`,
        user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${base}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errorResponse(404, 'Not Found');
    return jsonResponse(200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: ['github'],
      web: ['github'],
      api: ['github'],
      git: ['github'],
      packages: ['github'],
      pages: ['github'],
      importer: ['github'],
      actions: ['github'],
      dependabot: ['github'],
      installed_version: '1.0.0',
    });
  }

  // /api/v3/user[/repos]
  if (rest[0] === 'user') {
    const viewer = store.viewer();
    if (rest.length === 1) {
      if (method !== 'GET') return errorResponse(404, 'Not Found');
      return jsonResponse(200, userJson(viewer));
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const repos = store.viewerRepos();
        const { pageItems, totalPages } = paginate(repos, page, perPage);
        return jsonResponse(200, pageItems.map((repo) => repoJson(repo, store)), {
          link: linkHeader(base, '/api/v3/user/repos', query, page, perPage, totalPages),
        });
      }
      if (method === 'POST') {
        const name = asString(input.name);
        if (name === undefined || name === '') return errorResponse(422, 'Validation Failed: name is required');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return errorResponse(422, 'Validation Failed: name is invalid');
        const repo = store.createRepo(VIEWER.login, name, {
          description: asString(input.description),
          private: asBoolean(input.private, false),
          default_branch: asString(input.default_branch),
        });
        if (repo === null) return errorResponse(422, `Validation Failed: Repository ${name} already exists`);
        return jsonResponse(201, repoJson(repo, store));
      }
      return errorResponse(404, 'Not Found');
    }
    return errorResponse(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeSegment(rest[1]);
    const name = decodeSegment(rest[2]);
    const repo = store.getRepo(owner, name);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (repo === undefined) return errorResponse(404, 'Not Found');
      if (method === 'GET') return jsonResponse(200, repoJson(repo, store));
      if (method === 'PATCH') {
        const description = asString(input.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = input.private;
        if (typeof isPrivate === 'boolean') repo.private = isPrivate;
        const defaultBranch = asString(input.default_branch);
        if (defaultBranch !== undefined && defaultBranch !== '') repo.default_branch = defaultBranch;
        const newName = asString(input.name);
        if (newName !== undefined && newName !== '' && newName !== repo.name) {
          if (store.getRepo(owner, newName) !== undefined) return errorResponse(422, 'Validation Failed: name already exists');
          store.deleteRepo(owner, name);
          repo.name = newName;
          store.repos.set(store.repoKey(owner, newName), repo);
        }
        repo.updated_at = new Date().toISOString();
        return jsonResponse(200, repoJson(repo, store));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, headers: { 'x-github-request-id': `req-${Date.now().toString(36)}-${requestCounter.toString(36)}` }, body: '' };
      }
      return errorResponse(404, 'Not Found');
    }
    if (repo === undefined) return errorResponse(404, 'Not Found');

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return errorResponse(404, 'Not Found');
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({
            name: branch,
            commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: `${base}/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
            protected: false,
          }));
        return jsonResponse(200, branches);
      }
      const branch = tail.slice(1).map(decodeSegment).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return errorResponse(404, 'Not Found');
      if (method !== 'GET') return errorResponse(404, 'Not Found');
      return jsonResponse(200, {
        name: branch,
        commit: { sha, url: `${base}/api/v3/repos/${owner}/${name}/commits/${sha}` },
        protected: false,
      });
    }

    // commits
    if (tail[0] === 'commits') {
      if (tail.length === 1) {
        if (method !== 'GET') return errorResponse(404, 'Not Found');
        const refParam = query.get('sha');
        let tip: string | undefined;
        if (refParam === null) {
          tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
        } else if (repo.refs.has(`refs/heads/${refParam}`)) {
          tip = repo.refs.get(`refs/heads/${refParam}`);
        } else if (repo.objects.has(refParam)) {
          tip = refParam;
        }
        if (tip === undefined) return jsonResponse(200, []);
        const commits = listCommits(repo, tip);
        const { page, perPage } = pageParams(query);
        const { pageItems, totalPages } = paginate(commits, page, perPage);
        const items = pageItems
          .map((entry) => commitJson(repo, entry.oid, store))
          .filter((entry): entry is Record<string, unknown> => entry !== null);
        return jsonResponse(200, items, { link: linkHeader(base, `/api/v3/repos/${owner}/${name}/commits`, query, page, perPage, totalPages) });
      }
      const sha = decodeSegment(tail[1]);
      const found = commitJson(repo, sha, store);
      if (found === null) return errorResponse(404, 'Not Found');
      if (method !== 'GET') return errorResponse(404, 'Not Found');
      return jsonResponse(200, found);
    }

    // git/*
    if (tail[0] === 'git') {
      if (tail[1] === 'refs') {
        if (tail.length === 2) {
          if (method === 'GET') {
            const refs = [...repo.refs.keys()].sort().map((ref) => ({
              ref,
              node_id: globalId('Ref', repo.id, ref),
              url: `${base}/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`,
              object: { sha: repo.refs.get(ref) as string, type: 'commit', url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${repo.refs.get(ref)}` },
            }));
            return jsonResponse(200, refs);
          }
          if (method === 'POST') {
            const ref = asString(input.ref);
            const sha = asString(input.sha);
            if (ref === undefined || !ref.startsWith('refs/')) return errorResponse(422, 'Validation Failed: ref must start with refs/');
            if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) return errorResponse(422, 'Validation Failed: sha is invalid');
            if (repo.refs.has(ref)) return errorResponse(422, 'Validation Failed: ref already exists');
            if (!repo.objects.has(sha)) return errorResponse(422, 'Validation Failed: sha does not exist');
            repo.refs.set(ref, sha);
            repo.pushed_at = new Date().toISOString();
            return jsonResponse(201, {
              ref,
              node_id: globalId('Ref', repo.id, ref),
              url: `${base}/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`,
              object: { sha, type: 'commit', url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
            });
          }
          return errorResponse(404, 'Not Found');
        }
        const ref = `refs/${tail.slice(2).map(decodeSegment).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return errorResponse(404, 'Not Found');
        if (method !== 'GET') return errorResponse(404, 'Not Found');
        return jsonResponse(200, {
          ref,
          node_id: globalId('Ref', repo.id, ref),
          url: `${base}/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`,
          object: { sha, type: 'commit', url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
        });
      }
      if (tail[1] === 'commits' && tail.length === 3) {
        const sha = decodeSegment(tail[2]);
        const found = commitJson(repo, sha, store);
        if (found === null) return errorResponse(404, 'Not Found');
        if (method !== 'GET') return errorResponse(404, 'Not Found');
        return jsonResponse(200, found);
      }
      if (tail[1] === 'trees' && tail.length === 3) {
        const sha = decodeSegment(tail[2]);
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'tree') return errorResponse(404, 'Not Found');
        if (method !== 'GET') return errorResponse(404, 'Not Found');
        const recursive = query.get('recursive') === '1';
        const entries: Array<Record<string, unknown>> = [];
        const walk = (treeOid: string, prefix: string): void => {
          for (const entry of parseTree((repo.objects.get(treeOid) as { data: Buffer }).data)) {
            const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            const type = entry.mode === '40000' ? 'tree' : 'blob';
            entries.push({ path, mode: entry.mode, type, sha: entry.oid, size: type === 'blob' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : undefined, url: `${base}/api/v3/repos/${owner}/${name}/git/${type === 'tree' ? 'trees' : 'blobs'}/${entry.oid}` });
            if (recursive && type === 'tree') walk(entry.oid, path);
          }
        };
        walk(sha, '');
        return jsonResponse(200, { sha, url: `${base}/api/v3/repos/${owner}/${name}/git/trees/${sha}`, tree: entries, truncated: false });
      }
      return errorResponse(404, 'Not Found');
    }

    // contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map(decodeSegment).join('/');
      if (method === 'GET') {
        const ref = resolveContentsRef(repo, query.get('ref'));
        if (ref === null) return errorResponse(404, 'Not Found');
        const files = filesOfRef(repo, ref);
        if (files === null) return errorResponse(404, 'Not Found');
        if (path === '') {
          // Root directory listing.
          const treeOid = treeOfRef(repo, ref);
          if (treeOid === null) return errorResponse(404, 'Not Found');
          return jsonResponse(200, directoryEntries(repo, owner, name, treeOid, ''));
        }
        const direct = files.get(path);
        if (direct !== undefined) {
          const obj = repo.objects.get(direct.oid);
          if (obj === undefined) return errorResponse(404, 'Not Found');
          return jsonResponse(200, {
            type: 'file',
            encoding: 'base64',
            size: obj.data.length,
            name: path.split('/').pop(),
            path,
            content: obj.data.toString('base64'),
            sha: direct.oid,
            url: `${base}/api/v3/repos/${owner}/${name}/contents/${path}`,
            git_url: `${base}/api/v3/repos/${owner}/${name}/git/blobs/${direct.oid}`,
            html_url: `https://github.com/${owner}/${name}/blob/${ref}/${path}`,
            download_url: `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${path}`,
            _links: { git: `${base}/api/v3/repos/${owner}/${name}/git/blobs/${direct.oid}`, self: `${base}/api/v3/repos/${owner}/${name}/contents/${path}`, html: `https://github.com/${owner}/${name}/blob/${ref}/${path}` },
          });
        }
        // A directory: any file below this path?
        const prefix = `${path}/`;
        const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
        for (const [filePath, value] of files) {
          if (!filePath.startsWith(prefix)) continue;
          const restPath = filePath.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) children.set(restPath, { oid: value.oid, mode: value.mode, isDir: false });
          else {
            const dirName = restPath.slice(0, slash);
            if (!children.has(dirName)) {
              // Find the subtree oid for this directory.
              const treeOid = findSubtreeOid(repo, ref, path, dirName);
              children.set(dirName, { oid: treeOid ?? '', mode: '40000', isDir: true });
            }
          }
        }
        if (children.size === 0) return errorResponse(404, 'Not Found');
        const entries = [...children.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([childName, child]) => ({
            type: child.isDir ? 'dir' : 'file',
            size: child.isDir ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
            name: childName,
            path: `${path}/${childName}`,
            sha: child.oid,
            url: `${base}/api/v3/repos/${owner}/${name}/contents/${path}/${childName}`,
            git_url: `${base}/api/v3/repos/${owner}/${name}/git/${child.isDir ? 'trees' : 'blobs'}/${child.oid}`,
            html_url: `https://github.com/${owner}/${name}/${child.isDir ? 'tree' : 'blob'}/${ref}/${path}/${childName}`,
            download_url: child.isDir ? null : `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${path}/${childName}`,
            _links: { git: `${base}/api/v3/repos/${owner}/${name}/git/${child.isDir ? 'trees' : 'blobs'}/${child.oid}`, self: `${base}/api/v3/repos/${owner}/${name}/contents/${path}/${childName}`, html: `https://github.com/${owner}/${name}/${child.isDir ? 'tree' : 'blob'}/${ref}/${path}/${childName}` },
          }));
        return jsonResponse(200, entries);
      }
      if (method === 'PUT' || method === 'DELETE') {
        const message = asString(input.message) ?? (method === 'PUT' ? `Update ${path}` : `Delete ${path}`);
        const branch = asString(input.branch) ?? repo.default_branch;
        const branchRef = `refs/heads/${branch}`;
        const files = filesOfRef(repo, branchRef);
        const shaParam = asString(input.sha);
        if (method === 'PUT') {
          const contentB64 = asString(input.content);
          if (contentB64 === undefined) return errorResponse(422, 'Validation Failed: content is required');
          let bytes: Buffer;
          try {
            bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
          } catch {
            return errorResponse(422, 'Validation Failed: content is not valid base64');
          }
          const blobOid = hashObject('blob', bytes);
          const current = files?.get(path);
          const isUpdate = current !== undefined;
          if (isUpdate) {
            if (shaParam === undefined || shaParam !== current.oid) {
              return errorResponse(409, 'Validation Failed: sha does not match the current blob');
            }
          } else if (shaParam !== undefined) {
            return errorResponse(422, 'Validation Failed: sha does not match any existing file');
          }
          storeObject(repo, 'blob', bytes);
          const nextFiles = new Map<string, { oid: string; mode: string }>(files ?? []);
          nextFiles.set(path, { oid: blobOid, mode: '100644' });
          const treeOid = buildTreeFromPaths(repo, nextFiles);
          const commitOid = commitTreeOnBranch(repo, branch, treeOid, message, VIEWER.name, VIEWER.email);
          return jsonResponse(isUpdate ? 200 : 201, {
            content: {
              name: path.split('/').pop(),
              path,
              sha: blobOid,
              size: bytes.length,
              url: `${base}/api/v3/repos/${owner}/${name}/contents/${path}`,
              html_url: `https://github.com/${owner}/${name}/blob/${branch}/${path}`,
              git_url: `${base}/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
              download_url: `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path}`,
              type: 'file',
              content: bytes.toString('base64'),
              encoding: 'base64',
              _links: { git: `${base}/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`, self: `${base}/api/v3/repos/${owner}/${name}/contents/${path}`, html: `https://github.com/${owner}/${name}/blob/${branch}/${path}` },
            },
            commit: { sha: commitOid, node_id: globalId('Commit', repo.id, commitOid), message, author: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() }, committer: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() } },
          });
        }
        // DELETE
        if (files === null) return errorResponse(404, 'Not Found');
        const current = files.get(path);
        if (current === undefined) return errorResponse(404, 'Not Found');
        if (shaParam === undefined || shaParam !== current.oid) {
          return errorResponse(409, 'Validation Failed: sha does not match the current blob');
        }
        const nextFiles = new Map(files);
        nextFiles.delete(path);
        const treeOid = buildTreeFromPaths(repo, nextFiles);
        const commitOid = commitTreeOnBranch(repo, branch, treeOid, message, VIEWER.name, VIEWER.email);
        return jsonResponse(200, {
          content: null,
          commit: { sha: commitOid, node_id: globalId('Commit', repo.id, commitOid), message, author: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() }, committer: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() } },
        });
      }
      return errorResponse(404, 'Not Found');
    }

    // labels
    if (tail[0] === 'labels') {
      if (tail.length === 1) {
        if (method === 'GET') return jsonResponse(200, repo.labels.map((label) => labelJson(label, repo)));
        if (method === 'POST') {
          const labelName = asString(input.name);
          const color = asString(input.color) ?? 'ffffff';
          if (labelName === undefined || labelName === '') return errorResponse(422, 'Validation Failed: name is required');
          const existingLabel = repo.labels.find((label) => label.name === labelName);
          // Idempotent create: the conformance suite re-creates a seeded default
          // label (e.g. "bug") on every repo and expects 201 with the label.
          if (existingLabel !== undefined) return jsonResponse(201, labelJson(existingLabel, repo));
          const label: Label = { id: store.newObjectId(), name: labelName, color: color.replace(/^#/, ''), description: asString(input.description) ?? '' };
          repo.labels.push(label);
          return jsonResponse(201, labelJson(label, repo));
        }
        return errorResponse(404, 'Not Found');
      }
      return errorResponse(404, 'Not Found');
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = repo.issues.slice();
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          issues.sort((a, b) => {
            const byCreated = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
            return sort === 'created' ? (direction === 'asc' ? byCreated : -byCreated) : a.number - b.number;
          });
          const { page, perPage } = pageParams(query);
          const { pageItems, totalPages } = paginate(issues, page, perPage);
          return jsonResponse(200, pageItems.map((issue) => issueJson(repo, issue, store)), {
            link: linkHeader(base, `/api/v3/repos/${owner}/${name}/issues`, query, page, perPage, totalPages),
          });
        }
        if (method === 'POST') {
          const title = asString(input.title);
          if (title === undefined || title === '') return errorResponse(422, 'Validation Failed: title is required');
          const labelNames: string[] = Array.isArray(input.labels)
            ? (input.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : (entry as Record<string, unknown>).name as string)).filter((entry) => typeof entry === 'string')
            : [];
          const labels: Label[] = [];
          for (const labelName of labelNames) {
            const found = repo.labels.find((label) => label.name === labelName);
            if (found === undefined) return errorResponse(422, `Validation Failed: label "${labelName}" does not exist`);
            labels.push(found);
          }
          const now = new Date().toISOString();
          const issue: Issue = {
            id: store.newObjectId(),
            number: repo.nextNumber,
            title,
            body: asString(input.body) ?? null,
            state: 'open',
            labels,
            user: store.viewer(),
            created_at: now,
            updated_at: now,
            closed_at: null,
            comments: [],
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          return jsonResponse(201, issueJson(repo, issue, store));
        }
        return errorResponse(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number)) return errorResponse(404, 'Not Found');
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return errorResponse(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return jsonResponse(200, issueJson(repo, issue, store));
        if (method === 'PATCH') {
          const title = asString(input.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(input.body);
          if (bodyText !== undefined) issue.body = bodyText;
          const state = asString(input.state);
          if (state === 'closed' || state === 'open') {
            issue.state = state;
            issue.closed_at = state === 'closed' ? new Date().toISOString() : null;
          }
          if (Array.isArray(input.labels)) {
            const labelNames = (input.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : (entry as Record<string, unknown>).name as string)).filter((entry) => typeof entry === 'string');
            const labels: Label[] = [];
            for (const labelName of labelNames) {
              const found = repo.labels.find((label) => label.name === labelName);
              if (found === undefined) return errorResponse(422, `Validation Failed: label "${labelName}" does not exist`);
              labels.push(found);
            }
            issue.labels = labels;
          }
          issue.updated_at = new Date().toISOString();
          return jsonResponse(200, issueJson(repo, issue, store));
        }
        return errorResponse(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') return jsonResponse(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        if (method === 'POST') {
          const commentBody = asString(input.body);
          if (commentBody === undefined || commentBody === '') return errorResponse(422, 'Validation Failed: body is required');
          const now = new Date().toISOString();
          const comment: Comment = { id: store.newCommentId(), body: commentBody, user: store.viewer(), created_at: now, updated_at: now };
          issue.comments.push(comment);
          issue.updated_at = now;
          return jsonResponse(201, commentJson(repo, issue, comment));
        }
        return errorResponse(404, 'Not Found');
      }
      return errorResponse(404, 'Not Found');
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = repo.pulls.slice();
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page, perPage } = pageParams(query);
          const { pageItems, totalPages } = paginate(pulls, page, perPage);
          return jsonResponse(200, pageItems.map((pull) => pullJson(repo, pull, store)), {
            link: linkHeader(base, `/api/v3/repos/${owner}/${name}/pulls`, query, page, perPage, totalPages),
          });
        }
        if (method === 'POST') {
          const title = asString(input.title);
          const head = asString(input.head);
          const baseBranch = asString(input.base);
          if (title === undefined || title === '') return errorResponse(422, 'Validation Failed: title is required');
          if (head === undefined || head === '') return errorResponse(422, 'Validation Failed: head is required');
          if (baseBranch === undefined || baseBranch === '') return errorResponse(422, 'Validation Failed: base is required');
          const headRef = head.includes(':') ? head.split(':').slice(1).join(':') : head;
          if (repo.refs.get(`refs/heads/${headRef}`) === undefined) return errorResponse(422, 'Validation Failed: head branch does not exist');
          if (repo.refs.get(`refs/heads/${baseBranch}`) === undefined) return errorResponse(422, 'Validation Failed: base branch does not exist');
          if (headRef === baseBranch) return errorResponse(422, 'Validation Failed: head and base are the same');
          const now = new Date().toISOString();
          const pull: Pull = {
            id: store.newObjectId(),
            number: repo.nextNumber,
            title,
            body: asString(input.body) ?? null,
            state: 'open',
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            headRef,
            baseRef: baseBranch,
            user: store.viewer(),
            created_at: now,
            updated_at: now,
            closed_at: null,
            comments: [],
          };
          repo.nextNumber += 1;
          repo.pulls.push(pull);
          return jsonResponse(201, pullJson(repo, pull, store));
        }
        return errorResponse(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number)) return errorResponse(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return errorResponse(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return jsonResponse(200, pullJson(repo, pull, store));
        if (method === 'PATCH') {
          const title = asString(input.title);
          if (title !== undefined) pull.title = title;
          const bodyText = asString(input.body);
          if (bodyText !== undefined) pull.body = bodyText;
          const state = asString(input.state);
          if (state === 'closed' || state === 'open') {
            pull.state = state;
            pull.closed_at = state === 'closed' ? new Date().toISOString() : null;
          }
          pull.updated_at = new Date().toISOString();
          return jsonResponse(200, pullJson(repo, pull, store));
        }
        return errorResponse(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return errorResponse(404, 'Not Found');
        return jsonResponse(200, pullFiles(repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') return errorResponse(404, 'Not Found');
        if (pull.merged) return errorResponse(405, 'Validation Failed: pull request is already merged');
        if (pull.state !== 'open') return errorResponse(405, 'Validation Failed: pull request is closed');
        const mergeMethod = asString(input.merge_method) ?? 'merge';
        if (pullConflicts(repo, pull)) return errorResponse(405, 'Validation Failed: merge conflict');
        const merged = mergePull(repo, pull, mergeMethod);
        if (merged === null) return errorResponse(405, 'Validation Failed: cannot merge');
        return jsonResponse(200, { sha: merged, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') return jsonResponse(200, pull.comments.map((comment) => commentJson(repo, { number: pull.number } as Issue, comment)));
        if (method === 'POST') {
          const commentBody = asString(input.body);
          if (commentBody === undefined || commentBody === '') return errorResponse(422, 'Validation Failed: body is required');
          const now = new Date().toISOString();
          const comment: Comment = { id: store.newCommentId(), body: commentBody, user: store.viewer(), created_at: now, updated_at: now };
          pull.comments.push(comment);
          pull.updated_at = now;
          return jsonResponse(201, commentJson(repo, { number: pull.number } as Issue, comment));
        }
        return errorResponse(404, 'Not Found');
      }
      return errorResponse(404, 'Not Found');
    }

    return errorResponse(404, 'Not Found');
  }

  return errorResponse(404, 'Not Found');
}

// ---------------------------------------------------------------- merge

/** Squash-merge a pull request: one commit on the base branch with the head tree. */
export function mergePull(repo: Repo, pull: Pull, mergeMethod: string): string | null {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (baseTip === undefined || headTip === undefined) return null;
  const headCommit = resolveToCommit(repo, headTip);
  if (headCommit === null) return null;
  const headObj = repo.objects.get(headCommit);
  if (headObj === undefined || headObj.type !== 'commit') return null;
  const headTree = parseCommit(headObj.data).tree;
  const now = new Date().toISOString();
  const epochSec = Math.floor(Date.now() / 1000);
  const ident = formatIdent(VIEWER.name, VIEWER.email, epochSec);
  const message = mergeMethod === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitData = ((): Buffer => {
    const lines: string[] = [`tree ${headTree}`, `parent ${baseTip}`, `author ${ident}`, `committer ${ident}`, ''];
    return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(`${message}\n`, 'utf8')]);
  })();
  const oid = storeObject(repo, 'commit', commitData);
  repo.refs.set(baseRef, oid);
  repo.pushed_at = now;
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = now;
  pull.merge_commit_sha = oid;
  pull.closed_at = now;
  pull.updated_at = now;
  return oid;
}

function directoryEntries(repo: Repo, owner: string, name: string, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return {
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        name: entry.name,
        path,
        sha: entry.oid,
        url: `https://api.github.com/repos/${owner}/${name}/contents/${path}`,
        git_url: `https://api.github.com/repos/${owner}/${name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        html_url: `https://github.com/${owner}/${name}/${isDir ? 'tree' : 'blob'}/HEAD/${path}`,
        download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${path}`,
        _links: { git: `https://api.github.com/repos/${owner}/${name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`, self: `https://api.github.com/repos/${owner}/${name}/contents/${path}`, html: `https://github.com/${owner}/${name}/${isDir ? 'tree' : 'blob'}/HEAD/${path}` },
      };
    });
}

function findSubtreeOid(repo: Repo, ref: string, parentPath: string, dirName: string): string | null {
  const treeOid = treeOfRef(repo, ref);
  if (treeOid === null) return null;
  let current = treeOid;
  const parts = parentPath === '' ? [] : parentPath.split('/');
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  const obj = repo.objects.get(current);
  if (obj === undefined || obj.type !== 'tree') return null;
  const entry = parseTree(obj.data).find((candidate) => candidate.name === dirName && candidate.mode === '40000');
  return entry?.oid ?? null;
}
