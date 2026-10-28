// Transport-agnostic business logic shared by the REST routes (lib/app.ts)
// and the MCP tools (lib/mcp/server.ts). Functions here never build HTTP
// responses: they return typed outcomes that each transport maps to its own
// format, so the REST contract stays exactly as the extensions expect.

import {
	ALLOWED_EXTENSIONS,
	MAX_PACKAGE_NAME_LENGTH,
	MAX_PACKAGES_PER_ANALYSIS,
	PACKAGE_NAME_PATTERNS,
	REGISTRY_WEB_URLS,
	VALID_REGISTRIES,
} from "./constants";
import { getMultiplePackagesInfo, getPackageInfo } from "./package-services";
import { detectFileType, getAllDependencies } from "./parsers";
import {
	PACKAGE_STATUS,
	type PackageAnalysisResponse,
	type PackageInfo,
	type PackageManager,
	type PackageMetadata,
	type PackageStatus,
	type VersionDiff,
} from "./types";
import { calculateVersionDiff, compareVersions } from "./version-utils";

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

export function sanitizeFileName(fileName: string): string {
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

export function hasValidExtension(fileName: string): boolean {
	return ALLOWED_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));
}

export function buildPackageMetadata(info: {
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

function isValidPackageName(
	name: string,
	packageManager: PackageManager,
): boolean {
	return (
		name.length <= MAX_PACKAGE_NAME_LENGTH[packageManager] &&
		PACKAGE_NAME_PATTERNS[packageManager].test(name)
	);
}

// ---------------------------------------------------------------------------
// Manifest analysis
// ---------------------------------------------------------------------------

export type AnalyzeOutcome =
	| { kind: "ok"; result: PackageAnalysisResponse }
	| { kind: "parse-error"; message: string }
	| { kind: "too-many-packages"; count: number; max: number };

/**
 * Parses a dependency manifest and checks every dependency against its
 * registry. `fileName` must already be sanitized and validated by the caller.
 */
export async function analyzeManifest(
	content: string,
	fileName?: string,
): Promise<AnalyzeOutcome> {
	let packageData: ReturnType<typeof detectFileType>;
	try {
		packageData = detectFileType(content, fileName);
	} catch (error) {
		return {
			kind: "parse-error",
			message: error instanceof Error ? error.message : "Unknown parse error",
		};
	}

	const allDependencies = getAllDependencies(packageData);
	const packageNames = Object.keys(allDependencies);

	if (packageNames.length === 0) {
		return {
			kind: "ok",
			result: {
				packages: [],
				summary: { total: 0, upToDate: 0, outdated: 0, errors: 0 },
			},
		};
	}

	if (packageNames.length > MAX_PACKAGES_PER_ANALYSIS) {
		return {
			kind: "too-many-packages",
			count: packageNames.length,
			max: MAX_PACKAGES_PER_ANALYSIS,
		};
	}

	const { packageManager } = packageData;
	const packagesToCheck = packageNames
		.filter((name) => isValidPackageName(name, packageManager))
		.map((name) => ({ name, manager: packageManager }));
	const packageInfos = await getMultiplePackagesInfo(packagesToCheck);
	const infoByName = new Map(packageInfos.map((info) => [info.name, info]));

	const packages: PackageInfo[] = packageNames.map((packageName) => {
		const info = infoByName.get(packageName) ?? {
			name: packageName,
			latestVersion: "unknown",
			error: "Invalid package name",
		};
		const currentVersion = allDependencies[packageName];
		const metadata = buildPackageMetadata(info);

		if (info.error) {
			return {
				name: packageName,
				currentVersion,
				latestVersion: info.latestVersion,
				status: PACKAGE_STATUS.ERROR,
				packageManager,
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
			packageManager,
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

	return { kind: "ok", result: { packages, summary } };
}

// ---------------------------------------------------------------------------
// Single package lookup
// ---------------------------------------------------------------------------

export interface PackageLookupResult {
	name: string;
	registry: PackageManager;
	latestVersion: string;
	description?: string;
	homepage?: string;
	registryUrl: string;
	checkedAt: string;
	metadata?: PackageMetadata;
	currentVersion?: string;
	status?: PackageStatus;
	versionDiff?: VersionDiff;
}

export type LookupOutcome =
	| { kind: "ok"; result: PackageLookupResult }
	| { kind: "invalid-registry"; validRegistries: string[] }
	| { kind: "invalid-name"; message: string }
	| { kind: "not-found"; name: string; registry: PackageManager }
	| {
			kind: "upstream-error";
			error: string;
			name: string;
			registry: PackageManager;
	  };

/**
 * Looks up a single package. `registry` accepts the public aliases
 * (npm, pip, pypi, pub, dart, flutter), case-insensitively.
 */
export async function lookupPackage(
	registry: string,
	name: string,
	currentVersion?: string,
): Promise<LookupOutcome> {
	const packageManager = VALID_REGISTRIES[registry.toLowerCase()];
	if (!packageManager) {
		return {
			kind: "invalid-registry",
			validRegistries: Object.keys(VALID_REGISTRIES),
		};
	}

	if (!name || name.length > MAX_PACKAGE_NAME_LENGTH[packageManager]) {
		return { kind: "invalid-name", message: "Invalid package name" };
	}
	if (!PACKAGE_NAME_PATTERNS[packageManager].test(name)) {
		return {
			kind: "invalid-name",
			message: `Invalid package name format for ${packageManager}`,
		};
	}

	const info = await getPackageInfo(name, packageManager);

	if (info.error === "Package not found") {
		return { kind: "not-found", name, registry: packageManager };
	}
	if (info.error) {
		return {
			kind: "upstream-error",
			error: info.error,
			name,
			registry: packageManager,
		};
	}

	const result: PackageLookupResult = {
		name,
		registry: packageManager,
		latestVersion: info.latestVersion,
		description: info.description,
		homepage: info.homepage,
		registryUrl: REGISTRY_WEB_URLS[packageManager](name),
		checkedAt: new Date().toISOString(),
	};

	const metadata = buildPackageMetadata(info);
	if (metadata) result.metadata = metadata;

	if (currentVersion) {
		result.currentVersion = currentVersion;
		const status = compareVersions(currentVersion, info.latestVersion);
		result.status = status;
		if (status === PACKAGE_STATUS.OUTDATED) {
			const versionDiff = calculateVersionDiff(
				currentVersion,
				info.latestVersion,
			);
			if (versionDiff) result.versionDiff = versionDiff;
		}
	}

	return { kind: "ok", result };
}
