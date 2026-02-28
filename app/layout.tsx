import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Dep-Man — Dependency Manager API",
	description:
		"API for analyzing package dependencies across npm, pip, and pub ecosystems.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
