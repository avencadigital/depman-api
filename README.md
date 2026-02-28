# Dep-Man API

REST API for analyzing package dependencies and checking for outdated packages across multiple ecosystems.

Built with [Next.js 16](https://nextjs.org/) and [Hono](https://hono.dev/), deployed as serverless functions.

## Supported Ecosystems

| Ecosystem | File | Registry |
|-----------|------|----------|
| npm / yarn / pnpm | `package.json` | [npmjs.com](https://www.npmjs.com/) |
| pip | `requirements.txt` | [pypi.org](https://pypi.org/) |
| Dart / Flutter | `pubspec.yaml` | [pub.dev](https://pub.dev/) |

## API Endpoints

### `GET /api/health`

Health check.

### `GET /api/analyze-packages`

Returns API documentation and available endpoints.

### `POST /api/analyze-packages`

Analyze a dependency file for outdated packages.

**Request body:**

```json
{
  "content": "<file content as string>",
  "fileName": "package.json"
}
```

- `content` (required) — raw content of the dependency file.
- `fileName` (optional) — helps detect the package manager. If omitted, the API auto-detects the format.

**Response:**

```json
{
  "packages": [
    {
      "name": "hono",
      "currentVersion": "^4.12.3",
      "latestVersion": "4.7.13",
      "status": "outdated",
      "packageManager": "npm",
      "description": "...",
      "homepage": "...",
      "versionDiff": {
        "majorsBehind": 0,
        "minorsBehind": 7,
        "patchesBehind": 0,
        "hasBreakingChanges": false,
        "urgency": "medium"
      },
      "metadata": {
        "license": "MIT",
        "repository": "https://github.com/honojs/hono",
        "lastPublished": "2025-02-20T..."
      }
    }
  ],
  "summary": {
    "total": 12,
    "upToDate": 8,
    "outdated": 3,
    "errors": 1
  }
}
```

### `GET /api/package/:registry/:name`

Look up a single package.

**Path parameters:**

- `registry` — one of `npm`, `pip`, `pypi`, `pub`, `dart`, `flutter`
- `name` — package name

**Query parameters:**

- `current` (optional) — current version to compare against latest

**Examples:**

```
GET /api/package/npm/hono
GET /api/package/pip/requests?current=2.28.0
GET /api/package/pub/provider?current=6.0.0
```

## Getting Started

**Prerequisites:** Node.js 24+, pnpm

```bash
pnpm install
pnpm dev
```

The API runs at `http://localhost:3000/api`.

## Project Structure

```
app/
  api/[...route]/route.ts   # Hono router (all API endpoints)
  page.tsx                   # Minimal landing page
lib/
  cache-service.ts           # In-memory cache with TTL and size limits
  constants.ts               # Registry URLs, validation rules, limits
  package-services.ts        # Registry fetchers (npm, PyPI, pub.dev)
  parsers.ts                 # File format detection and parsing
  retry-util.ts              # Retry with exponential backoff and jitter
  types.ts                   # Shared TypeScript interfaces
  version-utils.ts           # Semver comparison and diff calculation
```

## Key Details

- Auto-detects file format from content when `fileName` is not provided.
- Concurrent registry lookups with configurable concurrency limit (default: 10).
- Retry with exponential backoff for transient failures (timeouts, 429s, 5xx).
- In-memory cache: 5 min TTL for successful lookups, 30s for errors, max 500 entries.
- Version diff includes urgency classification: `none`, `low`, `medium`, `high`, `critical`.
- Input validation: file size (5 MB), filename sanitization, per-registry name patterns and length limits.

## Tech Stack

- **Runtime:** Next.js 16 (App Router)
- **Routing:** Hono
- **Language:** TypeScript 5.9
- **Package Manager:** pnpm
- **Parsing:** semver, js-yaml

## Contributing

Contributions are welcome. To get started:

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes and commit: `git commit -m "feat: add my feature"`
4. Push to your fork: `git push origin feat/my-feature`
5. Open a Pull Request.

Please keep PRs focused on a single change. If you find a bug, feel free to open an issue first to discuss it.

## License

MIT — [Avenca Digital](https://github.com/avencadigital)
