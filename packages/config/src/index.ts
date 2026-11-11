import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

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
	/**
	 * The editor key (security review AGT-2): what proves a request or a `/agent` connection comes from the editor
	 * window and not from an agent, the MCP server or the CLI, which only ever hold the token. The desktop shell
	 * and the E2E harness pass it to the engine they start; an engine started without it makes its own.
	 */
	EDITOR_KEY: 'JASPER_EDITOR_KEY',
	/** `1` = listen without a token (any local process is the user). Loud warning; never set by the application. */
	INSECURE_DEV: 'JASPER_INSECURE_DEV',
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
	/** jasper-mcp / jasper: seconds to wait for a starting engine (`--startup-timeout`). */
	ENGINE_STARTUP_TIMEOUT: 'JASPER_ENGINE_STARTUP_TIMEOUT',
	/** Engine / desktop: path of the jasper-mcp bundle shown in Help ▸ Connect an AI Agent… (default: found next to the engine). */
	MCP_ENTRY: 'JASPER_MCP_ENTRY',
} as const;
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

/** An id used as one path segment was not one (security review ENG-4): answered as HTTP 400 by the engine. */
export class AppdirPathError extends Error {
	readonly statusCode = 400;
	readonly code = 'VALIDATION_FAILED';
	constructor(what: string) {
		super(`Invalid ${what}`);
		this.name = 'AppdirPathError';
	}
}

/**
 * Ids become directory names under the appdir. A caller that forgot to validate one (a project id taken from a URL
 * parameter or a request body) must not turn `../..` into a path outside the appdir, so the layout itself refuses
 * anything that is not a single path segment.
 */
function segment(id: string, what: string): string {
	if (
		typeof id !== 'string' ||
		id === '' ||
		id === '.' ||
		id === '..' ||
		id.includes('/') ||
		id.includes('\\') ||
		id.includes('\0')
	)
		throw new AppdirPathError(what);
	return id;
}

/** Appdir layout (ARCHITECTURE §4.3). All paths are absolute when `appdir` is. */
export function appdirPaths(appdir: string) {
	const engineDir = join(appdir, 'engine');
	return {
		root: appdir,
		engineDir,
		engineConfig: join(engineDir, 'engine.json'),
		/** social-comment §7.8: network-use preferences (Settings ▸ Privacy & Network). */
		networkSettings: join(engineDir, 'network.json'),
		/** Written by a running engine (0600): origin, port, pid and token for local tools (jasper-mcp). */
		runtimeFile: join(engineDir, 'runtime.json'),
		/**
		 * Dev engines only (`JASPER_DEV=1`, 0600): the editor key the Vite dev server hands to the browser as an
		 * HttpOnly cookie. Never written by a packaged or headless engine, never read by jasper-mcp.
		 */
		devEditorKeyFile: join(engineDir, 'editor-key.dev'),
		mediaIndex: join(engineDir, 'media-index.json'),
		jobsJournal: join(engineDir, 'jobs.jsonl'),
		logsDir: join(engineDir, 'logs'),
		logFile: (date: Date) => join(engineDir, 'logs', `${date.toISOString().slice(0, 10)}.log`),
		projectsDir: join(appdir, 'projects'),
		projectDir: (projectId: string) => join(appdir, 'projects', segment(projectId, 'project id')),
		projectFile: (projectId: string) =>
			join(appdir, 'projects', segment(projectId, 'project id'), 'project.jasper'),
		projectViewFile: (projectId: string) =>
			join(appdir, 'projects', segment(projectId, 'project id'), 'project.jasper-view'),
		projectVersionsDir: (projectId: string) =>
			join(appdir, 'projects', segment(projectId, 'project id'), 'versions'),
		mediaDir: join(appdir, 'media'),
		mediaFile: (mediaKey: string, originalName: string) =>
			join(appdir, 'media', segment(mediaKey, 'media key'), segment(originalName, 'file name')),
		cacheDir: join(appdir, 'cache'),
		derivativeFile: (fingerprintHex: string, kind: string, paramsHash: string, ext: string) =>
			join(
				appdir,
				'cache',
				segment(fingerprintHex, 'fingerprint'),
				segment(`${kind}-${paramsHash}.${ext}`, 'derivative'),
			),
		mgDir: join(appdir, 'mg'),
		mgRenderDir: (renderKey: string) => join(appdir, 'mg', segment(renderKey, 'render key')),
		rendersDir: join(appdir, 'renders'),
		renderDir: (jobId: string) => join(appdir, 'renders', segment(jobId, 'job id')),
		remotionBundleDir: join(appdir, 'remotion', 'bundle'),
		/** User libraries shared by every project and by agents (S03:FX-030 effect presets). */
		presetsDir: join(appdir, 'presets'),
		effectPresetsFile: join(appdir, 'presets', 'effect-presets.json'),
		/** Spec 19 TL-054: the user look library. */
		titleLooksFile: join(appdir, 'presets', 'title-looks.json'),
		/** spec 13 AS-020: the user subtitle template library. */
		subtitleTemplatesFile: join(appdir, 'presets', 'subtitle-templates.json'),
		/** Spec 14 TC-030: the user's transcript cleanup presets. */
		cleanupPresetsFile: join(appdir, 'presets', 'cleanup-presets.json'),
		/** Spec 17 SC-070: the user's personal speech glossary (misrecognised spelling → right spelling). */
		speechGlossaryFile: join(appdir, 'speech', 'glossary.json'),
		/** Spec 15 EA-010: the user's style recipes (`index.json` + one `<id>.json` per recipe). */
		styleRecipesDir: join(appdir, 'style-recipes'),
		/** wp fonts: the user font library (`library.json` + `files/<fontId>.<ext>`), shared by every project. */
		fontsDir: join(appdir, 'fonts'),
		/** Sound library (spec 12 §2.1), shared by every project. */
		soundsDir: join(appdir, 'sounds'),
		/** The library index `{version, snapshotHash, roots, packs, sounds, files}` (atomic writes). */
		soundLibraryIndex: join(appdir, 'sounds', 'library.json'),
		/** User folders indexed in place, each with its licence declaration (local mode only). */
		soundRootsFile: join(appdir, 'sounds', 'roots.json'),
		/** Installed sound packs: `packs/<packId>/` with its `pack.json`. */
		soundPacksDir: join(appdir, 'sounds', 'packs'),
		/** Jasper Synth renders (a cache: re-rendered on demand). */
		soundSynthDir: join(appdir, 'sounds', 'synth'),
		/** Visual data of library sounds: `cache/<fingerprintHex>/visual-v<n>.json`. */
		soundCacheDir: join(appdir, 'sounds', 'cache'),
		/** Sound-design proposals of a project (spec 12 §2.5; not part of the document). */
		projectProposalsDir: (projectId: string) =>
			join(appdir, 'projects', segment(projectId, 'project id'), 'proposals'),
		tmpDir: join(appdir, 'tmp'),
		/** social-comment §7.8: downloaded platform fonts and emoji images (verified, atomic writes). */
		remoteAssetsDir: join(appdir, 'assets', 'remote'),
		/** The user's remote-asset manifest override (same schema as the shipped manifest; entries replace by id). */
		remoteManifestOverride: join(appdir, 'assets', 'remote-manifest.override.json'),
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

const listeningPortSchema = z.number().int().min(1).max(65535);

export const EngineReadyMessageSchema = z.object({
	type: z.literal('ready'),
	port: listeningPortSchema,
});

const pidSchema = z
	.number()
	.int()
	.positive()
	.max(2 ** 31 - 1);
const epochMsSchema = z.number().finite().nonnegative();

/**
 * How often a starting engine rewrites `heartbeatAt` in its runtime file, and how old the heartbeat of a live
 * process may be before local tools stop waiting for it (a hung start). Generous: synchronous startup work
 * (cache repair on a large appdir) can hold the event loop for seconds.
 */
export const ENGINE_HEARTBEAT_INTERVAL_MS = 1000;
export const ENGINE_HEARTBEAT_STALE_MS = 20_000;
/**
 * An engine that wrote `ready` this recently but does not answer `/health` yet is still warming up (its
 * first requests queue behind startup work): local tools wait for it like for a starting one.
 */
export const ENGINE_WARMUP_MS = 30_000;

/**
 * A listening engine. Files without `state` were written by engines older than the startup lifecycle and
 * read as ready.
 */
const engineRuntimeReadySchema = z.object({
	state: z.literal('ready').default('ready'),
	url: z.url({ protocol: /^https?$/ }),
	host: z.string().default(DEFAULT_ENGINE_HOST),
	port: listeningPortSchema,
	pid: pidSchema,
	token: z.string().nullable().default(null),
	version: z.string().default('unknown'),
	appdir: z.string().default(''),
	startedAt: z.string().default(''),
	/** Epoch ms when it started answering (absent in older files). */
	readyAt: epochMsSchema.optional(),
});

/**
 * An engine that has not started listening yet: no address or token. `heartbeatAt` (epoch ms) is rewritten
 * every ENGINE_HEARTBEAT_INTERVAL_MS while it starts; `port` is set when a fixed port was requested.
 * Older tools fail to parse this shape (no `url`) and ignore it, as they ignore a missing file.
 */
const engineRuntimeStartingSchema = z.object({
	state: z.literal('starting'),
	pid: pidSchema,
	host: z.string().default(DEFAULT_ENGINE_HOST),
	port: listeningPortSchema.optional(),
	version: z.string().default('unknown'),
	appdir: z.string().default(''),
	startedAt: z.string().default(''),
	heartbeatAt: epochMsSchema,
});

const engineRuntimeStateSchema = z.union([engineRuntimeStartingSchema, engineRuntimeReadySchema]);

export type EngineRuntimeInfo = z.infer<typeof engineRuntimeReadySchema>;
export type EngineRuntimeStarting = z.infer<typeof engineRuntimeStartingSchema>;
export type EngineRuntimeState = EngineRuntimeInfo | EngineRuntimeStarting;

/** Parses a runtime file's JSON: a ready (or legacy) engine, else null (malformed or still starting). */
export function parseEngineRuntime(raw: unknown): EngineRuntimeInfo | null {
	const state = parseEngineRuntimeState(raw);
	return state?.state === 'ready' ? state : null;
}

/** Parses a runtime file's JSON in either lifecycle state (null when malformed). */
export function parseEngineRuntimeState(raw: unknown): EngineRuntimeState | null {
	const result = engineRuntimeStateSchema.safeParse(raw);
	return result.success ? result.data : null;
}

/**
 * File types "Edit Original" may hand to the operating system's opener (security review ELE-2 / ENG-5): media,
 * pictures, vector and caption documents, timeline documents, models, LUTs. An allowlist, not a list of known
 * program types: the OS opener runs whatever a file type is associated with (`.hta`, `.pif`, `.cpl`, `.reg`,
 * `.scpt`, `.workflow`, `.inetloc`, `.py`… and, on macOS, any extensionless Unix executable in Terminal), media
 * probing is by content (a picture/script polyglot registers as media), and the desktop bridge is called by the
 * renderer with a path. Everything else is shown in the file browser instead.
 */
export const OPENABLE_EXTENSIONS: readonly string[] = [
	'mp4',
	'mov',
	'm4v',
	'mkv',
	'webm',
	'avi',
	'mxf',
	'mts',
	'm2ts',
	'ts',
	'mpg',
	'mpeg',
	'wmv',
	'flv',
	'3gp',
	'ogv',
	'mp3',
	'wav',
	'aac',
	'm4a',
	'flac',
	'ogg',
	'opus',
	'aif',
	'aiff',
	'wma',
	'ac3',
	'caf',
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'tif',
	'tiff',
	'bmp',
	'avif',
	'heic',
	'heif',
	'tga',
	'exr',
	'dpx',
	'psd',
	'psb',
	'svg',
	'pdf',
	'ai',
	'eps',
	'srt',
	'vtt',
	'scc',
	'mcc',
	'stl',
	'ttml',
	'dfxp',
	'xml',
	'fcpxml',
	'otio',
	'edl',
	'aaf',
	'omf',
	'ale',
	'glb',
	'gltf',
	'obj',
	'json',
	'lottie',
	'cube',
	'3dl',
	'ocio',
];

/** Whether the OS opener may be asked to open `path` (by extension; extensionless files never). */
export function isOpenableFile(path: string): boolean {
	const m = /\.([A-Za-z0-9]+)$/.exec(path);
	return !!m && OPENABLE_EXTENSIONS.includes(m[1]!.toLowerCase());
}
