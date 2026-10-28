# MCP integration plan

Status: **phase 1 implemented** (2026-10-28) — `/api/mcp` with `analyze_dependencies` and `get_package_info`. First discussion: 2026-10-16.

Goal: expose the Dep-Man API as an MCP server, and later package it as a ChatGPT / Codex plugin, **without breaking the existing REST API**, which is in production and consumed by the Chrome extension and the VS Code extension.

---

## 1. Starting point (as of 2026-10-16)

- Next.js 16 wraps a single Hono app in `app/api/[...route]/route.ts` (`basePath("/api")`, `hono/vercel` `handle`). Only `GET`, `POST` and `OPTIONS` are exported.
- Domain logic in `lib/` (`package-services.ts`, `parsers.ts`, `version-utils.ts`) is already pure and reusable.
- The `POST /analyze-packages` business logic (sanitizing, name filtering, building `summary`, `buildPackageMetadata`) lives **inside the route handler**, so it cannot be reused by MCP tools as-is.
- Input validation is manual (no schema library).
- Global rate limiter: 30 req/min per IP on `*`, in-memory, per instance.
- Cache and rate limiter are in-memory, per instance.
- `cors()` is fully open.
- TypeScript 7 + `tsconfig.json` includes `**/*.ts` (test files would be type-checked by `next build`).
- No tests.

## 2. Library choice

Versions checked on the npm registry on 2026-10-16:

| Package | Version | Notes |
|---|---|---|
| `@hono/mcp` | 0.3.2 | Peer-depends on `@modelcontextprotocol/sdk ^1.29` (v1 line). Ships OAuth helpers (`simpleMcpAuthRouter`). README example uses a single global, stateful transport. |
| `@modelcontextprotocol/sdk` | 1.32.1 | Legacy v1 line. |
| **`@modelcontextprotocol/server`** | **2.3.1** | Official SDK v2, stable, targets MCP spec 2026-07-28. Requires `zod ^4.2`. |
| **`@modelcontextprotocol/hono`** | **2.0.2** | Official thin Hono adapter for SDK v2 (`createMcpHonoApp`, host header validation). |
| `mcp-handler` | 2.3.0 | Vercel adapter for Next.js without Hono — not a fit. |

**Decision (implemented):** official `@modelcontextprotocol/server` v2 (pinned at 2.4.0) with its `createMcpHandler` entry point: a fetch-shaped, stateless handler that builds a fresh `McpServer` per request and serves both the 2026-07-28 protocol and 2025-era clients (stateless legacy fallback). No `@modelcontextprotocol/hono` adapter needed — the Hono route passes `c.req.raw` straight to `handler.fetch`. Only reconsider `@hono/mcp` if its OAuth helpers are needed before it supports SDK v2.

## 3. Proposed MCP design

Endpoint: `https://api.depman.cloud/api/mcp` (same Hono app, `app.all("/mcp", …)`).

### Tools

| Tool | Input | Annotations |
|---|---|---|
| `analyze_dependencies` | `content`, `fileName?` | `readOnlyHint: true`, `openWorldHint: true` |
| `get_package_info` | `registry` (`npm` \| `pip` \| `pub`), `name`, `currentVersion?` | same |
| `check_packages` (optional) | list of `{ registry, name, version }` | same |

Each tool declares an `outputSchema` and returns `structuredContent` plus the same JSON as text in `content`.

For ChatGPT deep research / company knowledge compatibility, add read-only `search(query)` → `{ results: [{ id, title, url }] }` and `fetch(id)` → `{ id, title, text, url, metadata? }`, with ids like `npm:hono` (npm `/-/v1/search` and pub.dev search; PyPI has no JSON search API). `url` must be non-empty for ChatGPT citations.

### Implementation (phase 1)

```ts
// lib/app.ts
const mcpHandler = createMcpHandler(() => createDepmanMcpServer(), {
  maxRequestBodySize: MAX_CONTENT_SIZE + 1024 * 1024,
});
app.all("/mcp", (c) => mcpHandler.fetch(c.req.raw));
```

- `lib/mcp/server.ts` — server factory and the two tools (Zod input/output schemas, read-only annotations, `structuredContent` + JSON text).
- `lib/analysis-service.ts` — logic shared with the REST routes, returning typed outcomes; REST maps them to the unchanged HTTP contract, MCP maps errors to `isError: true` tool results.
- `/mcp` has its own rate limit: 120 req/min per IP (`mcpRateLimiter`), so MCP and REST budgets don't affect each other.
- `DELETE` is exported from the route file; stateless serving answers `GET`/`DELETE` with 405.
- 2025-era responses are a single-event SSE stream; 2026-07-28 responses are plain JSON unless a mid-call notification is emitted.
- Not needed in practice: CORS changes (the global `cors()` already allows any origin and reflects requested headers; MCP hosts call server-side) and `"types": ["node"]` (TS 7 + `next build` pass as is).

Verified with real clients in `test/mcp.test.ts`: v2 client on the 2026-07-28 protocol, v2 client in legacy mode, and the v1 SDK client. Also smoke-tested `next start` + curl against the real npm registry.

## 4. ChatGPT and Codex

- **ChatGPT (apps/plugins):** same remote MCP server over HTTPS. Auth: OpenAI recommends OAuth with Client ID Metadata Documents (CIMD) or dynamic client registration. Data is public, so start without auth + rate limiting. Test via Developer Mode. Optional later: UI widget (outdated-packages table) rendered in chat.
- **Claude Code:** `claude mcp add --transport http depman https://api.depman.cloud/api/mcp`.
- **Codex:** usable immediately with `codex mcp add depman --url https://api.depman.cloud/api/mcp` (bearer token via env var or OAuth supported). Plugins bundle MCP servers + skills and share a directory with ChatGPT. Reported layout (third-party sources, verify against official docs): `.codex-plugin/plugin.json` + `.mcp.json` + `skills/`. A skill such as "audit this repo's dependencies" would read local manifests and call `analyze_dependencies`.

## 5. Backward-compatibility constraints (production clients)

The refactor (extract service + Zod + tests) must **not change** the REST contract used by the extensions. Risks identified:

1. **`Content-Type`** — today `c.req.json()` parses the body regardless of header. Hono's `zValidator("json")` (verified in `hono@4.13.7` source) skips parsing when `Content-Type` is not `application/json`, validates `{}`, and returns 400. **Highest risk.**
2. **Malformed JSON** — today: 500 `{"error":"Internal server error"}`. With the validator: 400 with plain-text `Malformed JSON in request body` (not JSON).
3. **Error shape** — Zod's default error body differs from today's `{ "error": "<message>" }`.
4. **`fileName: null` / `""`** — today ignored (falsy). `z.string().optional()` rejects `null`; would need `.nullish()`.
5. **Extra body fields** — today ignored; `.strict()` would reject them.
6. **Response bodies** — `null` vs `undefined` changes serialized JSON (new `"field": null` keys). Never parse/transform responses with Zod.

Safe parts: extracting the service is a pure move if outputs stay identical; Vitest is dev-only (but test files must not break `next build` type-checking).

### Agreed approach (done)

The REST contract is pinned by `test/rest-contract.test.ts` (snapshots of status, body and headers, including Content-Type tolerance, falsy `fileName`, malformed JSON → 500, rate limiting and CORS). The refactor and the MCP endpoint left every snapshot unchanged. Zod is used only for MCP tool schemas; REST validation is untouched.

1. **Characterization tests first** — before refactoring, capture current HTTP behavior (status, body, headers) with `app.request()` and mocked registry `fetch`, including all edge cases above. Requires moving the Hono app from `route.ts` to its own module (e.g. `lib/app.ts`), since Next.js route files may only export HTTP method handlers.
2. **Extract the service** (`analyzeManifest`, `lookupPackage`) — tests must stay green.
3. **Zod only where safe** — for existing REST routes, either `safeParse` the body read exactly as today (no `zValidator`) and return the same error messages, or keep manual REST validation and use Zod only for MCP tools.
4. Any intentional behavior change (e.g. 400 instead of 500 for malformed JSON) goes in a separate, explicit change.

## 6. Open questions

To confirm with the Chrome / VS Code extension code:

- Which `Content-Type` do they send on `POST /api/analyze-packages`?
- Do they read `error` as a string or depend on specific messages?
- Do they handle 400 / 413 / 429 / 502 differently?

## 7. Hosting and Cloudflare

Decision: keep the VPS (no per-request subrequest or CPU limits, in-memory cache and rate limiter work as designed) and put Cloudflare's free plan in front of it.

- Free alternatives were rejected: Cloudflare Workers Free caps subrequests at 50 per request (an analysis can make up to 500 registry calls); Vercel Hobby is reported as non-commercial only; free tiers that sleep add cold starts.
- Cloudflare benefits: hides the VPS IP, always-on DDoS protection, edge caching for `GET /api/package/*` (already sends `s-maxage=300`; needs a Cache Rule for JSON), one free edge rate-limiting rule, managed TLS.
- Required when enabling the proxy:
  1. `getClientKey` (`lib/rate-limiter.ts`) must use `CF-Connecting-IP`. Today the first `X-Forwarded-For` entry is trusted, which a client may spoof depending on the reverse proxy.
  2. Block direct access to the origin: Cloudflare Tunnel (preferred, no open ports) or a firewall allowing only Cloudflare IP ranges.
  3. Do not enable Bot Fight Mode or challenges on `/api/*` — the extensions, ChatGPT and Codex cannot solve them.
  4. SSL mode "Full (strict)". Proxied requests time out at 100 s (524).

## 8. Next steps

1. [ ] Answer the open questions above (or give access to the extension repos).
2. [x] Move the Hono app out of `route.ts`; add Vitest + characterization tests (no production behavior change).
3. [x] Extract the analysis/lookup service; Zod only for MCP (REST contract unchanged).
4. [x] Add stateless `/api/mcp` with `get_package_info` and `analyze_dependencies` and a dedicated rate limit; tested with v1 and v2 MCP clients.
5. [ ] Deploy and verify in production with `codex mcp add` / `claude mcp add` and MCP Inspector.
6. [ ] Cloudflare in front of the VPS (section 7), including the `CF-Connecting-IP` change.
7. [ ] Add `search` / `fetch` tools; test in ChatGPT Developer Mode.
8. [ ] Auth: API keys first, OAuth (CIMD/DCR) if publishing requires it.
9. [ ] Package as a ChatGPT/Codex plugin (MCP + skill); optional UI widget.

Independent (from `TODO.md`): migrating from Next.js to plain Hono (`@hono/node-server`) remains worthwhile but does not block any of the above.

## References

- `@hono/mcp`: https://jsr.io/@hono/mcp/doc/~/StreamableHTTPTransport, https://github.com/honojs/middleware/tree/main/packages/mcp
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools
- OpenAI — Building MCP servers for ChatGPT Apps and API: https://developers.openai.com/api/docs/mcp
- OpenAI Codex — MCP: https://developers.openai.com/codex/mcp
- ChatGPT / Codex plugins: https://learn.chatgpt.com/docs/plugins
- Third-party (plugin manifest details, unverified): https://codex.danielvaughan.com/2026/04/01/codex-plugins-skills-mcp-authoring
