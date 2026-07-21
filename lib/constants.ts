import type { PackageManager } from "./types";

// ---------------------------------------------------------------------------
// API request limits
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT = 10_000;
export const MAX_CONCURRENT_REQUESTS = 10;
// Tighter timeout for the batch analysis flow (many packages, p-limit only
// caps concurrency): keeps a single slow/unresponsive registry from
// serializing a 10s-timeout x 3-attempt worst case across the whole queue.
export const BATCH_TIMEOUT = 5_000;

// ---------------------------------------------------------------------------
// Upload / input validation
// ---------------------------------------------------------------------------

export const MAX_CONTENT_SIZE = 5 * 1024 * 1024;
export const MAX_FILENAME_LENGTH = 255;
export const ALLOWED_EXTENSIONS = [".json", ".txt", ".yaml", ".yml"];
export const MAX_PACKAGES_PER_ANALYSIS = 500;

// ---------------------------------------------------------------------------
// Rate limiting (per-instance, in-memory — see lib/rate-limiter.ts)
// ---------------------------------------------------------------------------

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 30;
export const RATE_LIMIT_MAX_TRACKED_KEYS = 5000;

// ---------------------------------------------------------------------------
// Registry mappings
// ---------------------------------------------------------------------------

export const VALID_REGISTRIES: Record<string, PackageManager> = {
	npm: "npm",
	pip: "pip",
	pypi: "pip",
	pub: "pub",
	dart: "pub",
	flutter: "pub",
};

export const MAX_PACKAGE_NAME_LENGTH: Record<PackageManager, number> = {
	npm: 214,
	pip: 128,
	pub: 64,
};

export const PACKAGE_NAME_PATTERNS: Record<PackageManager, RegExp> = {
	npm: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i,
	pip: /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/,
	pub: /^[a-z][a-z0-9_]*$/,
};

// ---------------------------------------------------------------------------
// Registry URLs (single source of truth)
// ---------------------------------------------------------------------------

function encodeNpmName(name: string): string {
	// npm scoped packages (@scope/name) keep the "/" as a path separator;
	// only the segments themselves need encoding.
	return name.split("/").map(encodeURIComponent).join("/");
}

export const REGISTRY_API_URLS: Record<
	PackageManager,
	(name: string) => string
> = {
	npm: (name) => `https://registry.npmjs.org/${encodeNpmName(name)}`,
	pip: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
	pub: (name) => `https://pub.dev/api/packages/${encodeURIComponent(name)}`,
};

export const REGISTRY_WEB_URLS: Record<
	PackageManager,
	(name: string) => string
> = {
	npm: (name) => `https://www.npmjs.com/package/${name}`,
	pip: (name) => `https://pypi.org/project/${name}/`,
	pub: (name) => `https://pub.dev/packages/${name}`,
};
