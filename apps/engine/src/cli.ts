// Engine CLI (ARCHITECTURE §9.1): `--appdir`, `--port`, `--host`; graceful SIGTERM (S04:ENG-004);
// reports readiness to a forking parent (Electron utilityProcess or child_process.fork).
import { ENV, readFlag, resolveAppdir, resolvePort } from '@jasper/config';
import { startEngine } from './index.ts';
import { insideElectron } from './tools/node-runtime.ts';
import { coreServices } from './tools/services.ts';

type ParentPort = { postMessage(msg: { type: 'ready'; port: number }): void };

async function main(): Promise<void> {
	// Inside the desktop app (an Electron utility process) `process.execPath` is the application binary. The
	// engine's worker programs (speech, roto, camera tracking, jasper-proc, the bundle schema runner) are started
	// with it unless a Node runtime is shipped (tools/node-runtime.ts), and it runs a script only as "run as Node":
	// without this their processes start as a second application instance and the jobs fail.
	if (insideElectron()) process.env.ELECTRON_RUN_AS_NODE = '1';
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
	// The secrets are in the engine's memory now. Child processes (FFmpeg, Remotion and the bundle code it runs,
	// workers) inherit the environment: they get neither (security review AGT-2).
	delete process.env[ENV.EDITOR_KEY];
	delete process.env[ENV.LOCAL_TOKEN];
	console.log(`[engine] JasperEditor engine listening on ${engine.url} (appdir ${appdir})`);
	// Printed for a person at a terminal only: a parent that pipes our output (jasper-mcp --start-engine, a test
	// harness) is not the editor and must not learn the editor key.
	if (engine.pairingUrl && process.stdout.isTTY)
		console.log(`[engine] open the editor in a browser with ${engine.pairingUrl}`);
	// D-13: say which FFmpeg is in use, and warn loudly when Remotion is not on the LGPL build.
	const caps = await coreServices(engine.app).capabilities.get();
	console.log(
		`[engine] ffmpeg ${caps.media.ffmpegVersion ?? 'not found'} (${caps.media.ffmpegSource ?? 'unknown'}, ${caps.media.encoding?.license ?? 'unknown'} build)`,
	);
	const remotion = caps.render.remotionBinaries;
	if (remotion?.message) console.warn(`[engine] WARNING: ${remotion.message}`);
	else if (remotion) console.log(`[engine] Remotion uses the LGPL FFmpeg directory (${remotion.source})`);
	// The render browser's WebGL: in software (SwiftShader) a graphics bake takes hours, so say which it is.
	if (caps.render.remotionLocal === 'ready' && process.env.JASPER_WEBGL_PROBE !== '0')
		void coreServices(engine.app)
			.remotion.probeWebgl()
			.then((s) => {
				const where = `${s.renderer ?? 'unknown renderer'}, gl=${s.gl ?? 'default'}`;
				if (s.state === 'ok' && s.hardware) console.log(`[engine] graphics render on the GPU (${where})`);
				else if (s.state === 'ok')
					console.warn(`[engine] WARNING: ${s.message ?? 'graphics render in software'} (${where})`);
				else if (s.state === 'unavailable')
					console.warn(
						`[engine] WARNING: the render browser has no WebGL2${s.message ? `: ${s.message}` : ''}`,
					);
			})
			.catch(() => undefined);
	const ready = { type: 'ready', port: engine.port } as const;
	(process as NodeJS.Process & { parentPort?: ParentPort }).parentPort?.postMessage(ready);
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
