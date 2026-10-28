// MCP server exposing the Dep-Man analysis as tools.
//
// Served statelessly by createMcpHandler (lib/app.ts): a fresh McpServer is
// built per HTTP request, so nothing here may hold per-client state. Tools
// call the same analysis service as the REST routes.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
	analyzeManifest,
	hasValidExtension,
	lookupPackage,
	sanitizeFileName,
} from "@/lib/analysis-service";
import {
	MAX_CONTENT_SIZE,
	MAX_FILENAME_LENGTH,
	VALID_REGISTRIES,
} from "@/lib/constants";
import packageJson from "@/package.json";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const packageManagerSchema = z.enum(["npm", "pip", "pub"]);
const statusSchema = z.enum(["up-to-date", "outdated", "error"]);

const versionDiffSchema = z.object({
	majorsBehind: z.number(),
	minorsBehind: z.number(),
	patchesBehind: z.number(),
	hasBreakingChanges: z.boolean(),
	urgency: z.enum(["none", "low", "medium", "high", "critical"]),
});

const metadataSchema = z.object({
	license: z.string().optional(),
	repository: z.string().optional(),
	deprecated: z.union([z.string(), z.boolean()]).optional(),
	lastPublished: z.string().optional(),
	keywords: z.array(z.string()).optional(),
});

const analyzedPackageSchema = z.object({
	name: z.string(),
	currentVersion: z.string(),
	latestVersion: z.string(),
	status: statusSchema,
	packageManager: packageManagerSchema,
	description: z.string().optional(),
	homepage: z.string().optional(),
	error: z.string().optional(),
	versionDiff: versionDiffSchema.optional(),
	metadata: metadataSchema.optional(),
});

const analysisOutputSchema = z.object({
	packages: z.array(analyzedPackageSchema),
	summary: z.object({
		total: z.number(),
		upToDate: z.number(),
		outdated: z.number(),
		errors: z.number(),
	}),
});

const packageInfoOutputSchema = z.object({
	name: z.string(),
	registry: packageManagerSchema,
	latestVersion: z.string(),
	description: z.string().optional(),
	homepage: z.string().optional(),
	registryUrl: z.string(),
	checkedAt: z.string(),
	metadata: metadataSchema.optional(),
	currentVersion: z.string().optional(),
	status: statusSchema.optional(),
	versionDiff: versionDiffSchema.optional(),
});

const registryAliases = Object.keys(VALID_REGISTRIES) as [string, ...string[]];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolResult<T extends Record<string, unknown>>(data: T) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data) }],
		structuredContent: data,
	};
}

function toolError(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}

const READ_ONLY_REGISTRY_TOOL = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	// Tools call the public npm, PyPI and pub.dev registries.
	openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createDepmanMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "depman", title: "Dep-Man", version: packageJson.version },
		{
			instructions:
				"Dep-Man checks dependencies against the npm, PyPI and pub.dev registries. " +
				"Use analyze_dependencies with the raw content of a package.json, " +
				"requirements.txt or pubspec.yaml to find outdated packages, and " +
				"get_package_info to look up a single package.",
		},
	);

	server.registerTool(
		"analyze_dependencies",
		{
			title: "Analyze dependency file",
			description:
				"Check every dependency in a package.json (npm/yarn/pnpm), requirements.txt (pip) " +
				"or pubspec.yaml (Dart/Flutter) against its registry. Returns, per package, the " +
				"latest version, whether it is up to date or outdated, how far behind it is " +
				"(majors/minors/patches, breaking changes, urgency) and metadata such as " +
				"license and deprecation, plus a summary.",
			inputSchema: z.object({
				content: z
					.string()
					.min(1)
					.max(MAX_CONTENT_SIZE)
					.describe("Raw text content of the dependency file."),
				fileName: z
					.string()
					.max(MAX_FILENAME_LENGTH)
					.optional()
					.describe(
						"Original file name (e.g. package.json). Optional; helps detect the format.",
					),
			}),
			outputSchema: analysisOutputSchema,
			annotations: READ_ONLY_REGISTRY_TOOL,
		},
		async ({ content, fileName }) => {
			let sanitizedFileName: string | undefined;
			if (fileName) {
				sanitizedFileName = sanitizeFileName(fileName);
				if (sanitizedFileName && !hasValidExtension(sanitizedFileName)) {
					return toolError(
						"Invalid file type. Allowed: .json, .txt, .yaml, .yml",
					);
				}
			}

			const outcome = await analyzeManifest(content, sanitizedFileName);
			switch (outcome.kind) {
				case "parse-error":
					return toolError(`Failed to parse file content: ${outcome.message}`);
				case "too-many-packages":
					return toolError(
						`Too many packages: ${outcome.count} (max ${outcome.max} per analysis)`,
					);
				case "ok":
					return toolResult({ ...outcome.result });
			}
		},
	);

	server.registerTool(
		"get_package_info",
		{
			title: "Get package info",
			description:
				"Look up a single package on npm, PyPI or pub.dev: latest version, description, " +
				"homepage, license, repository and deprecation. When currentVersion is given, " +
				"also reports whether it is outdated and by how much.",
			inputSchema: z.object({
				registry: z
					.enum(registryAliases)
					.describe(
						"Registry: npm, pip (or pypi) for Python, pub (or dart/flutter) for Dart.",
					),
				name: z
					.string()
					.min(1)
					.describe(
						"Package name, e.g. hono, @types/node, requests, provider.",
					),
				currentVersion: z
					.string()
					.optional()
					.describe(
						"Version or range currently in use (e.g. ^4.0.0) to compare with the latest.",
					),
			}),
			outputSchema: packageInfoOutputSchema,
			annotations: READ_ONLY_REGISTRY_TOOL,
		},
		async ({ registry, name, currentVersion }) => {
			const outcome = await lookupPackage(registry, name, currentVersion);
			switch (outcome.kind) {
				case "invalid-registry":
					return toolError(
						`Invalid registry. Valid registries: ${outcome.validRegistries.join(", ")}`,
					);
				case "invalid-name":
					return toolError(outcome.message);
				case "not-found":
					return toolError(
						`Package not found: ${outcome.name} on ${outcome.registry}`,
					);
				case "upstream-error":
					return toolError(
						`Registry error for ${outcome.name} on ${outcome.registry}: ${outcome.error}`,
					);
				case "ok":
					return toolResult({ ...outcome.result });
			}
		},
	);

	return server;
}
