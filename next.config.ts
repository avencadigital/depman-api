import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	poweredByHeader: false,
	output: "standalone",
	turbopack: {
		root: path.resolve(__dirname),
	},
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "X-Frame-Options", value: "DENY" },
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
					{
						key: "Strict-Transport-Security",
						value: "max-age=63072000; includeSubDomains",
					},
				],
			},
		];
	},
};

export default nextConfig;
