// Engine CLI (ARCHITECTURE §9.1): `--appdir`, `--port`, `--host`; graceful SIGTERM (S04:ENG-004);
// reports readiness to a forking parent (Electron utilityProcess or child_process.fork).
import { ENV, readFlag, resolveAppdir, resolvePort } from '@jasper/config';
import { startEngine } from './index.ts';

type ParentPort = { postMessage(msg: unknown): void };

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const appdir = resolveAppdir({ argv, env: process.env, defaultDir: process.env[ENV.APPDIR] });
	const port = resolvePort({ argv, env: process.env });
	const host = readFlag(argv, 'host') ?? process.env[ENV.HOST] ?? '127.0.0.1';
	if (host !== '127.0.0.1' && host !== 'localhost') {
		console.warn(
			`[engine] binding ${host}: remote mode is M2; the Host check still only accepts loopback names`,
		);
	}
	const engine = await startEngine({ appdir, port, host, logger: false });
	console.log(`[engine] JasperEditor engine listening on ${engine.url} (appdir ${appdir})`);
	const ready = { type: 'ready', port: engine.port };
	(process as unknown as { parentPort?: ParentPort }).parentPort?.postMessage(ready);
	process.send?.(ready);

	let stopping = false;
	const shutdown = (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(`[engine] ${signal}: shutting down`);
		const force = setTimeout(() => process.exit(1), 5000);
		force.unref();
		void engine.stop().then(() => process.exit(0));
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('disconnect', () => shutdown('parent disconnected'));
}

main().catch((e) => {
	console.error('[engine] failed to start:', e);
	process.exit(1);
});
