import Link from "next/link";

export default function NotFound() {
	return (
		<main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
			<h1>404 — Not Found</h1>
			<p>The page you are looking for does not exist.</p>
			<Link href="/" style={{ marginTop: "1rem", display: "inline-block" }}>
				Go back home
			</Link>
		</main>
	);
}
