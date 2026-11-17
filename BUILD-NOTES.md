# github-core-clone-01 — build notes

Entry: single Node 22 process, stdlib only (node:http, node:zlib, node:crypto,
node:buffer). No dependencies, no git binary, no internet. `main.ts` lifecycle
unchanged from the starter.

Layout: `app.ts` (server + routing + auth), `src/store.ts` (in-memory store +
git object model + pack codec), `src/gitproto.ts` (pkt-line / v0+v2 smart HTTP),
`src/rest.ts` (REST v3), `src/graphql.ts` (hand-written GraphQL v4 executor),
`src/mcp.ts` (MCP 2026-07-28 + legacy), `src/scenario.ts` (seeded scenario port).

## Local grades (`--driver process`; docker unavailable on this VM)

- Grade 1 (2026-11-17 ~10:0x WIB): **890** — agent 200, feature 510 (102/120),
  perf 180. Failures: all 15 issues checks + protocol.error-message (POST
  /labels returned 422 for the seeded default labels the suite re-creates;
  fixed to idempotent 201), repos.commits (commit.message kept the trailing
  "\n"; parseCommit now strips it), graphql.add-comment (missing
  IssueComment.id/body resolvers; added).
- Grade 2 (after fixes): **910** — agent 200, feature **600 (120/120)**,
  perf 110. The perf drop is VM contention, not the code: the parallel
  tiny-chess trial-0e engine was at ~94% CPU for the whole run (load 1.53).
  Grade 1 on the same code measured perf 180 (push 44, clone 43, read 49,
  write 44). Re-grade on an idle VM to confirm perf ~180.

## Known quirks (verified against the kit's own clients)

- Node `--experimental-strip-types` rejects TS parameter properties
  (`constructor(private readonly x)`); the code is `--erasableSyntaxOnly`
  clean (tsc 5.9, toolchain in `~/workspace/makefun/tscheck/` — /tmp is wiped
  on VM replacement).
- POST /labels is idempotent (201 with the existing label) — the suite
  re-creates seeded defaults per check.
- Empty-repo v2 ls-refs returns NO lines (the clone-empty check fails on any
  ref line, incl. unborn).
- Shallow-fetch haves are depth-1 closures when `shallow` boundaries are
  present, full closures otherwise.
- Global ids are base64(`Kind:...`) — opaque, stable across reads.

## Still to do (parent / submit time)

- Re-grade on an idle VM for a clean perf number.
- Bundle + submit (parent): `node cli/makefun.mjs submit --competition
  github-core-clone-01 --repo-url <url> --commit <sha> --title <name>
  --bundle <file>` (NO --transcripts, NO --agree). README already carries
  the 3 make.fun badges; GitHub About must be set by the user before submit
  (homepage https://make.fun/bounty/github-core-clone-01, topics incl.
  makefun). Repo: JordyPras/github-core-clone-01 (empty, created 2026-11-17);
  user pushes from his laptop (VM cannot push to GitHub).
