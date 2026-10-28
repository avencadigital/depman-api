import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	analyzeManifest,
	hasValidExtension,
	lookupPackage,
	sanitizeFileName,
} from "@/lib/analysis-service";
import { CacheService } from "@/lib/cache-service";
import { MAX_CONTENT_SIZE, MAX_FILENAME_LENGTH } from "@/lib/constants";
import { getClientKey, rateLimiter } from "@/lib/rate-limiter";
import packageJson from "@/package.json";

export const app = new Hono().basePath("/api");

// CORS middleware
app.use("*", cors());

// Rate limiting middleware (per client IP)
app.use("*", async (c, next) => {
	const key = getClientKey(c.req.raw.headers);
	const { allowed, retryAfterSeconds } = rateLimiter.check(key);
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
		version: "0.2.0",
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
		},
		links: {
			api: "https://api.depman.cloud",
			website: "https://depman.cloud",
			github: "https://github.com/avencadigital/pack-man",
		},
	});
});

// --- Analyze Packages (POST) ---

function handleServerError(
	c: { json: (data: unknown, status: number) => Response },
	error: unknown,
	context: string,
) {
	if (process.env.NODE_ENV === "development")
		console.error(`${context}:`, error);
	const message =
		process.env.NODE_ENV === "development" && error instanceof Error
			? error.message
			: "Internal server error";
	return c.json({ error: message }, 500);
}

app.post("/analyze-packages", async (c) => {
	try {
		const contentLength = c.req.header("content-length");
		if (contentLength && parseInt(contentLength, 10) > MAX_CONTENT_SIZE) {
			return c.json({ error: "Payload too large (max 5MB)" }, 413);
		}

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
			if (
				typeof fileName !== "string" ||
				fileName.length > MAX_FILENAME_LENGTH
			) {
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
	} catch (error) {
		return handleServerError(c, error, "Error in analyze-packages API");
	}
});

// --- Single Package Lookup ---

app.get("/package/:registry/:name", async (c) => {
	// Hono already URL-decodes route params; decoding again here would corrupt
	// names containing a literal encoded "%" (e.g. "%2540" -> "@").
	const registry = c.req.param("registry");
	const name = c.req.param("name");
	const currentVersion = c.req.query("current");

	try {
		const outcome = await lookupPackage(registry, name, currentVersion);

		switch (outcome.kind) {
			case "invalid-registry":
				return c.json(
					{
						error: "Invalid registry",
						validRegistries: outcome.validRegistries,
					},
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
	} catch (error) {
		return handleServerError(c, error, "Error fetching package info");
	}
});
