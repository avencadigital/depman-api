"use client";

export default function ErrorPage({
	reset,
}: {
	error: globalThis.Error & { digest?: string };
	reset: () => void;
}) {
	return (
		<main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
			<h1>Something went wrong</h1>
			<p>An unexpected error occurred.</p>
			<button
				type="button"
				onClick={reset}
				style={{
					marginTop: "1rem",
					padding: "0.5rem 1rem",
					cursor: "pointer",
				}}
			>
				Try again
			</button>
		</main>
	);
}
