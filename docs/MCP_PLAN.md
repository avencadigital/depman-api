# MCP integration plan

Status: **planning** — nothing implemented yet. Discussion date: 2026-10-16.

Goal: expose the Dep-Man API as an MCP server, and later package it as a ChatGPT / Codex plugin, **without breaking the existing REST API**, which is in production and consumed by the Chrome extension and the VS Code extension.

---

## 1. Current state (relevant findings)

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

**Decision (proposed):** use the official `@modelcontextprotocol/server` v2 (+ optionally `@modelcontextprotocol/hono`) in **stateless mode** (new `McpServer` + `WebStandardStreamableHTTPServerTransport` per request, `sessionIdGenerator: undefined`). Only reconsider `@hono/mcp` if its OAuth helpers are needed before it supports SDK v2.

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

### Sketch

```ts
app.all("/mcp", async (c) => {
  const server = createDepmanMcpServer(); // registers tools, calls shared services
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true, // verify this option exists in v2
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
```

### Required adjustments for MCP

- Separate rate limit for `/mcp` (one tool call = several JSON-RPC requests; ChatGPT traffic comes from shared OpenAI egress IPs). Prefer per-token limits once auth exists.
- Export `DELETE` from the route file (stateless mode answers 405, but Hono should handle it).
- CORS for `/mcp`: allow/expose `Mcp-Session-Id` and `Mcp-Protocol-Version`.
- Add `"types": ["node"]` to `tsconfig.json` (SDK v2 requirement); validate SDK v2 with TS 7 + `next build`.

## 4. ChatGPT and Codex

- **ChatGPT (apps/plugins):** same remote MCP server over HTTPS. Auth: OpenAI recommends OAuth with Client ID Metadata Documents (CIMD) or dynamic client registration. Data is public, so start without auth + rate limiting. Test via Developer Mode. Optional later: UI widget (outdated-packages table) rendered in chat.
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

### Agreed approach

1. **Characterization tests first** — before refactoring, capture current HTTP behavior (status, body, headers) with `app.request()` and mocked registry `fetch`, including all edge cases above. Requires moving the Hono app from `route.ts` to its own module (e.g. `lib/app.ts`), since Next.js route files may only export HTTP method handlers.
2. **Extract the service** (`analyzeManifest`, `lookupPackage`) — tests must stay green.
3. **Zod only where safe** — for existing REST routes, either `safeParse` the body read exactly as today (no `zValidator`) and return the same error messages, or keep manual REST validation and use Zod only for MCP tools.
4. Any intentional behavior change (e.g. 400 instead of 500 for malformed JSON) goes in a separate, explicit change.

## 6. Open questions

To confirm with the Chrome / VS Code extension code:

- Which `Content-Type` do they send on `POST /api/analyze-packages`?
- Do they read `error` as a string or depend on specific messages?
- Do they handle 400 / 413 / 429 / 502 differently?

## 7. Next steps

1. [ ] Answer the open questions above (or give access to the extension repos).
2. [ ] Move the Hono app out of `route.ts`; add Vitest + characterization tests (no production behavior change).
3. [ ] Extract the analysis/lookup service; introduce Zod without changing the REST contract.
4. [ ] Add stateless `/api/mcp` with `get_package_info` and `analyze_dependencies`, dedicated rate limit and CORS; test with MCP Inspector and `codex mcp add`.
5. [ ] Add `search` / `fetch` tools; test in ChatGPT Developer Mode.
6. [ ] Auth: API keys first, OAuth (CIMD/DCR) if publishing requires it.
7. [ ] Package as a ChatGPT/Codex plugin (MCP + skill); optional UI widget.

Independent (from `TODO.md`): migrating from Next.js to plain Hono (`@hono/node-server`) remains worthwhile but does not block any of the above.

## References

- `@hono/mcp`: https://jsr.io/@hono/mcp/doc/~/StreamableHTTPTransport, https://github.com/honojs/middleware/tree/main/packages/mcp
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools
- OpenAI — Building MCP servers for ChatGPT Apps and API: https://developers.openai.com/api/docs/mcp
- OpenAI Codex — MCP: https://developers.openai.com/codex/mcp
- ChatGPT / Codex plugins: https://learn.chatgpt.com/docs/plugins
- Third-party (plugin manifest details, unverified): https://codex.danielvaughan.com/2026/04/01/codex-plugins-skills-mcp-authoring
