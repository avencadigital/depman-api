# depman-api — TODO

- [ ] **tsconfig: `moduleResolution`** — Atualmente `"node"`, deveria ser `"bundler"` para Next.js 16 com `"type": "module"`. Permite resolução correta de `exports` em packages modernos.

- [ ] **tsconfig: `jsx`** — Atualmente `"react-jsx"`, deveria ser `"preserve"`. O Next.js/Turbopack cuida da transformação JSX; usar `react-jsx` pode causar conflitos.

- [ ] **Cache in-memory em serverless** — `CacheService` usa Singleton com `setInterval` para cleanup. Em serverless (Vercel Functions), o cache não persiste entre cold starts e o timer pode manter a function viva. Considerar Vercel KV ou Edge Config para cache distribuído.

- [ ] **CORS sem restrição de origem** — `cors()` em `route.ts:27` permite requisições de qualquer origem. Se a API não é 100% pública, configurar origens específicas (ex: `cors({ origin: ["https://depman.cloud"] })`).

## Info / Nice to have

- [ ] **`next.config.ts` vazio** — Considerar adicionar security headers (CSP, HSTS) via `headers()` e `serverExternalPackages` se necessário.