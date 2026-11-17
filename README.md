# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/JordyPras/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/JordyPras/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP (v0 + v2, pack read/write with zlib and SHA-1, no git binary), REST v3 (repositories, branches, commits, contents, labels, issues, comments, pull requests, squash merges), GraphQL v4 (the documents `gh` and `github-mcp-server` send, plus introspection and batching), and MCP over streamable HTTP (server/discover, initialize, tools/list, tools/call). Everything lives in memory; the entry binds an ephemeral port, registers with the make.fun environment, and exits when the suite says done.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install: the program imports `node:http`, `node:zlib`, `node:crypto` and its own modules only, and the trial has no package manager and no internet. `MAKEFUN_ENV_URL` must point at the environment, and `MAKEFUN_SHOP_TOKEN` must hold the bearer token the environment presents (when it is unset, any non-empty bearer token is accepted, for local development only).

## Layout

- `main.ts`: the lifecycle (bind an ephemeral port, register, poll `/done`, exit 0). Kept as the starter ships it.
- `app.ts`: the HTTP server and route dispatch.
- `src/store.ts`: the in-memory store (users, repositories, git objects, issues, pull requests) and the git object model (blob/tree/commit/tag hashing, pack read/write).
- `src/gitproto.ts`: git smart HTTP (info/refs, upload-pack, receive-pack, pkt-lines, sideband).
- `src/rest.ts`: REST v3 handlers.
- `src/graphql.ts`: GraphQL v4 executor (parser + resolvers for the documents `gh` and `github-mcp-server` send).
- `src/mcp.ts`: MCP handlers (server/discover, initialize, tools/list, tools/call).
- `src/scenario.ts`: the contest's seeded scenario identity (the viewer login the suite expects, derived from the fixed seed).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
