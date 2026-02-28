import pLimit from "p-limit";
import { CacheService } from "./cache-service";
import {
	DEFAULT_TIMEOUT,
	MAX_CONCURRENT_REQUESTS,
	REGISTRY_API_URLS,
} from "./constants";
import { RetryPresets, retryWithBackoff } from "./retry-util";
import type { PackageVersionInfo } from "./types";

const cache = CacheService.getInstance();
const concurrencyLimit = pLimit(MAX_CONCURRENT_REQUESTS);

function extractRepoUrl(repo: unknown): string | undefined {
	if (!repo) return undefined;
	if (typeof repo === "string") return cleanRepoUrl(repo);
	if (typeof repo === "object" && repo !== null) {
		const repoObj = repo as { url?: string };
		if (repoObj.url) return cleanRepoUrl(repoObj.url);
	}
	return undefined;
}

function cleanRepoUrl(url: string): string {
	return url
		.replace(/^git\+/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/\.git$/, "")
		.replace(/^ssh:\/\/git@github\.com/, "https://github.com");
}

async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeout: number = DEFAULT_TIMEOUT,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}

// ---------------------------------------------------------------------------
// Generic registry fetcher – eliminates duplicated cache/fetch/error logic
// ---------------------------------------------------------------------------

type RegistryName = "npm" | "pip" | "pub";

interface RegistryConfig {
	cacheKey: RegistryName;
	buildUrl: (packageName: string) => string;
	mapResponse: (packageName: string, data: unknown) => PackageVersionInfo;
}

async function fetchFromRegistry(
	packageName: string,
	config: RegistryConfig,
): Promise<PackageVersionInfo> {
	const cached = cache.get(packageName, config.cacheKey);
	if (cached) return cached;

	try {
		const response = await retryWithBackoff(
			() =>
				fetchWithTimeout(config.buildUrl(packageName), {
					headers: { Accept: "application/json" },
				}),
			{ ...RetryPresets.standard },
		);

		if (!response.ok) {
			if (response.status === 404) {
				return {
					name: packageName,
					latestVersion: "unknown",
					error: "Package not found",
				};
			}
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json();
		const result = config.mapResponse(packageName, data);
		cache.set(packageName, config.cacheKey, result);
		return result;
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.name === "AbortError"
					? "Request timeout"
					: error.message
				: "Unknown error";
		const result: PackageVersionInfo = {
			name: packageName,
			latestVersion: "unknown",
			error: errorMessage,
		};
		cache.set(packageName, config.cacheKey, result);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Type-safe accessors for unknown registry response data
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((v) => typeof v === "string")
		? (value as string[])
		: undefined;
}

// ---------------------------------------------------------------------------
// Registry-specific configurations (URL + response mapper only)
// ---------------------------------------------------------------------------

const npmConfig: RegistryConfig = {
	cacheKey: "npm",
	buildUrl: REGISTRY_API_URLS.npm,
	mapResponse: (name, raw) => {
		const data = asRecord(raw) ?? {};
		const distTags = asRecord(data["dist-tags"]);
		const latestVersion = asString(distTags?.latest) ?? "unknown";
		const versions = asRecord(data.versions);
		const latestVersionData = asRecord(versions?.[latestVersion]) ?? {};
		const timeData = asRecord(data.time) ?? {};

		const deprecated = latestVersionData.deprecated ?? data.deprecated;

		return {
			name,
			latestVersion,
			description: asString(data.description),
			homepage:
				asString(data.homepage) ||
				(typeof data.repository === "object" && data.repository !== null
					? asString((data.repository as Record<string, unknown>).url)
							?.replace(/^git\+/, "")
							.replace(/\.git$/, "")
					: undefined),
			license:
				typeof data.license === "string"
					? data.license
					: asString(asRecord(data.license)?.type),
			repository: extractRepoUrl(data.repository),
			deprecated:
				typeof deprecated === "string" || typeof deprecated === "boolean"
					? deprecated
					: undefined,
			lastPublished:
				asString(timeData[latestVersion]) || asString(timeData.modified),
			keywords: asStringArray(data.keywords)?.slice(0, 10),
		};
	},
};

const pypiConfig: RegistryConfig = {
	cacheKey: "pip",
	buildUrl: REGISTRY_API_URLS.pip,
	mapResponse: (name, raw) => {
		const data = asRecord(raw) ?? {};
		const info = asRecord(data.info) ?? {};
		const releases = asRecord(data.releases) ?? {};
		const version = asString(info.version);
		const releaseList = version ? releases[version] : undefined;
		const latestRelease = Array.isArray(releaseList) && releaseList.length > 0
			? asRecord(releaseList.at(-1))
			: undefined;
		const projectUrls = asRecord(info.project_urls);

		return {
			name,
			latestVersion: version ?? "unknown",
			description: asString(info.summary),
			homepage:
				asString(info.home_page) ||
				asString(projectUrls?.Homepage) ||
				asString(projectUrls?.homepage),
			license: asString(info.license),
			repository:
				asString(projectUrls?.Repository) ||
				asString(projectUrls?.Source) ||
				asString(projectUrls?.GitHub),
			lastPublished:
				asString(latestRelease?.upload_time_iso_8601) ||
				asString(latestRelease?.upload_time),
			keywords: asStringArray(info.keywords)?.slice(0, 10),
		};
	},
};

const pubConfig: RegistryConfig = {
	cacheKey: "pub",
	buildUrl: REGISTRY_API_URLS.pub,
	mapResponse: (name, raw) => {
		const data = asRecord(raw) ?? {};
		const latest = asRecord(data.latest) ?? {};
		const pubspec = asRecord(latest.pubspec) ?? {};

		return {
			name,
			latestVersion: asString(latest.version) ?? "unknown",
			description: asString(pubspec.description),
			homepage: asString(pubspec.homepage) || asString(pubspec.repository),
			repository:
				asString(pubspec.repository) || asString(pubspec.issue_tracker),
			lastPublished: asString(latest.published),
			keywords: asStringArray(pubspec.topics)?.slice(0, 10),
		};
	},
};

const registryConfigs: Record<RegistryName, RegistryConfig> = {
	npm: npmConfig,
	pip: pypiConfig,
	pub: pubConfig,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPackageInfo(
	packageName: string,
	packageManager: RegistryName,
): Promise<PackageVersionInfo> {
	const config = registryConfigs[packageManager];
	if (!config) {
		return Promise.resolve({
			name: packageName,
			latestVersion: "unknown",
			error: "Unsupported package manager",
		});
	}
	return fetchFromRegistry(packageName, config);
}

export function getMultiplePackagesInfo(
	packages: Array<{ name: string; manager: RegistryName }>,
): Promise<PackageVersionInfo[]> {
	const promises = packages.map((pkg) =>
		concurrencyLimit(() => getPackageInfo(pkg.name, pkg.manager)),
	);
	return Promise.all(promises);
}
