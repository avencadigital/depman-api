import * as semver from "semver";
import { PACKAGE_STATUS, type PackageStatus, type VersionDiff } from "./types";

export function cleanVersion(version: string): string {
	return version
		.replace(/[\^~>=<]/g, "")
		.replace(/^v/i, "")
		.trim();
}

// Plain semver.coerce() silently drops any prerelease tag (e.g. "1.0.0-beta"
// coerces to "1.0.0"), which would hide a package pinned to a prerelease
// version from ever showing as outdated once the stable release ships.
function coerceVersion(version: string) {
	return semver.coerce(version, { includePrerelease: true });
}

export function calculateVersionDiff(
	current: string,
	latest: string,
): VersionDiff | undefined {
	try {
		const cleanCurrent = cleanVersion(current);
		const cleanLatest = cleanVersion(latest);
		if (
			cleanCurrent === cleanLatest ||
			cleanCurrent === "any" ||
			cleanCurrent === "*" ||
			cleanCurrent === "x" ||
			latest === "unknown" ||
			current === "unknown"
		)
			return undefined;

		const currentSemver = coerceVersion(cleanCurrent);
		const latestSemver = coerceVersion(cleanLatest);
		if (!currentSemver || !latestSemver) return undefined;
		if (semver.gte(currentSemver, latestSemver))
			return {
				majorsBehind: 0,
				minorsBehind: 0,
				patchesBehind: 0,
				hasBreakingChanges: false,
				urgency: "none",
			};

		const majorsBehind = latestSemver.major - currentSemver.major;
		const minorsBehind =
			majorsBehind === 0 ? latestSemver.minor - currentSemver.minor : 0;
		const patchesBehind =
			majorsBehind === 0 && minorsBehind === 0
				? latestSemver.patch - currentSemver.patch
				: 0;
		const hasBreakingChanges = majorsBehind > 0;

		let urgency: VersionDiff["urgency"];
		if (majorsBehind >= 3) urgency = "critical";
		else if (majorsBehind >= 2) urgency = "high";
		else if (majorsBehind >= 1) urgency = "medium";
		else if (minorsBehind >= 5) urgency = "medium";
		else if (minorsBehind >= 1 || patchesBehind >= 1) urgency = "low";
		else urgency = "none";

		return {
			majorsBehind,
			minorsBehind,
			patchesBehind,
			hasBreakingChanges,
			urgency,
		};
	} catch {
		return undefined;
	}
}

const RANGE_OPERATOR_PATTERN = /[\^~<>=]|\s/;

export function compareVersions(
	current: string,
	latest: string,
): PackageStatus {
	if (latest === "unknown" || current === "unknown")
		return PACKAGE_STATUS.ERROR;
	if (latest === "latest" || current === "latest")
		return PACKAGE_STATUS.UP_TO_DATE;
	try {
		const cleanCurrent = cleanVersion(current);
		const cleanLatest = cleanVersion(latest);
		if (cleanCurrent === "any" || cleanCurrent === "*" || cleanCurrent === "x")
			return PACKAGE_STATUS.UP_TO_DATE;
		if (cleanCurrent === cleanLatest) return PACKAGE_STATUS.UP_TO_DATE;

		const latestSemver = coerceVersion(cleanLatest);
		if (!latestSemver) return PACKAGE_STATUS.ERROR;

		// A range like "^5.0.0" is up to date whenever the latest release still
		// satisfies it. Coercing both sides down to plain versions (below)
		// would flag it as outdated as soon as latest moved past the range's
		// floor, even though the range already allows that release.
		const trimmedCurrent = current.trim();
		if (RANGE_OPERATOR_PATTERN.test(trimmedCurrent)) {
			const validRange = semver.validRange(trimmedCurrent);
			if (validRange) {
				return semver.satisfies(latestSemver, validRange, {
					includePrerelease: true,
				})
					? PACKAGE_STATUS.UP_TO_DATE
					: PACKAGE_STATUS.OUTDATED;
			}
		}

		const currentSemver = coerceVersion(cleanCurrent);
		if (!currentSemver) return PACKAGE_STATUS.ERROR;
		if (semver.lt(currentSemver, latestSemver)) return PACKAGE_STATUS.OUTDATED;
		return PACKAGE_STATUS.UP_TO_DATE;
	} catch {
		return PACKAGE_STATUS.ERROR;
	}
}
