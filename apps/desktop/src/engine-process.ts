import { DEFAULT_ENGINE_HOST, EngineReadyMessageSchema } from '@jasper/config';
import { utilityProcess } from 'electron';

export type EngineProcess = { origin: string; stop(): Promise<void> };

type StartEngineOptions = {
	entry: string;
	appdir: string;
	webDir: string;
	token: string;
	/**
	 * The editor key (security review AGT-2): what tells the engine that a request or an `/agent` connection comes
	 * from this window and not from an agent holding the token. It goes to the engine's environment and to the
	 * window's cookie jar, never to a file.
	 */
	editorKey: string;
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
			JASPER_EDITOR_KEY: opts.editorKey,
			// A packaged app never runs an unauthenticated engine, whatever the user's shell exports.
			JASPER_INSECURE_DEV: '',
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
		let ready = false;
		const timer = setTimeout(() => {
			child.removeListener('message', onMessage);
			child.kill();
			reject(new Error(`engine did not report ready within ${opts.readyTimeoutMs ?? 30_000} ms`));
		}, opts.readyTimeoutMs ?? 30_000);
		function onMessage(message: unknown): void {
			const result = EngineReadyMessageSchema.safeParse(message);
			if (!result.success) return;
			ready = true;
			child.removeListener('message', onMessage);
			clearTimeout(timer);
			const origin = `http://${DEFAULT_ENGINE_HOST}:${result.data.port}`;
			resolve({
				origin,
				stop: async () => {
					if (exited) return;
					child.kill();
					let timeout: ReturnType<typeof setTimeout> | undefined;
					await Promise.race([
						exitedPromise,
						new Promise<void>((resolve) => {
							timeout = setTimeout(resolve, 5000);
						}),
					]);
					clearTimeout(timeout);
				},
			});
		}
		child.on('message', onMessage);
		child.once('exit', (code) => {
			exited = true;
			clearTimeout(timer);
			child.removeListener('message', onMessage);
			if (ready) return;
			reject(new Error(`engine exited with code ${code} before it was ready`));
		});
	});
}
