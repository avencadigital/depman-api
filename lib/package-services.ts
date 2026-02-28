import pLimit from "p-limit";
import { CacheService } from "./cache-service";
import { RetryPresets, retryWithBackoff } from "./retry-util";
import type { PackageVersionInfo } from "./types";

const DEFAULT_TIMEOUT = 10000;
const MAX_CONCURRENT_REQUESTS = 10;
const cache = CacheService.getInstance();

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

export class NPMService {
	private static readonly BASE_URL = "https://registry.npmjs.org";

	static async getPackageInfo(
		packageName: string,
	): Promise<PackageVersionInfo> {
		const cached = cache.get(packageName, "npm");
		if (cached) return cached;
		try {
			const response = await retryWithBackoff(
				() =>
					fetchWithTimeout(`${NPMService.BASE_URL}/${packageName}`, {
						headers: { Accept: "application/json" },
					}),
				{ ...RetryPresets.standard },
			);
			if (!response.ok) {
				if (response.status === 404)
					return {
						name: packageName,
						latestVersion: "unknown",
						error: "Package not found",
					};
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			const data = await response.json();
			const latestVersion = data["dist-tags"]?.latest || "unknown";
			const latestVersionData = data.versions?.[latestVersion] || {};
			const timeData = data.time || {};
			const result: PackageVersionInfo = {
				name: packageName,
				latestVersion,
				description: data.description,
				homepage:
					data.homepage ||
					data.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
				license:
					typeof data.license === "string" ? data.license : data.license?.type,
				repository: extractRepoUrl(data.repository),
				deprecated: latestVersionData.deprecated || data.deprecated,
				lastPublished: timeData[latestVersion] || timeData.modified,
				keywords: data.keywords?.slice(0, 10),
			};
			cache.set(packageName, "npm", result);
			return result;
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.name === "AbortError"
						? "Request timeout"
						: error.message
					: "Unknown error";
			const result = {
				name: packageName,
				latestVersion: "unknown",
				error: errorMessage,
			};
			cache.set(packageName, "npm", result);
			return result;
		}
	}
}

export class PyPIService {
	private static readonly BASE_URL = "https://pypi.org/pypi";

	static async getPackageInfo(
		packageName: string,
	): Promise<PackageVersionInfo> {
		const cached = cache.get(packageName, "pip");
		if (cached) return cached;
		try {
			const response = await retryWithBackoff(
				() =>
					fetchWithTimeout(`${PyPIService.BASE_URL}/${packageName}/json`, {
						headers: { Accept: "application/json" },
					}),
				{ ...RetryPresets.standard },
			);
			if (!response.ok) {
				if (response.status === 404)
					return {
						name: packageName,
						latestVersion: "unknown",
						error: "Package not found",
					};
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			const data = await response.json();
			const info = data.info;
			const releases = data.releases || {};
			const latestRelease = releases[info.version]?.[0];
			const result: PackageVersionInfo = {
				name: packageName,
				latestVersion: info.version || "unknown",
				description: info.summary,
				homepage:
					info.home_page ||
					info.project_urls?.Homepage ||
					info.project_urls?.homepage,
				license: info.license,
				repository:
					info.project_urls?.Repository ||
					info.project_urls?.Source ||
					info.project_urls?.GitHub,
				lastPublished:
					latestRelease?.upload_time_iso_8601 || latestRelease?.upload_time,
				keywords: info.keywords?.slice(0, 10),
			};
			cache.set(packageName, "pip", result);
			return result;
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.name === "AbortError"
						? "Request timeout"
						: error.message
					: "Unknown error";
			const result = {
				name: packageName,
				latestVersion: "unknown",
				error: errorMessage,
			};
			cache.set(packageName, "pip", result);
			return result;
		}
	}
}

export class PubDevService {
	private static readonly BASE_URL = "https://pub.dev/api";

	static async getPackageInfo(
		packageName: string,
	): Promise<PackageVersionInfo> {
		const cached = cache.get(packageName, "pub");
		if (cached) return cached;
		try {
			const response = await retryWithBackoff(
				() =>
					fetchWithTimeout(
						`${PubDevService.BASE_URL}/packages/${packageName}`,
						{
							headers: { Accept: "application/json" },
						},
					),
				{ ...RetryPresets.standard },
			);
			if (!response.ok) {
				if (response.status === 404)
					return {
						name: packageName,
						latestVersion: "unknown",
						error: "Package not found",
					};
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			const data = await response.json();
			const latest = data.latest;
			const pubspec = latest?.pubspec || {};
			const result: PackageVersionInfo = {
				name: packageName,
				latestVersion: latest?.version || "unknown",
				description: pubspec.description,
				homepage: pubspec.homepage || pubspec.repository,
				repository: pubspec.repository || pubspec.issue_tracker,
				lastPublished: latest?.published,
				keywords: pubspec.topics?.slice(0, 10),
			};
			cache.set(packageName, "pub", result);
			return result;
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.name === "AbortError"
						? "Request timeout"
						: error.message
					: "Unknown error";
			const result = {
				name: packageName,
				latestVersion: "unknown",
				error: errorMessage,
			};
			cache.set(packageName, "pub", result);
			return result;
		}
	}
}

export class PackageManagerService {
	private static readonly limit = pLimit(MAX_CONCURRENT_REQUESTS);

	static async getPackageInfo(
		packageName: string,
		packageManager: "npm" | "pip" | "pub",
	): Promise<PackageVersionInfo> {
		switch (packageManager) {
			case "npm":
				return NPMService.getPackageInfo(packageName);
			case "pip":
				return PyPIService.getPackageInfo(packageName);
			case "pub":
				return PubDevService.getPackageInfo(packageName);
			default:
				return {
					name: packageName,
					latestVersion: "unknown",
					error: "Unsupported package manager",
				};
		}
	}

	static async getMultiplePackagesInfo(
		packages: Array<{ name: string; manager: "npm" | "pip" | "pub" }>,
	): Promise<PackageVersionInfo[]> {
		const promises = packages.map((pkg) =>
			PackageManagerService.limit(() =>
				PackageManagerService.getPackageInfo(pkg.name, pkg.manager),
			),
		);
		return Promise.all(promises);
	}
}
