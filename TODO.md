# depman-api — TODO (análise 2026-07-20)

Análise profunda de `app/api/[...route]/route.ts` e `lib/*` (cache, retry, parsers, package-services, version-utils, constants, types) + configs.

## Crítico

- [x] **Nomes de pacotes não validados no fluxo POST /analyze-packages (injeção de path na URL do registry)** — Corrigido: `route.ts` agora filtra `packageNames` por `PACKAGE_NAME_PATTERNS`/`MAX_PACKAGE_NAME_LENGTH` antes do fetch (nomes inválidos viram `status: error, "Invalid package name"` sem sair para a rede), e `REGISTRY_API_URLS` em `constants.ts` aplica `encodeURIComponent` por segmento (preservando `/` de escopo npm).

- [x] **Sem limite de quantidade de dependências por análise (abuso/DoS + timeout)** — Corrigido: `MAX_PACKAGES_PER_ANALYSIS = 500` em `constants.ts`; acima disso o POST retorna 400 com a contagem recebida.

- [x] **Retry de HTTP 5xx/429 é código morto** — Corrigido: nova `fetchAndValidate` em `package-services.ts` roda dentro do `retryWithBackoff`, lançando `HttpStatusError` (com `.status`) para qualquer resposta não-ok exceto 404, que agora é tratado (e cacheado) direto. `isRetryableError` finalmente é acionado para 408/429/5xx.

## Alto

- [x] **`peerDependencies` aceito no `canParse` mas ignorado no `parse`** — Corrigido: `PackageJsonParser.parse` agora funde `peerDependencies` e `optionalDependencies` no bucket `devDependencies` (que já é mesclado com `dependencies` em `getAllDependencies`), então um manifesto só com peer/optional deps deixa de retornar 0 pacotes silenciosamente.

- [ ] **[depois] CORS sem restrição de origem** — `route.ts:28`. `cors()` aberto. Se a API é pública por design, documentar; senão `cors({ origin: ["https://depman.cloud", "https://www.depman.cloud"] })`. (Pendente da rodada anterior.)

- [x] **TypeScript 7 e Next.js 16.3** — migrado para `typescript@7.0.2`; removido o `baseUrl`, que deixou de ser suportado. `tsc --noEmit` e o build de produção do Next passam com Node.js 26.4.0.

- [x] **`@types/js-yaml@4` com `js-yaml@5`** — Corrigido: removido `@types/js-yaml` do `package.json` (confirmado que `js-yaml@5.2.1` publica `types`/`exports` próprios no `dist/js-yaml.d.ts`, com um sistema de tags/schema diferente do que o `@types/js-yaml@4` descrevia). `pnpm install`, `tsc --noEmit` e `next build` seguem limpos.

- [x] **Sem rate limiting** — Corrigido (autenticação fica para depois, junto com CORS/TS6): novo `lib/rate-limiter.ts` (fixed-window in-memory por IP, 30 req/min, com eviction lazy de chaves expiradas) + middleware em `route.ts` retornando 429 com `Retry-After`. Mesma limitação de instância única que o `CacheService` já tem — documentado no arquivo.

## Médio

- [x] **Timeout acumulado pode passar de 30s por pacote** — Corrigido: novo preset `RetryPresets.batch` (2 tentativas, `initialDelay` 300ms, `maxDelay` 1s) e `BATCH_TIMEOUT = 5s` em `constants.ts`, usados só pelo fluxo `getMultiplePackagesInfo` (o GET single-package continua com o preset `standard`, mais generoso).

- [x] **404 não é cacheado** — Corrigido como parte do fix do retry: o branch de 404 em `fetchFromRegistry` agora chama `cache.set` antes de retornar.

- [x] **`decodeURIComponent` duplo no GET** — Corrigido: removida a decodificação extra em `route.ts` (Hono já decodifica `c.req.param()`).

- [x] **Erro upstream retorna 200** — Corrigido: `route.ts` agora responde 502 com `Cache-Control: no-store` quando `info.error` está presente (fora do caso 404, que continua 404); a lógica de status/versionDiff no corpo de sucesso ficou mais simples por não precisar mais considerar erro.

- [x] **`compareVersions` ignora ranges (falso "outdated")** — Corrigido: quando `current` contém operadores de range (`^`, `~`, `>=` etc.) e é um range válido (`semver.validRange`), a comparação agora usa `semver.satisfies(latest, range)`; só cai no `coerce` direto para versões exatas.

- [x] **PyPI `keywords` nunca preenchido** — Corrigido: nova `asKeywordList` em `package-services.ts` faz `split(",")` para strings (formato real do PyPI) e mantém suporte a array.

- [x] **Mensagem de erro enganosa para JSON válido sem dependências** — Corrigido: `detectFileType` em `parsers.ts` agora distingue JSON malformado ("Invalid JSON format...") de JSON válido sem os campos esperados ("Valid JSON but it doesn't look like a package.json...").

- [ ] **Cache in-memory não persiste entre instâncias/restarts** — `cache-service.ts`. Limitação conhecida (pendente da rodada anterior). Se a API ficar num único container no EasyPanel, o impacto é só em restart; se escalar horizontal, considerar Redis/Valkey no próprio EasyPanel.

## Baixo

- [x] **`JSON.parse` duplo no PackageJsonParser** — Corrigido: `PackageJsonParser` agora memoiza o último `JSON.parse` (por identidade de string) em `parseJson`, então `canParse`+`parse` — sempre chamados em sequência com o mesmo conteúdo em `detectFileType` — parseiam só uma vez.

- [x] **Lógica de homepage do npm duplica `extractRepoUrl`** — Corrigido: o fallback de homepage em `npmConfig.mapResponse` agora reusa `extractRepoUrl(data.repository)` em vez de reimplementar a limpeza de URL.

- [x] **`hosted` dependencies do pubspec descartadas** — Corrigido: `extractDeps` em `parsers.ts` agora reconhece objetos com chave `hosted` e extrai `value.version` quando presente (`{ hosted: ..., version: "^1.0.0" }`); git/path/sdk sem `version` continuam sendo ignorados.

- [x] **Prerelease invisível na comparação** — Corrigido: nova `coerceVersion` em `version-utils.ts` usa `semver.coerce(v, { includePrerelease: true })` em `compareVersions` e `calculateVersionDiff` (e `semver.satisfies(..., { includePrerelease: true })` no branch de range), então `1.0.0-beta` deixa de ser tratado como igual a `1.0.0`.

- [ ] **[depois] p-limit global compartilhado entre requests** — `package-services.ts:12`. Duas análises simultâneas dividem os mesmos 10 slots (head-of-line blocking). Aceitável como proteção global; documentar a intenção ou criar limiter por request com teto global.

- [ ] **[depois] Cobertura de testes zero** — pendente. Prioridade: `version-utils` (tabela de casos), `parsers` (fixtures reais), `retry-util` (fake timers). Sugestão: `vitest`.

- [x] **`next.config.ts` sem hardening** — Corrigido: `poweredByHeader: false`, `output: "standalone"`, e `headers()` com `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` e `Strict-Transport-Security` para todas as rotas.

- [x] **Health check sem informação útil** — Corrigido: `/health` agora retorna `version` (novo campo `version` em `package.json`, lido via import), `uptime` (`process.uptime()`) e `cache` (`CacheService.getStats()`), mantendo o campo `message` original por compatibilidade.

## Sugestões (métodos / packages / arquitetura)

1. **Validação de entrada com Zod + `@hono/zod-validator`** — substitui as checagens manuais de `content`/`fileName` no POST e dá 400 padronizado. Combina com **`@hono/zod-openapi`** para gerar OpenAPI/Swagger automaticamente (o endpoint GET `/analyze-packages` que hoje devolve docs em JSON manual passa a ser gerado).
2. **Middlewares nativos do Hono** — `hono/secure-headers` (substitui a pendência de security headers), `hono/logger` em dev, `hono/etag` para o GET de pacote, e `app.onError()` global no lugar do helper `handleServerError` repetido em cada rota.
3. **Migrar cache para `lru-cache`** — o `CacheService` singleton reimplementa TTL + eviction por tamanho que o `lru-cache` (v11) resolve com `max` + `ttl` por entrada, menos código e eviction O(1) real (hoje `enforceSizeLimit` ordena o Map inteiro, O(n log n)).
4. **`semver.satisfies`/`minVersion` em vez de só `coerce`** — trata ranges de forma correta (item do Médio) e permite um campo novo na resposta: `satisfiesLatest: boolean`, útil para o cliente distinguir "preciso mexer no manifest" de "só rodar install".
5. **Abandonar o wrapper Next.js** — a API não usa nada do Next além do catch-all route (as páginas `app/page.tsx` etc. são casca). Rodar Hono direto com `@hono/node-server` corta o build do Next, o risco recorrente de deploy (TS 6/7 × Next check, Nixpacks/corepack) e centenas de MB de `node_modules`. É a mudança com melhor retorno de manutenção — avaliar antes de investir nos itens de `next.config.ts`.
6. **Testes com `vitest` + fixtures reais** — gravar respostas reais dos 3 registries como JSON em `test/fixtures/` e testar os `mapResponse` contra elas; é onde regressões silenciosas (como o `keywords` do PyPI) aparecem.
7. **Timeout por request no Hono** — `hono/timeout` middleware no POST (ex.: 60s) para falhar com 504 controlado em vez de deixar a plataforma matar a conexão.
