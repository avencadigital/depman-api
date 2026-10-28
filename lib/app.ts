import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import {
	analyzeManifest,
	hasValidExtension,
	lookupPackage,
	sanitizeFileName,
} from "@/lib/analysis-service";
import { CacheService } from "@/lib/cache-service";
import { MAX_CONTENT_SIZE, MAX_FILENAME_LENGTH } from "@/lib/constants";
import { createDepmanMcpServer } from "@/lib/mcp/server";
import { getClientKey, mcpRateLimiter, rateLimiter } from "@/lib/rate-limiter";
import packageJson from "@/package.json";

export const app = new Hono().basePath("/api");

const MCP_PATH = "/api/mcp";

// CORS middleware
app.use("*", cors());

// Rate limiting middleware (per client IP; /mcp has its own budget)
app.use("*", async (c, next) => {
	const key = getClientKey(c.req.raw.headers);
	const limiter = c.req.path === MCP_PATH ? mcpRateLimiter : rateLimiter;
	const { allowed, retryAfterSeconds } = limiter.check(key);
	if (!allowed) {
		c.header("Retry-After", String(retryAfterSeconds));
		return c.json({ error: "Too many requests, please try again later" }, 429);
	}
	return next();
});

// --- Health ---
const cache = CacheService.getInstance();
app.get("/health", (c) =>
	c.json({
		message: "Good!",
		status: "ok",
		version: packageJson.version,
		uptime: process.uptime(),
		cache: cache.getStats(),
	}),
);

// --- API Info (GET /api/analyze-packages) ---
app.get("/analyze-packages", (c) => {
	return c.json({
		name: "Dep-Man — Dependency Manager API",
		version: packageJson.version,
		status: "operational",
		description:
			"Analyze package dependencies and check for outdated packages across multiple package managers.",
		documentation: "https://docs.depman.cloud/",
		endpoints: {
			"POST /api/analyze-packages": {
				description: "Analyze package file content for outdated dependencies",
				contentType: "application/json",
				body: {
					content: "string (required) - Package file content",
					fileName:
						"string (optional) - Original filename to help detect package manager",
				},
				supportedFormats: [
					"package.json (npm/yarn/pnpm)",
					"requirements.txt (pip)",
					"pubspec.yaml (Dart/Flutter)",
				],
			},
			"GET /api/package/:registry/:name": {
				description: "Get information for a single package",
				parameters: {
					registry: "npm | pip | pypi | pub | dart | flutter",
					name: "Package name",
				},
				queryParams: {
					current: "string (optional) - Current version to compare",
				},
			},
			"POST /api/mcp": {
				description:
					"Model Context Protocol server (Streamable HTTP) for AI agents",
				tools: ["analyze_dependencies", "get_package_info"],
			},
		},
		links: {
			api: "https://api.depman.cloud",
			website: "https://depman.cloud",
			github: "https://github.com/avencadigital/pack-man",
		},
	});
});

// --- Errors ---

// Unexpected errors (including a body that is not valid JSON) become a
// generic 500; the message is only exposed in development.
app.onError((error, c) => {
	if (error instanceof HTTPException) return error.getResponse();
	if (process.env.NODE_ENV === "development")
		console.error(`Error in ${c.req.method} ${c.req.path}:`, error);
	const message =
		process.env.NODE_ENV === "development"
			? error.message
			: "Internal server error";
	return c.json({ error: message }, 500);
});

// --- Analyze Packages (POST) ---

// Enforces the size limit while streaming, so a chunked body without a
// Content-Length header can't make the server buffer an unbounded payload.
const analyzeBodyLimit = bodyLimit({
	maxSize: MAX_CONTENT_SIZE,
	onError: (c) => c.json({ error: "Payload too large (max 5MB)" }, 413),
});

app.post("/analyze-packages", analyzeBodyLimit, async (c) => {
	// Parsed regardless of Content-Type: production clients rely on it.
	const body = await c.req.json();
	const { content, fileName } = body;

	if (!content || typeof content !== "string") {
		return c.json({ error: "Valid content is required" }, 400);
	}
	if (content.length > MAX_CONTENT_SIZE) {
		return c.json({ error: "Content too large (max 5MB)" }, 413);
	}

	let sanitizedFileName: string | undefined;
	if (fileName) {
		if (typeof fileName !== "string" || fileName.length > MAX_FILENAME_LENGTH) {
			return c.json({ error: "Invalid filename" }, 400);
		}
		sanitizedFileName = sanitizeFileName(fileName);
		if (sanitizedFileName && !hasValidExtension(sanitizedFileName)) {
			return c.json(
				{ error: "Invalid file type. Allowed: .json, .txt, .yaml, .yml" },
				400,
			);
		}
	}

	const outcome = await analyzeManifest(content, sanitizedFileName);

	switch (outcome.kind) {
		case "parse-error": {
			const detail =
				process.env.NODE_ENV === "development" ? `: ${outcome.message}` : "";
			return c.json({ error: `Failed to parse file content${detail}` }, 400);
		}
		case "too-many-packages":
			return c.json(
				{
					error: `Too many packages (max ${outcome.max} per analysis)`,
					count: outcome.count,
				},
				400,
			);
		case "ok":
			return c.json(outcome.result);
	}
});

// --- Single Package Lookup ---

app.get("/package/:registry/:name", async (c) => {
	// Hono already URL-decodes route params; decoding again here would corrupt
	// names containing a literal encoded "%" (e.g. "%2540" -> "@").
	const registry = c.req.param("registry");
	const name = c.req.param("name");
	const currentVersion = c.req.query("current");

	const outcome = await lookupPackage(registry, name, currentVersion);

	switch (outcome.kind) {
		case "invalid-registry":
			return c.json(
				{ error: "Invalid registry", validRegistries: outcome.validRegistries },
				400,
			);
		case "invalid-name":
			return c.json({ error: outcome.message }, 400);
		case "not-found":
			return c.json(
				{
					error: "Package not found",
					name: outcome.name,
					registry: outcome.registry,
				},
				404,
			);
		case "upstream-error":
			c.header("Cache-Control", "no-store");
			return c.json(
				{
					error: outcome.error,
					name: outcome.name,
					registry: outcome.registry,
				},
				502,
			);
		case "ok":
			c.header(
				"Cache-Control",
				"public, s-maxage=300, stale-while-revalidate=60",
			);
			return c.json(outcome.result);
	}
});

// --- MCP (Streamable HTTP, stateless) ---

// One McpServer per request, no sessions: works across restarts and
// multiple instances. Serves both the 2026-07-28 protocol and 2025-era
// clients (stateless fallback; GET/DELETE answer 405). The body limit leaves
// room for the JSON-RPC envelope around a MAX_CONTENT_SIZE manifest.
const mcpHandler = createMcpHandler(() => createDepmanMcpServer(), {
	maxRequestBodySize: MAX_CONTENT_SIZE + 1024 * 1024,
	onerror: (error) => {
		if (process.env.NODE_ENV === "development")
			console.error("MCP error:", error);
	},
});

app.all("/mcp", (c) => mcpHandler.fetch(c.req.raw));
