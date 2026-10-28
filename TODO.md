# depman-api — TODO

Pendências abertas (revisado em 2026-10-28). Itens concluídos ficam no histórico do git; o plano do MCP está em [`docs/MCP_PLAN.md`](docs/MCP_PLAN.md).

> O contrato REST é usado em produção pelas extensões do Chrome e do VS Code e está fixado em `test/rest-contract.test.ts`. Itens marcados com **(muda contrato)** alteram respostas da API e precisam ser validados com as extensões antes.

## Antes / junto do deploy

- [ ] **Deploy na VPS com Node 24** — confirmar a versão do Node no ambiente (`.node-version` pede 24; os testes locais rodaram em Node 22).
- [ ] **Cloudflare na frente da VPS** — proxy ativo, SSL "Full (strict)", Cache Rule para `GET /api/package/*`, `CLIENT_IP_HEADER=cf-connecting-ip`, origem acessível só via Cloudflare (Tunnel ou firewall) e sem Bot Fight Mode/challenges em `/api/*`. Detalhes na seção 7 do `docs/MCP_PLAN.md`.

## Decisões pendentes

- [ ] **Timeout total da análise** — `POST /api/analyze-packages` não tem limite global. Com 500 pacotes, o pior caso (fila de 10 em 10, timeout de 5 s e 1 retry) passa de vários minutos, acima dos 100 s do proxy do Cloudflare (erro 524). Opções: `hono/timeout` respondendo 504 controlado, ou um prazo por análise que marque os pacotes restantes como `error: "Request timeout"` e devolva o resto. **(muda contrato** só nesse caso extremo**)**
- [ ] **CORS restrito** — `cors()` aceita qualquer origem. Se a API for pública por design, só documentar; senão restringir aos IDs das extensões (`chrome-extension://<id>`, `vscode-webview://...`) e ao site. Precisa dos IDs das extensões. **(muda contrato)**
- [ ] **Ranges do pip** — o parser do `requirements.txt` descarta os operadores (`flask>=3.0` vira `3.0` exato), então um range que já aceita a última versão aparece como `outdated`. Corrigir com a semântica da PEP 440 (`>=`, `~=`, `!=`, múltiplas cláusulas). **(muda contrato)**

## Melhorias

- [ ] **Abandonar o wrapper Next.js (migrar para Hono puro)** — a API só usa o catch-all `app/api/[...route]/route.ts`, que apenas delega para `lib/app.ts`. O Hono roda direto no Node com o adaptador oficial `@hono/node-server`.
  - **Por quê:** a maior parte das vulnerabilidades encontradas era do Next (a atualização 16.3 → 16.4 corrigiu RCEs críticas); sem ele somem essa superfície, os conflitos recorrentes de deploy (Next × TypeScript, Nixpacks/corepack), centenas de MB de `node_modules` e o build lento.
  - **Passos:**
    1. Criar `server.ts` com `serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) })` (`@hono/node-server`).
    2. Mover os headers de segurança do `next.config.ts` (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`) para o middleware `hono/secure-headers` (o `X-Powered-By` deixa de existir: o Hono não envia esse header).
    3. Substituir `app/page.tsx` por uma rota `GET /` no Hono (texto simples) e decidir o que fazer com `/_next/*` (passa a ser 404).
    4. O app usa `basePath("/api")`: criar um app raiz que monte `/` e o app da API, ou remover o `basePath` e montar com `app.route("/api", api)`.
    5. Build com `tsc` (ou `esbuild`/`tsup`) para `dist/`; scripts `build` e `start` (`node dist/server.js`). Atenção ao alias `@/` (usado nos imports) e ao `import packageJson from "@/package.json"`: trocar por caminhos relativos ou resolver no bundler.
    6. Remover `next`, `react`, `react-dom`, `@types/react*`, a pasta `app/`, `next.config.ts`, `next-env.d.ts` e o plugin `next` do `tsconfig.json`.
    7. Ajustar o deploy na EasyPanel (comandos de build/start e porta) e validar com `pnpm test` (os testes chamam o app Hono direto, então cobrem a migração) e um smoke test com `curl` (health, analyze, package, mcp e headers de segurança).
- [ ] **Próximas fases do MCP** — tools `search`/`fetch` para o ChatGPT, autenticação (API key, depois OAuth) e empacotamento como plugin. Ver `docs/MCP_PLAN.md`, seção 8.

## Limitações conhecidas

- **Estado em memória por instância** — o cache (`lib/cache-service.ts`) e os rate limiters (`lib/rate-limiter.ts`) vivem no processo: são zerados em cada restart e não são compartilhados entre instâncias. Com um único container na VPS o impacto é só no restart; se escalar horizontalmente, mover para Redis/Valkey.
- **Limite de concorrência global** — o `p-limit` de 10 chamadas aos registries é compartilhado entre todas as análises simultâneas (intencional, ver comentário em `lib/package-services.ts`); uma análise grande pode atrasar uma pequena.
