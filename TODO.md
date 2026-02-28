# depman-api — TODO

## Crítico

- [x] **Index mismatch no mapeamento de pacotes** — `route.ts:160-194`. `getMultiplePackagesInfo` retorna via `p-limit` assíncrono, mas o resultado é mapeado por índice assumindo a mesma ordem. Corrigir usando `Map` por nome: `const infoByName = new Map(packageInfos.map(i => [i.name, i]))`.

- [ ] **CORS sem restrição de origem** — `route.ts:27`. `cors()` sem configuração permite requisições de qualquer origem. Configurar origens específicas: `cors({ origin: ["https://depman.cloud"] })`.

## Alto

- [ ] **tsconfig: `moduleResolution`** — Atualmente `"node"`, deveria ser `"bundler"` para Next.js 16 com `"type": "module"`. Permite resolução correta de `exports` em packages modernos.

- [ ] **tsconfig: `jsx`** — Atualmente `"react-jsx"`, deveria ser `"preserve"`. O Next.js/Turbopack cuida da transformação JSX; usar `react-jsx` pode causar conflitos.

- [x] **Type assertions sem validação no NPM service** — `package-services.ts:109-140`. `data["dist-tags"]`, `data.versions` e `data.time` são acessados com `as` sem verificar a estrutura real. Respostas malformadas do registry causam falhas silenciosas. Considerar validação com Zod.

- [ ] **Cache in-memory em serverless** — `CacheService` usa Singleton com `setInterval` para cleanup. Em serverless (Vercel Functions), o cache não persiste entre cold starts e o timer pode manter a function viva. Considerar Vercel KV ou Edge Config para cache distribuído.

## Médio

- [x] **`AbortError` (timeout) não é retentado** — `retry-util.ts:41`. `isRetryableError` retorna `false` para `AbortError`, mas timeouts deveriam ser retentados com backoff. Alterar para `return true` nesse caso.

- [x] **Padrão de erro duplicado** — `route.ts:206` e `route.ts:309`. O mesmo bloco `catch` com lógica de `NODE_ENV` está repetido. Extrair para helper ou middleware Hono.

- [x] **PyPI sem validação de `releases`** — `package-services.ts:148-169`. `releases[version]?.[0]` pode ser `undefined` sem aviso; o campo `lastPublished` fica silenciosamente ausente.

- [x] **Validação de tamanho de nome de pacote genérica** — `route.ts:247`. Limite de 214 chars é específico do NPM, mas aplicado a todos os registries. PyPI aceita máximo 128. Usar limites por registry em `constants.ts`.

- [x] **Cleanup de cache O(n) a cada 60s** — `cache-service.ts:93`. Full scan do Map a cada intervalo. Considerar cleanup lazy (na leitura) ou bucket por timestamp.

## Info / Nice to have

- [x] **URLs de registry hardcoded em múltiplos lugares** — `getRegistryUrl()` em `route.ts:219` e endpoints em `package-services.ts`. Centralizar todas as URLs de registry em `constants.ts`.

- [x] **`sanitizeFileName` incompleto** — `route.ts:77`. Remove `/` e `\` mas não null bytes (`\0`) nem outros caracteres de controle.

- [ ] **Cobertura de testes zero** — Funções críticas como `version-utils.ts`, `parsers.ts` e `cache-service.ts` sem testes unitários.

- [ ] **`next.config.ts` vazio** — Considerar adicionar security headers (CSP, HSTS) via `headers()` e `serverExternalPackages` se necessário.
