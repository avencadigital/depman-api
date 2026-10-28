import { describe, expect, it } from "vitest";
import {
	calculateVersionDiff,
	cleanVersion,
	compareVersions,
} from "@/lib/version-utils";

describe("cleanVersion", () => {
	it.each([
		["^1.2.3", "1.2.3"],
		["~1.2.3", "1.2.3"],
		[">=1.2.3", "1.2.3"],
		["v1.2.3", "1.2.3"],
		[" 1.2.3 ", "1.2.3"],
	])("%j -> %j", (input, expected) => {
		expect(cleanVersion(input)).toBe(expected);
	});
});

describe("compareVersions", () => {
	it.each([
		// exact versions
		["1.2.3", "1.2.3", "up-to-date"],
		["1.2.3", "1.2.4", "outdated"],
		["2.0.0", "1.9.9", "up-to-date"],
		["1.2", "1.2.1", "outdated"],
		// ranges: up to date while latest satisfies them
		["^4.0.0", "4.13.7", "up-to-date"],
		["^4.0.0", "5.0.0", "outdated"],
		["~18.2.0", "18.2.9", "up-to-date"],
		["~18.2.0", "18.3.0", "outdated"],
		[">=1.0.0 <2.0.0", "1.9.0", "up-to-date"],
		// prereleases are not hidden by coercion
		["1.0.0-beta.1", "1.0.0", "outdated"],
		// wildcards and special values
		["*", "9.9.9", "up-to-date"],
		["x", "9.9.9", "up-to-date"],
		["any", "9.9.9", "up-to-date"],
		["latest", "9.9.9", "up-to-date"],
		["1.0.0", "unknown", "error"],
		["unknown", "1.0.0", "error"],
		["not-a-version", "1.0.0", "error"],
	])("current %j vs latest %j -> %s", (current, latest, expected) => {
		expect(compareVersions(current, latest)).toBe(expected);
	});
});

describe("calculateVersionDiff", () => {
	it.each([
		["1.0.0", "1.0.1", [0, 0, 1, false, "low"]],
		["1.0.0", "1.2.0", [0, 2, 0, false, "low"]],
		["1.0.0", "1.5.0", [0, 5, 0, false, "medium"]],
		["1.0.0", "2.0.0", [1, 0, 0, true, "medium"]],
		["1.0.0", "3.1.0", [2, 0, 0, true, "high"]],
		["1.0.0", "4.0.0", [3, 0, 0, true, "critical"]],
		["^17.0.2", "19.3.0", [2, 0, 0, true, "high"]],
		["2.0.0", "1.0.0", [0, 0, 0, false, "none"]],
	] as const)("%j -> %j", (current, latest, expected) => {
		const [
			majorsBehind,
			minorsBehind,
			patchesBehind,
			hasBreakingChanges,
			urgency,
		] = expected;
		expect(calculateVersionDiff(current, latest)).toEqual({
			majorsBehind,
			minorsBehind,
			patchesBehind,
			hasBreakingChanges,
			urgency,
		});
	});

	it.each([
		["1.0.0", "1.0.0"],
		["*", "1.0.0"],
		["1.0.0", "unknown"],
		["garbage", "1.0.0"],
	])("returns undefined for %j vs %j", (current, latest) => {
		expect(calculateVersionDiff(current, latest)).toBeUndefined();
	});
});
