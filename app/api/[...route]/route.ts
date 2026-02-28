import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/vercel";
import {
	ALLOWED_EXTENSIONS,
	MAX_CONTENT_SIZE,
	MAX_FILENAME_LENGTH,
	MAX_PACKAGE_NAME_LENGTH,
	PACKAGE_NAME_PATTERNS,
	REGISTRY_WEB_URLS,
	VALID_REGISTRIES,
} from "@/lib/constants";
import {
	getMultiplePackagesInfo,
	getPackageInfo,
} from "@/lib/package-services";
import { detectFileType, getAllDependencies } from "@/lib/parsers";
import {
	PACKAGE_STATUS,
	type PackageInfo,
	type PackageMetadata,
} from "@/lib/types";
import { calculateVersionDiff, compareVersions } from "@/lib/version-utils";

const app = new Hono().basePath("/api");

// CORS middleware
app.use("*", cors());

// --- Health ---
app.get("/health", (c) => c.json({ message: "Good!" }));

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
			website: "https://depman.cloud",
			github: "https://github.com/avencadigital/pack-man",
		},
	});
});

// --- Analyze Packages (POST) ---

function sanitizeFileName(fileName: string): string {
	return Array.from(fileName)
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			if (code <= 0x1f || code === 0x7f) return false;
			if (ch === "/" || ch === "\\") return false;
			return true;
		})
		.join("")
		.trim();
}
function buildPackageMetadata(info: {
	license?: string;
	repository?: string;
	deprecated?: string | boolean;
	lastPublished?: string;
	keywords?: string[];
}): PackageMetadata | undefined {
	const metadata: PackageMetadata = {};
	if (info.license) metadata.license = info.license;
	if (info.repository) metadata.repository = info.repository;
	if (info.deprecated) metadata.deprecated = info.deprecated;
	if (info.lastPublished) metadata.lastPublished = info.lastPublished;
	if (info.keywords?.length) metadata.keywords = info.keywords;
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function hasValidExtension(fileName: string): boolean {
	return ALLOWED_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));
}
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

		let packageData: ReturnType<typeof detectFileType>;
		try {
			packageData = detectFileType(content, sanitizedFileName);
		} catch (error) {
			const detail =
				process.env.NODE_ENV === "development" && error instanceof Error
					? `: ${error.message}`
					: "";
			return c.json({ error: `Failed to parse file content${detail}` }, 400);
		}

		const allDependencies = getAllDependencies(packageData);
		const packageNames = Object.keys(allDependencies);

		if (packageNames.length === 0) {
			return c.json({
				packages: [],
				summary: { total: 0, upToDate: 0, outdated: 0, errors: 0 },
			});
		}

		const packagesToCheck = packageNames.map((name) => ({
			name,
			manager: packageData.packageManager,
		}));
		const packageInfos = await getMultiplePackagesInfo(packagesToCheck);
		const infoByName = new Map(packageInfos.map((info) => [info.name, info]));

		const packages: PackageInfo[] = packageNames.map((packageName) => {
			const info = infoByName.get(packageName) ?? {
				name: packageName,
				latestVersion: "unknown",
				error: "No data returned",
			};
			const currentVersion = allDependencies[packageName];
			const metadata = buildPackageMetadata(info);

			if (info.error) {
				return {
					name: packageName,
					currentVersion,
					latestVersion: info.latestVersion,
					status: PACKAGE_STATUS.ERROR,
					packageManager: packageData.packageManager,
					error: info.error,
					metadata,
				};
			}

			const status = compareVersions(currentVersion, info.latestVersion);
			const versionDiff =
				status === PACKAGE_STATUS.OUTDATED
					? calculateVersionDiff(currentVersion, info.latestVersion)
					: undefined;

			return {
				name: packageName,
				currentVersion,
				latestVersion: info.latestVersion,
				status,
				packageManager: packageData.packageManager,
				description: info.description,
				homepage: info.homepage,
				versionDiff,
				metadata,
			};
		});

		const summary = {
			total: packages.length,
			upToDate: packages.filter((p) => p.status === PACKAGE_STATUS.UP_TO_DATE)
				.length,
			outdated: packages.filter((p) => p.status === PACKAGE_STATUS.OUTDATED)
				.length,
			errors: packages.filter((p) => p.status === PACKAGE_STATUS.ERROR).length,
		};

		return c.json({ packages, summary });
	} catch (error) {
		return handleServerError(c, error, "Error in analyze-packages API");
	}
});

// --- Single Package Lookup ---

app.get("/package/:registry/:name", async (c) => {
	const registry = c.req.param("registry");
	const name = c.req.param("name");
	const currentVersion = c.req.query("current");

	const packageManager = VALID_REGISTRIES[registry.toLowerCase()];
	if (!packageManager) {
		return c.json(
			{
				error: "Invalid registry",
				validRegistries: Object.keys(VALID_REGISTRIES),
			},
			400,
		);
	}

	const decodedName = decodeURIComponent(name);
	const maxNameLength = MAX_PACKAGE_NAME_LENGTH[packageManager];
	if (!decodedName || decodedName.length > maxNameLength) {
		return c.json({ error: "Invalid package name" }, 400);
	}

	const namePattern = PACKAGE_NAME_PATTERNS[packageManager];
	if (!namePattern.test(decodedName)) {
		return c.json(
			{ error: `Invalid package name format for ${packageManager}` },
			400,
		);
	}

	try {
		const info = await getPackageInfo(decodedName, packageManager);

		if (info.error === "Package not found") {
			return c.json(
				{
					error: "Package not found",
					name: decodedName,
					registry: packageManager,
				},
				404,
			);
		}

		const response: Record<string, unknown> = {
			name: decodedName,
			registry: packageManager,
			latestVersion: info.latestVersion,
			description: info.description,
			homepage: info.homepage,
			registryUrl: REGISTRY_WEB_URLS[packageManager](decodedName),
			checkedAt: new Date().toISOString(),
		};

		const metadata = buildPackageMetadata(info);
		if (metadata) response.metadata = metadata;

		if (currentVersion) {
			response.currentVersion = currentVersion;
			const status = info.error
				? PACKAGE_STATUS.ERROR
				: compareVersions(currentVersion, info.latestVersion);
			response.status = status;
			if (status === PACKAGE_STATUS.OUTDATED) {
				const versionDiff = calculateVersionDiff(
					currentVersion,
					info.latestVersion,
				);
				if (versionDiff) response.versionDiff = versionDiff;
			}
		}

		if (info.error) response.error = info.error;

		const cacheMaxAge = info.error ? 60 : 300;
		c.header(
			"Cache-Control",
			`public, s-maxage=${cacheMaxAge}, stale-while-revalidate=60`,
		);
		return c.json(response);
	} catch (error) {
		return handleServerError(c, error, "Error fetching package info");
	}
});

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
