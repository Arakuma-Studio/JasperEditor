// Headless Chrome for WebGL2 / page-level tests: find a Chrome, launch it on ANGLE/SwiftShader (deterministic
// software GL without a GPU), and bundle a test entry with esbuild (packages/compositions/test/gl-browser.ts loads it).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Chrome used by the GL tests: `JASPER_BROWSER_EXECUTABLE`, else the usual system paths; null when none. */
export function findChrome(): string | null {
	return (
		[
			process.env.JASPER_BROWSER_EXECUTABLE,
			'/usr/bin/google-chrome',
			'/usr/bin/google-chrome-stable',
			'/usr/bin/chromium',
			'/usr/bin/chromium-browser',
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		].find((p): p is string => !!p && existsSync(p)) ?? null
	);
}

/** Chrome flags of every GL test: SwiftShader through ANGLE even where a GPU exists (same pixels everywhere). */
export const SWIFTSHADER_ARGS = [
	'--use-angle=swiftshader',
	'--enable-unsafe-swiftshader',
	'--ignore-gpu-blocklist',
];

type Esbuild = {
	build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

/** Bundles a browser entry (TypeScript/TSX) into one IIFE script with esbuild (the one that comes with tsx). */
export async function bundleForBrowser(entry: string, define: Record<string, string> = {}): Promise<string> {
	const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
	const esbuild = req('esbuild') as Esbuild;
	const out = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"', ...define },
		logLevel: 'silent',
	});
	return out.outputFiles[0]!.text;
}
