import { describe, expect, it } from "vitest";
import { detectFileType, getAllDependencies } from "@/lib/parsers";

function deps(content: string, fileName?: string) {
	return getAllDependencies(detectFileType(content, fileName));
}

describe("package.json parser", () => {
	it("merges dependencies, devDependencies, peer and optional deps", () => {
		const content = JSON.stringify({
			dependencies: { a: "1.0.0" },
			devDependencies: { b: "^2.0.0" },
			peerDependencies: { c: ">=3" },
			optionalDependencies: { d: "~4.1.0" },
		});
		expect(deps(content, "package.json")).toEqual({
			a: "1.0.0",
			b: "^2.0.0",
			c: ">=3",
			d: "~4.1.0",
		});
	});

	it("ignores non-string versions", () => {
		const content = JSON.stringify({
			dependencies: { a: "1.0.0", b: { version: "1" }, c: 18, d: null },
		});
		expect(deps(content, "package.json")).toEqual({ a: "1.0.0" });
	});

	it("ignores dependency sections that are not objects", () => {
		const content = JSON.stringify({
			name: "x",
			version: "1.0.0",
			dependencies: "abc",
			devDependencies: ["a", "b"],
		});
		expect(deps(content, "package.json")).toEqual({});
	});
});

describe("requirements.txt parser", () => {
	it.each([
		["requests==2.28.0", { requests: "2.28.0" }],
		["requests==2.28.0  # pinned for py3.8", { requests: "2.28.0" }],
		["flask==3.0.0 ; python_version >= '3.8'", { flask: "3.0.0" }],
		["django==4.0 \\", { django: "4.0" }],
		["django==4.0 --hash=sha256:abc", { django: "4.0" }],
		["requests[security]==2.28.0", { requests: "2.28.0" }],
		["numpy>=1.26,<2", { numpy: "1.26" }],
		["zope.interface==6.0", { "zope.interface": "6.0" }],
		["requests==2.28.0\r", { requests: "2.28.0" }],
		["pkg @ https://example.com/pkg.whl", {}],
		["-r base.txt", {}],
		["    --hash=sha256:def", {}],
		["# just a comment", {}],
	])("parses %j", (line, expected) => {
		expect(deps(`${line}\n`, "requirements.txt")).toEqual(expected);
	});
});

describe("pubspec.yaml parser", () => {
	it("extracts hosted, plain and empty constraints, skipping sdk/git/path", () => {
		const content = [
			"name: demo",
			"dependencies:",
			"  flutter:",
			"    sdk: flutter",
			"  provider: ^6.0.0",
			"  any_pkg:",
			"  hosted_pkg:",
			"    hosted: https://pub.example.com",
			"    version: ^1.2.0",
			"  git_pkg:",
			"    git: https://github.com/x/y",
			"dev_dependencies:",
			"  lints: ^4.0.0",
		].join("\n");
		expect(deps(content, "pubspec.yaml")).toEqual({
			provider: "^6.0.0",
			any_pkg: "any",
			hosted_pkg: "^1.2.0",
			lints: "^4.0.0",
		});
	});
});
