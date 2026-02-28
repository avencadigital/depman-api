import pLimit from "p-limit";
import { CacheService } from "./cache-service";
import { DEFAULT_TIMEOUT, MAX_CONCURRENT_REQUESTS } from "./constants";
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
// Registry-specific configurations (URL + response mapper only)
// ---------------------------------------------------------------------------

const npmConfig: RegistryConfig = {
	cacheKey: "npm",
	buildUrl: (name) => `https://registry.npmjs.org/${name}`,
	mapResponse: (name, raw) => {
		const data = raw as Record<string, unknown>;
		const distTags = data["dist-tags"] as Record<string, string> | undefined;
		const latestVersion = distTags?.latest || "unknown";
		const versions = data.versions as
			| Record<string, Record<string, unknown>>
			| undefined;
		const latestVersionData = versions?.[latestVersion] || {};
		const timeData = (data.time as Record<string, string>) || {};
		const repo = data.repository as { url?: string } | string | undefined;

		return {
			name,
			latestVersion,
			description: data.description as string | undefined,
			homepage:
				(data.homepage as string) ||
				(typeof repo === "object" && repo?.url
					? repo.url.replace(/^git\+/, "").replace(/\.git$/, "")
					: undefined),
			license:
				typeof data.license === "string"
					? data.license
					: (data.license as { type?: string })?.type,
			repository: extractRepoUrl(data.repository),
			deprecated:
				(latestVersionData.deprecated as string | undefined) ||
				(data.deprecated as string | boolean | undefined),
			lastPublished: timeData[latestVersion] || timeData.modified,
			keywords: (data.keywords as string[] | undefined)?.slice(0, 10),
		};
	},
};

const pypiConfig: RegistryConfig = {
	cacheKey: "pip",
	buildUrl: (name) => `https://pypi.org/pypi/${name}/json`,
	mapResponse: (name, raw) => {
		const data = raw as Record<string, unknown>;
		const info = data.info as Record<string, unknown>;
		const releases =
			(data.releases as Record<string, Array<Record<string, unknown>>>) || {};
		const latestRelease = releases[info.version as string]?.[0];
		const projectUrls = info.project_urls as Record<string, string> | undefined;

		return {
			name,
			latestVersion: (info.version as string) || "unknown",
			description: info.summary as string | undefined,
			homepage:
				(info.home_page as string) ||
				projectUrls?.Homepage ||
				projectUrls?.homepage,
			license: info.license as string | undefined,
			repository:
				projectUrls?.Repository || projectUrls?.Source || projectUrls?.GitHub,
			lastPublished:
				(latestRelease?.upload_time_iso_8601 as string) ||
				(latestRelease?.upload_time as string),
			keywords: (info.keywords as string[] | undefined)?.slice(0, 10),
		};
	},
};

const pubConfig: RegistryConfig = {
	cacheKey: "pub",
	buildUrl: (name) => `https://pub.dev/api/packages/${name}`,
	mapResponse: (name, raw) => {
		const data = raw as Record<string, unknown>;
		const latest = data.latest as Record<string, unknown> | undefined;
		const pubspec = (latest?.pubspec as Record<string, unknown>) || {};

		return {
			name,
			latestVersion: (latest?.version as string) || "unknown",
			description: pubspec.description as string | undefined,
			homepage: (pubspec.homepage as string) || (pubspec.repository as string),
			repository:
				(pubspec.repository as string) || (pubspec.issue_tracker as string),
			lastPublished: latest?.published as string | undefined,
			keywords: (pubspec.topics as string[] | undefined)?.slice(0, 10),
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
