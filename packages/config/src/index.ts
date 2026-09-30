// @jasper/config — appdir layout, env names and ports shared by the engine and the desktop shell.
// Node only (ARCHITECTURE §3.1, §4.3).
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_ENGINE_PORT = 47900;
export const DEV_WEB_PORT = 5173;
export const DEFAULT_ENGINE_HOST = '127.0.0.1';

/** Environment variable names understood by the engine and the desktop shell (ARCHITECTURE §4.3). */
export const ENV = {
	APPDIR: 'JASPER_APPDIR',
	PORT: 'JASPER_PORT',
	HOST: 'JASPER_HOST',
	DEV: 'JASPER_DEV',
	LOCAL_TOKEN: 'JASPER_LOCAL_TOKEN',
	WEB_DIR: 'JASPER_WEB_DIR',
	FFMPEG: 'JASPER_FFMPEG',
	FFPROBE: 'JASPER_FFPROBE',
	MG: 'JASPER_MG',
	REMOTION_LICENSE_KEY: 'JASPER_REMOTION_LICENSE_KEY',
	BROWSER_EXECUTABLE: 'JASPER_BROWSER_EXECUTABLE',
	DESKTOP_DEV_URL: 'JASPER_DESKTOP_DEV_URL',
	/** Dev only: the Vite port whose Host/Origin the dev engine accepts (default DEV_WEB_PORT). */
	DEV_WEB_PORT: 'JASPER_DEV_WEB_PORT',
	/** jasper-mcp: engine origin override (skips discovery). */
	ENGINE_URL: 'JASPER_ENGINE_URL',
	/** jasper-mcp: engine token override (Bearer). */
	ENGINE_TOKEN: 'JASPER_ENGINE_TOKEN',
	/** jasper-mcp: path of the engine bundle to auto-start (`--start-engine`). */
	ENGINE_ENTRY: 'JASPER_ENGINE_ENTRY',
	/** Engine / desktop: path of the jasper-mcp bundle shown in Help ▸ Connect an AI Agent… (default: found next to the engine). */
	MCP_ENTRY: 'JASPER_MCP_ENTRY',
} as const;
export type EnvName = (typeof ENV)[keyof typeof ENV];

export type Env = Record<string, string | undefined>;

/** Platform default appdir when neither --appdir nor JASPER_APPDIR is given. */
export function platformDefaultAppdir(
	env: Env = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'linux' && env.USER === 'jasper') return '/var/lib/jasper';
	if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jasper');
	if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jasper');
	return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jasper');
}

/** Reads `--name value` or `--name=value` from an argv array. */
export function readFlag(argv: readonly string[], name: string): string | undefined {
	const flag = `--${name}`;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === flag) return argv[i + 1];
		if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
	}
	return undefined;
}

/**
 * Resolves the appdir: `--appdir` flag, then `JASPER_APPDIR`, then `defaultDir`, then the platform
 * default (S04:ENG-010). Relative paths resolve against `cwd`.
 */
export function resolveAppdir(opts: {
	argv?: readonly string[];
	env?: Env;
	defaultDir?: string;
	cwd?: string;
}): string {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();
	const raw = readFlag(opts.argv ?? [], 'appdir') ?? env[ENV.APPDIR] ?? opts.defaultDir;
	if (raw && raw.length > 0) return isAbsolute(raw) ? raw : resolve(cwd, raw);
	return platformDefaultAppdir(env);
}

/** Resolves the listen port: `--port`, then `JASPER_PORT`, then DEFAULT_ENGINE_PORT. 0 = random. */
export function resolvePort(opts: { argv?: readonly string[]; env?: Env }): number {
	const raw = readFlag(opts.argv ?? [], 'port') ?? (opts.env ?? process.env)[ENV.PORT];
	if (raw === undefined || raw === '') return DEFAULT_ENGINE_PORT;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid port: ${raw}`);
	return n;
}

export function isTruthyEnv(v: string | undefined): boolean {
	return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** Appdir layout (ARCHITECTURE §4.3). All paths are absolute when `appdir` is. */
export function appdirPaths(appdir: string) {
	const engineDir = join(appdir, 'engine');
	return {
		root: appdir,
		engineDir,
		engineConfig: join(engineDir, 'engine.json'),
		/** Written by a running engine (0600): origin, port, pid and token for local tools (jasper-mcp). */
		runtimeFile: join(engineDir, 'runtime.json'),
		mediaIndex: join(engineDir, 'media-index.json'),
		jobsJournal: join(engineDir, 'jobs.jsonl'),
		logsDir: join(engineDir, 'logs'),
		logFile: (date: Date) => join(engineDir, 'logs', `${date.toISOString().slice(0, 10)}.log`),
		projectsDir: join(appdir, 'projects'),
		projectDir: (projectId: string) => join(appdir, 'projects', projectId),
		projectFile: (projectId: string) => join(appdir, 'projects', projectId, 'project.jasper'),
		projectViewFile: (projectId: string) => join(appdir, 'projects', projectId, 'project.jasper-view'),
		projectVersionsDir: (projectId: string) => join(appdir, 'projects', projectId, 'versions'),
		mediaDir: join(appdir, 'media'),
		mediaFile: (mediaKey: string, originalName: string) => join(appdir, 'media', mediaKey, originalName),
		cacheDir: join(appdir, 'cache'),
		derivativeFile: (fingerprintHex: string, kind: string, paramsHash: string, ext: string) =>
			join(appdir, 'cache', fingerprintHex, `${kind}-${paramsHash}.${ext}`),
		mgDir: join(appdir, 'mg'),
		mgRenderDir: (renderKey: string) => join(appdir, 'mg', renderKey),
		rendersDir: join(appdir, 'renders'),
		renderDir: (jobId: string) => join(appdir, 'renders', jobId),
		remotionBundleDir: join(appdir, 'remotion', 'bundle'),
		tmpDir: join(appdir, 'tmp'),
	};
}
export type AppdirPaths = ReturnType<typeof appdirPaths>;

/** Product name of the Electron app (`app.setName`); Electron's userData directory is named after it. */
export const DESKTOP_PRODUCT_NAME = 'JasperEditor';

/**
 * The appdir the packaged desktop app uses (`<Electron userData>/jasper`, ARCHITECTURE §4.3), computed
 * without Electron so local tools (jasper-mcp) can find the desktop engine's runtime file.
 */
export function desktopAppdir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
	const userData =
		platform === 'win32'
			? join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), DESKTOP_PRODUCT_NAME)
			: platform === 'darwin'
				? join(homedir(), 'Library', 'Application Support', DESKTOP_PRODUCT_NAME)
				: join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), DESKTOP_PRODUCT_NAME);
	return join(userData, 'jasper');
}

/** `<appdir>/engine/runtime.json`: how local tools reach a running engine (written on listen, removed on stop). */
export type EngineRuntimeInfo = {
	/** `http://127.0.0.1:<port>` */
	url: string;
	host: string;
	port: number;
	pid: number;
	/** Bearer token when the engine runs in local token mode (Electron), else null. */
	token: string | null;
	version: string;
	appdir: string;
	startedAt: string;
};

/** Parses a runtime file's JSON (null when malformed). */
export function parseEngineRuntime(raw: unknown): EngineRuntimeInfo | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Partial<EngineRuntimeInfo>;
	if (typeof r.url !== 'string' || typeof r.port !== 'number' || typeof r.pid !== 'number') return null;
	if (r.token !== null && r.token !== undefined && typeof r.token !== 'string') return null;
	return {
		url: r.url,
		host: typeof r.host === 'string' ? r.host : '127.0.0.1',
		port: r.port,
		pid: r.pid,
		token: r.token ?? null,
		version: typeof r.version === 'string' ? r.version : 'unknown',
		appdir: typeof r.appdir === 'string' ? r.appdir : '',
		startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
	};
}
