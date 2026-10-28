// End-to-end tests for the MCP endpoint (/api/mcp) using real MCP clients:
// the v2 client on the 2026-07-28 protocol, the v2 client in its default
// legacy (2025) mode, and the v1 SDK client most hosts still ship.

import {
	Client as ClientV2,
	StreamableHTTPClientTransport as TransportV2,
} from "@modelcontextprotocol/client";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as TransportV1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { app } from "@/lib/app";
import { nextIp, registryFetch, request, resetState } from "./helpers";

const MCP_URL = new URL("http://localhost/api/mcp");

// Routes the MCP client's HTTP traffic into the Hono app in-process, with a
// distinct client IP per connection so rate limiting stays out of the way.
function appFetch(ip: string) {
	return async (input: string | URL | Request, init?: RequestInit) => {
		const req = new Request(input, init);
		req.headers.set("x-forwarded-for", ip);
		return app.fetch(req);
	};
}

interface McpClient {
	listTools(): Promise<{ tools: Array<Record<string, unknown>> }>;
	callTool(params: {
		name: string;
		arguments?: Record<string, unknown>;
	}): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

const clientFactories: Array<[string, () => Promise<McpClient>]> = [
	[
		"v2 client, 2026-07-28 protocol",
		async () => {
			const client = new ClientV2(
				{ name: "test", version: "1.0.0" },
				{ versionNegotiation: { mode: "auto" } },
			);
			await client.connect(
				new TransportV2(MCP_URL, { fetch: appFetch(nextIp()) }),
			);
			return client as unknown as McpClient;
		},
	],
	[
		"v2 client, legacy 2025 protocol",
		async () => {
			const client = new ClientV2({ name: "test", version: "1.0.0" });
			await client.connect(
				new TransportV2(MCP_URL, { fetch: appFetch(nextIp()) }),
			);
			return client as unknown as McpClient;
		},
	],
	[
		"v1 SDK client",
		async () => {
			const client = new ClientV1({ name: "test", version: "1.0.0" });
			await client.connect(
				new TransportV1(MCP_URL, { fetch: appFetch(nextIp()) }),
			);
			return client as unknown as McpClient;
		},
	],
];

beforeAll(() => {
	vi.stubGlobal("fetch", registryFetch);
});
afterAll(() => {
	vi.unstubAllGlobals();
});
beforeEach(() => {
	resetState();
});

describe.each(clientFactories)("MCP over %s", (_label, connect) => {
	let client: McpClient;

	beforeEach(async () => {
		client = await connect();
	});
	afterEach(async () => {
		await client.close();
	});

	it("lists the read-only tools with input and output schemas", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"analyze_dependencies",
			"get_package_info",
		]);
		const analyze = tools.find((t) => t.name === "analyze_dependencies");
		expect(analyze?.inputSchema).toMatchObject({
			properties: { onlyOutdated: { type: "boolean" } },
			required: ["content"],
		});
		for (const tool of tools) {
			expect(tool.inputSchema).toMatchObject({ type: "object" });
			expect(tool.outputSchema).toMatchObject({ type: "object" });
			expect(tool.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: true,
			});
		}
	});

	it("analyze_dependencies returns the same data as the REST endpoint", async () => {
		const content = JSON.stringify({
			dependencies: { hono: "^4.0.0", react: "~18.2.0" },
			devDependencies: { "@types/node": "24.0.0" },
		});
		const result = await client.callTool({
			name: "analyze_dependencies",
			arguments: { content, fileName: "package.json" },
		});
		expect(result.isError).toBeFalsy();

		const rest = await request("/api/analyze-packages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content, fileName: "package.json" }),
		});
		const restBody = await rest.json();

		expect(result.structuredContent).toEqual(restBody);
		const [text] = result.content as Array<{ type: string; text: string }>;
		expect(JSON.parse(text.text)).toEqual(restBody);
		expect(restBody.summary).toEqual({
			total: 3,
			upToDate: 1,
			outdated: 2,
			errors: 0,
		});
	});

	it("analyze_dependencies with onlyOutdated keeps only packages needing attention", async () => {
		const content = JSON.stringify({
			dependencies: {
				hono: "^4.0.0", // up to date
				react: "~18.2.0", // outdated
				"does-not-exist": "1.0.0", // error
			},
		});
		const result = await client.callTool({
			name: "analyze_dependencies",
			arguments: { content, fileName: "package.json", onlyOutdated: true },
		});
		expect(result.isError).toBeFalsy();
		const output = result.structuredContent as {
			packages: Array<{ name: string; status: string }>;
			summary: Record<string, number>;
		};
		expect(output.packages.map((p) => [p.name, p.status])).toEqual([
			["react", "outdated"],
			["does-not-exist", "error"],
		]);
		// The summary still describes the whole manifest.
		expect(output.summary).toEqual({
			total: 3,
			upToDate: 1,
			outdated: 1,
			errors: 1,
		});
		const [text] = result.content as Array<{ text: string }>;
		expect(JSON.parse(text.text)).toEqual(output);
	});

	it("analyze_dependencies returns every package when onlyOutdated is false", async () => {
		const result = await client.callTool({
			name: "analyze_dependencies",
			arguments: {
				content: JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
				onlyOutdated: false,
			},
		});
		const output = result.structuredContent as { packages: unknown[] };
		expect(output.packages).toHaveLength(1);
	});

	it("analyze_dependencies reports parse errors as tool errors", async () => {
		const result = await client.callTool({
			name: "analyze_dependencies",
			arguments: { content: "not a manifest {", fileName: "package.json" },
		});
		expect(result.isError).toBe(true);
		const [text] = result.content as Array<{ text: string }>;
		expect(text.text).toMatch(/^Failed to parse file content: /);
	});

	it("analyze_dependencies rejects a disallowed file extension", async () => {
		const result = await client.callTool({
			name: "analyze_dependencies",
			arguments: { content: "{}", fileName: "deps.exe" },
		});
		expect(result.isError).toBe(true);
	});

	it("get_package_info compares against currentVersion", async () => {
		const result = await client.callTool({
			name: "get_package_info",
			arguments: { registry: "npm", name: "react", currentVersion: "17.0.2" },
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			name: "react",
			registry: "npm",
			latestVersion: "19.3.0",
			currentVersion: "17.0.2",
			status: "outdated",
			registryUrl: "https://www.npmjs.com/package/react",
			versionDiff: { majorsBehind: 2, urgency: "high" },
		});
	});

	it("get_package_info accepts registry aliases", async () => {
		const result = await client.callTool({
			name: "get_package_info",
			arguments: { registry: "pypi", name: "requests" },
		});
		expect(result.structuredContent).toMatchObject({
			name: "requests",
			registry: "pip",
			latestVersion: "2.33.0",
		});
	});

	it("get_package_info reports unknown packages as tool errors", async () => {
		const result = await client.callTool({
			name: "get_package_info",
			arguments: { registry: "npm", name: "does-not-exist" },
		});
		expect(result.isError).toBe(true);
		const [text] = result.content as Array<{ text: string }>;
		expect(text.text).toBe("Package not found: does-not-exist on npm");
	});

	it("get_package_info rejects invalid names", async () => {
		const result = await client.callTool({
			name: "get_package_info",
			arguments: { registry: "pub", name: "Bad-Name" },
		});
		expect(result.isError).toBe(true);
		const [text] = result.content as Array<{ text: string }>;
		expect(text.text).toBe("Invalid package name format for pub");
	});
});

describe("MCP HTTP endpoint", () => {
	it("answers GET (2025 SSE stream) with 405 since it is stateless", async () => {
		const res = await request("/api/mcp", {
			headers: { Accept: "text/event-stream" },
		});
		expect(res.status).toBe(405);
	});

	it("uses its own rate limit budget, separate from the REST API", async () => {
		const ip = "203.0.113.50";
		for (let i = 0; i < 30; i++) {
			expect((await request("/api/health", { ip })).status).toBe(200);
		}
		expect((await request("/api/health", { ip })).status).toBe(429);

		// The REST budget is exhausted, but /mcp still answers.
		const res = await request("/api/mcp", {
			ip,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "curl", version: "1" },
				},
			}),
		});
		expect(res.status).toBe(200);
		// 2025-era stateless responses are a single-event SSE stream.
		const text = await res.text();
		const data = text
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice("data: ".length);
		expect(JSON.parse(data ?? "null").result.serverInfo).toMatchObject({
			name: "depman",
		});
	});
});
