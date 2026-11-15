// Engine CLI (ARCHITECTURE §9.1): `--appdir`, `--port`, `--host`. Deliberately small: it marks the runtime file
// `starting` (runtime-file.ts) before the engine bundle is evaluated — seconds on a loaded machine — so a local tool
// started at the same time waits for this engine instead of reporting that none runs; then it loads serve.ts.
import { mkdirSync } from 'node:fs';
import { appdirPaths, ENV, readFlag, resolveAppdir, resolvePort } from '@jasper/config';
import { type RuntimeFile, startRuntimeFile } from './runtime-file.ts';
import { ENGINE_VERSION } from './version.ts';

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const appdir = resolveAppdir({ argv, env: process.env, defaultDir: process.env[ENV.APPDIR] });
	const port = resolvePort({ argv, env: process.env });
	const host = readFlag(argv, 'host') ?? process.env[ENV.HOST] ?? '127.0.0.1';
	const paths = appdirPaths(appdir);
	let runtime: RuntimeFile | null = null;
	try {
		mkdirSync(paths.engineDir, { recursive: true });
		runtime = await startRuntimeFile(paths.runtimeFile, { host, port, version: ENGINE_VERSION, appdir });
		const { serve } = await import('./serve.ts');
		await serve({ appdir, port, host, runtime });
	} catch (e) {
		await runtime?.remove();
		throw e;
	}
}

main().catch((e) => {
	console.error('[engine] failed to start:', e);
	process.exit(1);
});
