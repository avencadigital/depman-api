import { vi } from "vitest";
import { app } from "@/lib/app";
import { CacheService } from "@/lib/cache-service";
import {
	failingPackages,
	npmResponses,
	pubResponses,
	pypiResponses,
} from "./fixtures/registry";

const REGISTRY_ROUTES: Array<{
	prefix: string;
	suffix: string;
	responses: Record<string, unknown>;
}> = [
	{
		prefix: "https://registry.npmjs.org/",
		suffix: "",
		responses: npmResponses,
	},
	{
		prefix: "https://pypi.org/pypi/",
		suffix: "/json",
		responses: pypiResponses,
	},
	{
		prefix: "https://pub.dev/api/packages/",
		suffix: "",
		responses: pubResponses,
	},
];

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export const registryFetch = vi.fn(async (input: string | URL | Request) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	for (const route of REGISTRY_ROUTES) {
		if (!url.startsWith(route.prefix)) continue;
		const encoded = url.slice(
			route.prefix.length,
			url.length - route.suffix.length,
		);
		const name = encoded.split("/").map(decodeURIComponent).join("/");
		const failure = failingPackages[name];
		if (failure) return jsonResponse({ error: "upstream failure" }, failure);
		const body = route.responses[name];
		return body
			? jsonResponse(body)
			: jsonResponse({ error: "Not found" }, 404);
	}
	throw new Error(`Unexpected fetch in test: ${url}`);
});

export function resetState(): void {
	CacheService.getInstance().clear();
	registryFetch.mockClear();
}

// Each call gets its own client IP so the per-IP rate limiter (30 req/min)
// never interferes, unless a test passes an explicit IP.
let ipCounter = 0;
export function nextIp(): string {
	ipCounter++;
	return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function request(
	path: string,
	init: RequestInit & { ip?: string } = {},
): Promise<Response> {
	const { ip, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (!headers.has("x-forwarded-for")) {
		headers.set("x-forwarded-for", ip ?? nextIp());
	}
	return Promise.resolve(
		app.request(`http://localhost${path}`, { ...rest, headers }),
	);
}

export function postAnalyze(
	body: string,
	contentType: string | null = "application/json",
): Promise<Response> {
	const headers: Record<string, string> = {};
	if (contentType !== null) headers["Content-Type"] = contentType;
	return request("/api/analyze-packages", { method: "POST", body, headers });
}

export function registryUrlsFetched(): string[] {
	return registryFetch.mock.calls.map(([input]) => String(input));
}
