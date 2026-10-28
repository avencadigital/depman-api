// Characterization tests for the public REST API.
//
// The Chrome and VS Code extensions consume these endpoints in production, so
// these tests pin the current behavior (status codes, bodies, headers),
// including quirks, before any refactor. A failing snapshot here means a
// client-visible change: update it only when that change is intentional.

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { MAX_PACKAGES_PER_ANALYSIS } from "@/lib/constants";
import {
	postAnalyze,
	registryFetch,
	registryUrlsFetched,
	request,
	resetState,
} from "./helpers";

beforeAll(() => {
	vi.stubGlobal("fetch", registryFetch);
});
afterAll(() => {
	vi.unstubAllGlobals();
});
beforeEach(() => {
	resetState();
});

async function snapshotOf(res: Response) {
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return {
		status: res.status,
		contentType: res.headers.get("content-type"),
		cacheControl: res.headers.get("cache-control"),
		body,
	};
}

const packageJson = JSON.stringify({
	name: "demo",
	dependencies: {
		hono: "^4.0.0",
		react: "~18.2.0",
		request: "2.88.2",
	},
	devDependencies: { "@types/node": "24.0.0" },
});

describe("GET /api/health", () => {
	it("returns status, version, uptime and cache stats", async () => {
		const res = await request("/api/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			message: "Good!",
			status: "ok",
			version: "0.2.0",
			uptime: expect.any(Number),
			cache: {
				totalEntries: expect.any(Number),
				validEntries: expect.any(Number),
				expiredEntries: expect.any(Number),
				errorEntries: expect.any(Number),
				successEntries: expect.any(Number),
				maxSize: 500,
			},
		});
	});
});

describe("GET /api/analyze-packages", () => {
	it("returns the API description document", async () => {
		expect(
			await snapshotOf(await request("/api/analyze-packages")),
		).toMatchSnapshot();
	});
});

describe("POST /api/analyze-packages", () => {
	describe("successful analysis", () => {
		it("analyzes a package.json", async () => {
			const res = await postAnalyze(
				JSON.stringify({ content: packageJson, fileName: "package.json" }),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
		});

		it("analyzes a package.json without fileName (auto-detect)", async () => {
			const res = await postAnalyze(JSON.stringify({ content: packageJson }));
			expect(res.status).toBe(200);
			expect((await res.json()).summary).toEqual({
				total: 4,
				upToDate: 2,
				outdated: 2,
				errors: 0,
			});
		});

		it("analyzes a requirements.txt", async () => {
			const content =
				"requests==2.28.0\nflask>=3.0\n# comment\nunknown-lib==1.0\n";
			const res = await postAnalyze(
				JSON.stringify({ content, fileName: "requirements.txt" }),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
		});

		it("analyzes a pubspec.yaml", async () => {
			const content = [
				"name: demo",
				"dependencies:",
				"  flutter:",
				"    sdk: flutter",
				"  provider: ^6.0.0",
				"  http: 0.13.0",
				"dev_dependencies:",
				"  missing_pkg: ^1.0.0",
				"",
			].join("\n");
			const res = await postAnalyze(
				JSON.stringify({ content, fileName: "pubspec.yaml" }),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
		});

		it("returns an empty result for a manifest without dependencies", async () => {
			const res = await postAnalyze(
				JSON.stringify({
					content: JSON.stringify({ name: "x", dependencies: {} }),
					fileName: "package.json",
				}),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
			expect(registryFetch).not.toHaveBeenCalled();
		});

		it("reports upstream failures per package without failing the request", async () => {
			const res = await postAnalyze(
				JSON.stringify({
					content: JSON.stringify({
						dependencies: { hono: "4.13.7", "broken-pkg": "1.0.0" },
					}),
					fileName: "package.json",
				}),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
		});

		it("marks invalid package names as errors without calling the registry", async () => {
			const res = await postAnalyze(
				JSON.stringify({
					content: JSON.stringify({
						dependencies: { hono: "4.13.7", "../../evil": "1.0.0" },
					}),
					fileName: "package.json",
				}),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
			expect(registryUrlsFetched()).toEqual([
				"https://registry.npmjs.org/hono",
			]);
		});
	});

	// The extensions may not send a JSON Content-Type: the current handler
	// parses the body regardless of the header. This must keep working.
	describe("Content-Type tolerance", () => {
		const body = JSON.stringify({
			content: packageJson,
			fileName: "package.json",
		});

		it.each([
			["no Content-Type header", null],
			["text/plain", "text/plain"],
			["text/plain;charset=UTF-8", "text/plain;charset=UTF-8"],
			["application/json; charset=utf-8", "application/json; charset=utf-8"],
		])("accepts %s", async (_label, contentType) => {
			const res = await postAnalyze(body, contentType);
			expect(res.status).toBe(200);
			expect((await res.json()).summary.total).toBe(4);
		});
	});

	describe("input validation", () => {
		it.each([
			["missing content", {}],
			["empty content", { content: "" }],
			["non-string content", { content: 123 }],
			["null content", { content: null }],
		])("rejects %s", async (_label, payload) => {
			expect(
				await snapshotOf(await postAnalyze(JSON.stringify(payload))),
			).toMatchSnapshot();
		});

		it.each([
			["null", null],
			["empty string", ""],
			["false", false],
			["0", 0],
		])("ignores a falsy fileName (%s)", async (_label, fileName) => {
			const res = await postAnalyze(
				JSON.stringify({ content: packageJson, fileName }),
			);
			expect(res.status).toBe(200);
		});

		it("ignores unknown extra fields", async () => {
			const res = await postAnalyze(
				JSON.stringify({
					content: packageJson,
					fileName: "package.json",
					extra: true,
				}),
			);
			expect(res.status).toBe(200);
		});

		it.each([
			["non-string fileName", { fileName: 123 }],
			["too long fileName", { fileName: `${"a".repeat(260)}.json` }],
			["disallowed extension", { fileName: "deps.exe" }],
		])("rejects %s", async (_label, extra) => {
			const res = await postAnalyze(
				JSON.stringify({ content: packageJson, ...extra }),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
		});

		it("strips path separators from fileName before checking the extension", async () => {
			const res = await postAnalyze(
				JSON.stringify({
					content: packageJson,
					fileName: "../../package.json",
				}),
			);
			expect(res.status).toBe(200);
		});

		it("rejects unparseable content", async () => {
			const res = await postAnalyze(
				JSON.stringify({
					content: "this is not a manifest {",
					fileName: "package.json",
				}),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
		});

		it("rejects valid JSON that is not a package.json", async () => {
			const res = await postAnalyze(JSON.stringify({ content: '{"foo": 1}' }));
			expect(await snapshotOf(res)).toMatchSnapshot();
		});

		it("rejects too many packages", async () => {
			const dependencies = Object.fromEntries(
				Array.from({ length: MAX_PACKAGES_PER_ANALYSIS + 1 }, (_, i) => [
					`pkg-${i}`,
					"1.0.0",
				]),
			);
			const res = await postAnalyze(
				JSON.stringify({
					content: JSON.stringify({ dependencies }),
					fileName: "package.json",
				}),
			);
			expect(await snapshotOf(res)).toMatchSnapshot();
			expect(registryFetch).not.toHaveBeenCalled();
		});

		it("rejects a Content-Length above the size limit", async () => {
			const res = await request("/api/analyze-packages", {
				method: "POST",
				body: "{}",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(6 * 1024 * 1024),
				},
			});
			expect(await snapshotOf(res)).toMatchSnapshot();
		});
	});

	// Current behavior: a body that is not JSON surfaces as a generic 500.
	it("answers malformed JSON with a generic 500", async () => {
		const res = await postAnalyze("{not json");
		expect(await snapshotOf(res)).toMatchSnapshot();
	});
});

describe("GET /api/package/:registry/:name", () => {
	it("returns package info", async () => {
		const res = await request("/api/package/npm/hono");
		const snap = await snapshotOf(res);
		expect(snap).toMatchSnapshot({ body: { checkedAt: expect.any(String) } });
	});

	it("compares against ?current=", async () => {
		const res = await request("/api/package/npm/react?current=17.0.2");
		const snap = await snapshotOf(res);
		expect(snap).toMatchSnapshot({ body: { checkedAt: expect.any(String) } });
	});

	it("supports scoped npm packages", async () => {
		const res = await request(
			"/api/package/npm/%40types%2Fnode?current=26.2.0",
		);
		const snap = await snapshotOf(res);
		expect(snap).toMatchSnapshot({ body: { checkedAt: expect.any(String) } });
	});

	it.each([
		["pypi", "/api/package/pypi/requests?current=2.28.0"],
		["pip", "/api/package/pip/flask"],
		["pub", "/api/package/pub/provider?current=6.0.0"],
		["flutter", "/api/package/flutter/http?current=1.5.0"],
		["dart (case-insensitive)", "/api/package/DART/http"],
	])("supports registry alias %s", async (_label, path) => {
		const res = await request(path);
		const snap = await snapshotOf(res);
		expect(snap).toMatchSnapshot({ body: { checkedAt: expect.any(String) } });
	});

	it("rejects an unknown registry", async () => {
		expect(
			await snapshotOf(await request("/api/package/cargo/serde")),
		).toMatchSnapshot();
	});

	it("rejects an invalid package name", async () => {
		expect(
			await snapshotOf(await request("/api/package/pub/Bad-Name")),
		).toMatchSnapshot();
	});

	it("rejects a too long package name", async () => {
		const res = await request(`/api/package/pub/${"a".repeat(65)}`);
		expect(await snapshotOf(res)).toMatchSnapshot();
	});

	it("returns 404 for unknown packages", async () => {
		expect(
			await snapshotOf(await request("/api/package/npm/does-not-exist")),
		).toMatchSnapshot();
	});

	it("returns 502 with no-store for upstream failures", async () => {
		const res = await request("/api/package/npm/broken-pkg");
		expect(await snapshotOf(res)).toMatchSnapshot();
	}, 15_000);
});

describe("cross-cutting behavior", () => {
	it("rate limits per client IP (30 requests per minute)", async () => {
		const ip = "203.0.113.7";
		for (let i = 0; i < 30; i++) {
			expect((await request("/api/health", { ip })).status).toBe(200);
		}
		const res = await request("/api/health", { ip });
		expect(res.status).toBe(429);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(await res.json()).toEqual({
			error: "Too many requests, please try again later",
		});
		// Other clients are unaffected.
		expect((await request("/api/health")).status).toBe(200);
	});

	it("uses the first X-Forwarded-For entry as the client key", async () => {
		const headers = { "x-forwarded-for": "198.51.100.1, 10.0.0.1" };
		for (let i = 0; i < 30; i++) await request("/api/health", { headers });
		const res = await request("/api/health", {
			headers: { "x-forwarded-for": "198.51.100.1, 10.9.9.9" },
		});
		expect(res.status).toBe(429);
	});

	it("answers CORS preflight for any origin", async () => {
		const res = await request("/api/analyze-packages", {
			method: "OPTIONS",
			headers: {
				Origin: "chrome-extension://abcdef",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
	});

	it("sets the CORS header on regular responses", async () => {
		const res = await request("/api/health", {
			headers: { Origin: "vscode-webview://xyz" },
		});
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("returns 404 for unknown routes", async () => {
		const res = await request("/api/unknown");
		expect(res.status).toBe(404);
	});
});

describe("cache", () => {
	// Regression: a cached PyPI entry stored under another spelling of the
	// name made the analysis report "Invalid package name".
	it("matches PyPI names case-insensitively without breaking the analysis", async () => {
		await request("/api/package/pip/requests");
		const res = await postAnalyze(
			JSON.stringify({
				content: "Requests==2.28.0\n",
				fileName: "requirements.txt",
			}),
		);
		const body = await res.json();
		expect(body.packages[0]).toMatchObject({
			name: "Requests",
			status: "outdated",
			latestVersion: "2.33.0",
		});
		expect(registryFetch).toHaveBeenCalledTimes(1);
	});

	it("keeps npm names case-sensitive", async () => {
		await request("/api/package/npm/hono");
		const res = await request("/api/package/npm/Hono");
		expect(res.status).toBe(404);
		expect(registryFetch).toHaveBeenCalledTimes(2);
	});
});
