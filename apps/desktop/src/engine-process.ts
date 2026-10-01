// Forks the bundled engine in an Electron utilityProcess (ARCHITECTURE D-17, §12; R-OMS §8.5): ESM bundle
// apps/engine/dist/engine.mjs with `--port 0`, per-launch JASPER_LOCAL_TOKEN, JASPER_WEB_DIR and
// JASPER_APPDIR. Resolves once the engine posts {type:'ready', port} on its parentPort.
import { utilityProcess } from 'electron';

export type EngineProcess = { origin: string; stop(): Promise<void> };

type StartEngineOptions = {
	entry: string;
	appdir: string;
	webDir: string;
	token: string;
	/**
	 * Packaged builds: `process.resourcesPath`. The engine finds its LGPL FFmpeg + Remotion binaries
	 * directory in `<resourcesDir>/ffmpeg-lgpl` (ARCHITECTURE D-13).
	 */
	resourcesDir?: string | null;
	readyTimeoutMs?: number;
	onLog?(line: string): void;
};

export function startEngineProcess(opts: StartEngineOptions): Promise<EngineProcess> {
	const child = utilityProcess.fork(opts.entry, ['--port', '0', '--appdir', opts.appdir], {
		env: {
			...process.env,
			JASPER_LOCAL_TOKEN: opts.token,
			JASPER_WEB_DIR: opts.webDir,
			JASPER_APPDIR: opts.appdir,
			JASPER_DEV: '',
			...(opts.resourcesDir ? { JASPER_RESOURCES_DIR: opts.resourcesDir } : {}),
		},
		stdio: 'pipe',
		serviceName: 'jasper-engine',
	});
	const log = opts.onLog ?? ((l: string) => console.log(`[engine] ${l}`));
	const pipe = (s: NodeJS.ReadableStream | null) =>
		s?.on('data', (d: Buffer) => {
			for (const line of d.toString('utf8').split('\n')) if (line.trim()) log(line);
		});
	pipe(child.stdout);
	pipe(child.stderr);

	let exited = false;
	const exitedPromise = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	return new Promise<EngineProcess>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`engine did not report ready within ${opts.readyTimeoutMs ?? 30_000} ms`));
		}, opts.readyTimeoutMs ?? 30_000);
		child.on('message', (m: unknown) => {
			const msg = m as { type?: string; port?: number };
			if (msg?.type !== 'ready' || typeof msg.port !== 'number') return;
			clearTimeout(timer);
			const origin = `http://127.0.0.1:${msg.port}`;
			resolve({
				origin,
				stop: async () => {
					if (exited) return;
					child.kill();
					await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 5000))]);
				},
			});
		});
		child.once('exit', (code) => {
			exited = true;
			clearTimeout(timer);
			reject(new Error(`engine exited with code ${code} before it was ready`));
		});
	});
}
