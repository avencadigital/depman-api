// Trimmed registry responses, shaped like the real npm / PyPI / pub.dev JSON
// APIs. Only the fields read by the mappers in lib/package-services.ts are
// kept, so tests stay deterministic and offline.

export const npmResponses: Record<string, unknown> = {
	hono: {
		name: "hono",
		description: "Web framework built on Web Standards",
		"dist-tags": { latest: "4.13.7" },
		versions: { "4.13.7": {} },
		time: { "4.13.7": "2026-09-01T10:00:00.000Z", modified: "2026-09-02" },
		homepage: "https://hono.dev",
		license: "MIT",
		repository: { type: "git", url: "git+https://github.com/honojs/hono.git" },
		keywords: ["hono", "web", "app", "http", "framework"],
	},
	react: {
		name: "react",
		description: "React is a JavaScript library for building user interfaces.",
		"dist-tags": { latest: "19.3.0" },
		versions: { "19.3.0": {} },
		time: { "19.3.0": "2026-08-10T12:00:00.000Z" },
		license: "MIT",
		repository: {
			type: "git",
			url: "git+https://github.com/facebook/react.git",
		},
	},
	"@types/node": {
		name: "@types/node",
		description: "TypeScript definitions for node",
		"dist-tags": { latest: "26.2.0" },
		versions: { "26.2.0": {} },
		time: { "26.2.0": "2026-09-20T08:00:00.000Z" },
		license: "MIT",
	},
	request: {
		name: "request",
		description: "Simplified HTTP request client.",
		"dist-tags": { latest: "2.88.2" },
		versions: {
			"2.88.2": { deprecated: "request has been deprecated" },
		},
		time: { "2.88.2": "2020-02-11T16:00:00.000Z" },
		license: "Apache-2.0",
		repository: "https://github.com/request/request.git",
	},
};

export const pypiResponses: Record<string, unknown> = {
	requests: {
		info: {
			version: "2.33.0",
			summary: "Python HTTP for Humans.",
			home_page: "",
			license: "Apache-2.0",
			keywords: "http, requests, client",
			project_urls: {
				Homepage: "https://requests.readthedocs.io",
				Source: "https://github.com/psf/requests",
			},
		},
		releases: {
			"2.33.0": [{ upload_time_iso_8601: "2026-06-01T00:00:00.000000Z" }],
		},
	},
	flask: {
		info: {
			version: "3.2.0",
			summary: "A simple framework for building complex web applications.",
			license: "BSD-3-Clause",
			project_urls: { Source: "https://github.com/pallets/flask" },
		},
		releases: { "3.2.0": [{ upload_time: "2026-05-01T00:00:00" }] },
	},
};

export const pubResponses: Record<string, unknown> = {
	provider: {
		name: "provider",
		latest: {
			version: "6.1.5",
			published: "2026-04-01T00:00:00.000Z",
			pubspec: {
				description: "A wrapper around InheritedWidget.",
				repository: "https://github.com/rrousselGit/provider",
				topics: ["state-management"],
			},
		},
	},
	http: {
		name: "http",
		latest: {
			version: "1.5.0",
			published: "2026-03-01T00:00:00.000Z",
			pubspec: {
				description: "A composable, multi-platform, Future-based API.",
				homepage: "https://pub.dev/packages/http",
			},
		},
	},
};

// Names that make the mock registry answer with a non-404 failure status.
export const failingPackages: Record<string, number> = {
	"broken-pkg": 503,
};
