import { existsSync } from 'node:fs';
import { build } from 'esbuild';

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

export async function bundleForBrowser(entry: string): Promise<string> {
	const out = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"' },
		logLevel: 'silent',
	});
	return out.outputFiles[0]!.text;
}
