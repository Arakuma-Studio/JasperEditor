// Workstream `gaps` (docs/wp-notes/gaps.md):
//   GET  /api/media/:mediaKey/location   where the media file is on this host (Edit Original)
//   POST /api/media/:mediaKey/open       reveal it in the file browser / open it in its default application
//                                        (local engines only: a remote engine never launches programs for a browser)
//   GET  /api/projects/:projectId/scratch the folders behind Project Settings ▸ Scratch Disks, with free space
//   POST /api/scratch/check              whether a folder can take generated media
//   POST /api/media-jobs                 Create Proxies / ingest copies and transcodes (job `proxy-create`)
//   POST /api/warp-analysis              Warp Stabilizer background analysis (job `warp-analysis`)
//   POST /api/reframe                    Auto Reframe subject analysis (job `reframe`)
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { availableParallelism, freemem, homedir, totalmem } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
	type EngineGapsSettings,
	EngineGapsSettingsSchema,
	MediaJobRequestSchema,
	MediaOpenRequestSchema,
	ProjectManagerRequestSchema,
	ReframeRequestSchema,
	ScratchCheckRequestSchema,
	type ScratchLocation,
	WarpAnalysisRequestSchema,
} from '@jasper/api';
import { isOpenableFile } from '@jasper/config';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { isLoopbackHost } from '../context.ts';
import { MediaJobService } from '../gaps/media-jobs.ts';
import { PROJECT_MEDIA_DIR } from '../gaps/paths.ts';
import { ProjectManagerService } from '../gaps/project-manager.ts';
import { ReframeService } from '../gaps/reframe.ts';
import { renderOptimization, setRenderOptimization } from '../gaps/render-budget.ts';
import { WarpAnalysisService } from '../gaps/warp-analysis.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { isProjectId } from '../projects/store.ts';
import type { RotoService } from '../roto/service.ts';
import { atomicWriteJson, freeDiskBytes } from '../tools/fs.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type K = { Params: { mediaKey: string } };
type P = { Params: { projectId: string } };

/** Exists / writable / free space of a folder (the nearest existing parent for the space of a missing one). */
export async function describeFolder(path: string, expose: boolean): Promise<ScratchLocation> {
	let exists = false;
	let writable = false;
	try {
		exists = (await stat(path)).isDirectory();
		await access(path, constants.W_OK);
		writable = exists;
	} catch {
		// missing or read-only
	}
	let probe = path;
	let free: number | null = null;
	for (let i = 0; i < 64 && free === null; i++) {
		free = await freeDiskBytes(probe);
		const up = dirname(probe);
		if (up === probe) break;
		probe = up;
	}
	return { path: expose ? path : null, exists, writable: exists ? writable : false, freeBytes: free };
}

/** How the opener is spawned (`launch`). */
export type OpenerCommand = {
	cmd: string;
	args: string[];
	env?: Record<string, string>;
	/**
	 * Windows: `args` are already the exact command-line text (child_process `windowsVerbatimArguments`). Node would
	 * otherwise quote each argument for programs that parse with the C runtime rules; explorer.exe does not.
	 */
	verbatim?: boolean;
};

/** The fixed PowerShell command of "open" on Windows. No part of it comes from the file. */
export const WINDOWS_OPEN_COMMAND = 'Invoke-Item -LiteralPath $env:JASPER_OPEN_PATH';

/**
 * The host command that reveals / opens a path (overridable with `JASPER_OPEN_COMMAND` for tests and kiosks).
 *
 * Windows (security review ENG-5; the quoting is covered by test/windows-opener.test.ts, which also runs the open
 * command through a real PowerShell when one is installed):
 *  - open: never through `cmd.exe /c start`, which parses the path as a command line (a file named
 *    `a&calc.exe&.mp4` ran calc.exe). The command line is a constant; the path travels in the environment and
 *    PowerShell reads it as a value (`$env:` expands to one argument, never re-parsed) for `-LiteralPath` (no
 *    wildcards: `[`, `]`, `*`, `?` are file name characters).
 *  - reveal: `explorer.exe /select,"<path>"`, written verbatim. explorer.exe splits its command line at commas and
 *    honours double quotes; quoting the whole argument (what Node does by itself) leaves a comma in a path as a
 *    separator and selects the wrong item. `"` cannot be part of a Windows file name: a path with one is not
 *    revealed at all (the folder is opened instead, via the same quoting, when it has none).
 */
export function openerFor(
	action: 'reveal' | 'open',
	path: string,
	platform: NodeJS.Platform = process.platform,
	override?: string,
): OpenerCommand {
	if (override) return { cmd: override, args: [action, path] };
	if (platform === 'darwin') return { cmd: 'open', args: action === 'reveal' ? ['-R', path] : [path] };
	if (platform === 'win32') {
		if (path.includes('"') || path.includes('\0') || /[\r\n]/.test(path))
			throw new HttpError(400, 'NOT_MEDIA', 'This file name cannot be handed to Windows');
		return action === 'reveal'
			? { cmd: 'explorer.exe', args: [`/select,"${path}"`], verbatim: true }
			: {
					cmd: 'powershell.exe',
					args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OPEN_COMMAND],
					env: { JASPER_OPEN_PATH: path },
				};
	}
	// Linux / BSD: freedesktop. xdg-open cannot select a file, so reveal opens its folder.
	return { cmd: 'xdg-open', args: [action === 'reveal' ? dirname(path) : path] };
}

/** Spawns the opener detached; resolves when it started (ENOENT → a typed error). */
function launch(o: OpenerCommand): Promise<void> {
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(o.cmd, o.args, {
				detached: true,
				stdio: 'ignore',
				windowsHide: true,
				// Never a shell, on any platform.
				shell: false,
				...(o.verbatim ? { windowsVerbatimArguments: true } : {}),
				...(o.env ? { env: { ...process.env, ...o.env } } : {}),
			});
		} catch (e) {
			reject(e);
			return;
		}
		child.once('error', reject);
		child.once('spawn', () => {
			child.unref();
			resolve();
		});
	});
}

export default async function gapsRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const local = () => core.config.dev || isLoopbackHost(core.config.host);

	const locate = async (key: string) => {
		const r = MEDIA_KEY_RE.test(key) ? core.registry.get(key) : null;
		if (!r) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
		const path = await core.registry.resolvePath(key);
		let exists = false;
		if (path)
			try {
				exists = (await stat(path)).isFile();
			} catch {
				exists = false;
			}
		return { path: path ?? null, exists };
	};

	// ---- Preferences ▸ Auto Save / Memory (UI-4): engine-wide, persisted in <appdir>/engine/gaps-settings.json
	const settingsFile = join(core.config.paths.engineDir, 'gaps-settings.json');
	const readSettings = async (): Promise<EngineGapsSettings> => {
		const p = core.projects.versionPolicy();
		const base: EngineGapsSettings = {
			versionIntervalMinutes: p.versionIntervalMs / 60_000,
			keepVersions: p.keepVersions,
			optimizeFor: renderOptimization(),
		};
		try {
			const raw = JSON.parse(await readFile(settingsFile, 'utf8')) as unknown;
			const r = EngineGapsSettingsSchema.partial().safeParse(raw);
			return r.success ? { ...base, ...r.data } : base;
		} catch {
			return base;
		}
	};
	const apply = (st: EngineGapsSettings) => {
		core.projects.setVersionPolicy({
			versionIntervalMs: st.versionIntervalMinutes * 60_000,
			keepVersions: st.keepVersions,
		});
		setRenderOptimization(st.optimizeFor);
	};
	apply(await readSettings());
	const info = async () => {
		const st = await readSettings();
		return {
			...st,
			memory: {
				totalBytes: totalmem(),
				freeBytes: freemem(),
				engineRssBytes: process.memoryUsage().rss,
				cpuCount: availableParallelism(),
			},
		};
	};
	app.get(
		'/api/settings/gaps',
		guarded(async () => info()),
	);
	app.put(
		'/api/settings/gaps',
		guarded(async (req) => {
			const patch = parseOr400(EngineGapsSettingsSchema.partial(), req.body ?? {});
			const current = await readSettings();
			// Security review AGT-3: keeping fewer versions prunes the older ones on the next save of every project.
			if (patch.keepVersions !== undefined && patch.keepVersions < current.keepVersions)
				await requireUserApproval(app, req, {
					label: 'Keep fewer project versions',
					summary: `keep ${patch.keepVersions} saved version${patch.keepVersions === 1 ? '' : 's'} per project instead of ${current.keepVersions}`,
					reasons: ['older saved versions of every project are deleted the next time it is saved'],
				});
			const next = { ...current, ...patch };
			await atomicWriteJson(settingsFile, next);
			apply(next);
			return info();
		}),
	);

	// ---- File ▸ Project Manager (PRJ-6)
	const pm = new ProjectManagerService(core);
	pm.registerRunner();
	app.post(
		'/api/project-manager/plan',
		guarded(async (req) => pm.estimate(parseOr400(ProjectManagerRequestSchema, req.body))),
	);
	app.post(
		'/api/project-manager',
		guarded(async (req, reply) =>
			reply.code(202).send(await pm.submit(parseOr400(ProjectManagerRequestSchema, req.body))),
		),
	);

	// ---- Create Proxies / ingest (PRJ-8)
	const mediaJobs = new MediaJobService(core);
	mediaJobs.registerRunner();
	app.jasper.services.mediaJobs = mediaJobs;
	app.post(
		'/api/media-jobs',
		guarded(async (req, reply) => {
			const body = parseOr400(MediaJobRequestSchema, req.body);
			return reply.code(202).send(await mediaJobs.submit(body));
		}),
	);

	// ---- Warp Stabilizer background analysis (FX-6)
	const warp = new WarpAnalysisService(core);
	warp.registerRunner();
	app.post(
		'/api/warp-analysis',
		guarded(async (req, reply) =>
			reply.code(202).send(await warp.submit(parseOr400(WarpAnalysisRequestSchema, req.body))),
		),
	);

	// ---- Auto Reframe subject analysis (AI-2)
	const reframe = new ReframeService(core, () => app.jasper.services.roto as RotoService | undefined);
	reframe.registerRunner();
	app.post(
		'/api/reframe',
		guarded(async (req, reply) =>
			reply.code(202).send(await reframe.submit(parseOr400(ReframeRequestSchema, req.body))),
		),
	);

	// ---- Project Settings ▸ Scratch Disks
	app.get<P>(
		'/api/projects/:projectId/scratch',
		guarded<P>(async (req) => {
			const id = req.params.projectId;
			if (!isProjectId(id)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const paths = core.config.paths;
			const expose = local();
			return {
				local: expose,
				projectMedia: await describeFolder(join(paths.projectDir(id), PROJECT_MEDIA_DIR), expose),
				previews: await describeFolder(join(paths.cacheDir, 'previews'), expose),
				mediaCache: await describeFolder(paths.cacheDir, expose),
				autoSave: await describeFolder(paths.projectVersionsDir(id), expose),
				home: expose ? homedir() : null,
			};
		}),
	);

	app.post(
		'/api/scratch/check',
		guarded(async (req) => {
			if (!local())
				throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Scratch folders can only be chosen on a local engine');
			const body = parseOr400(ScratchCheckRequestSchema, req.body);
			if (!isAbsolute(body.path) || body.path.includes('\0'))
				return {
					ok: false,
					path: body.path,
					exists: false,
					writable: false,
					freeBytes: null,
					message: 'Use an absolute folder path',
				};
			if (body.create)
				try {
					await mkdir(body.path, { recursive: true });
				} catch (e) {
					return {
						ok: false,
						...(await describeFolder(body.path, true)),
						message: `The folder cannot be created: ${(e as Error).message}`,
					};
				}
			const d = await describeFolder(body.path, true);
			const ok = d.exists ? d.writable : true;
			return {
				ok,
				...d,
				...(ok ? {} : { message: d.exists ? 'The folder is not writable' : 'The folder does not exist' }),
			};
		}),
	);

	app.get<K>(
		'/api/media/:mediaKey/location',
		guarded<K>(async (req) => {
			const { path, exists } = await locate(req.params.mediaKey);
			return {
				mediaKey: req.params.mediaKey,
				path: local() ? path : null,
				exists,
				canOpen: local() && exists,
			};
		}),
	);

	app.post<K>(
		'/api/media/:mediaKey/open',
		guarded<K>(async (req) => {
			if (!local())
				throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Opening files is only available on a local engine');
			const { action } = parseOr400(MediaOpenRequestSchema, req.body ?? {});
			const { path, exists } = await locate(req.params.mediaKey);
			if (!path || !exists) throw new HttpError(404, 'MEDIA_OFFLINE', 'The media file is offline');
			if (action === 'open' && !isOpenableFile(path))
				throw new HttpError(
					400,
					'NOT_MEDIA',
					'Only media and document files are opened in their application; reveal this one in the file browser instead',
				);
			const opener = openerFor(action, path, process.platform, process.env.JASPER_OPEN_COMMAND);
			const { cmd } = opener;
			try {
				await launch(opener);
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				throw new HttpError(
					501,
					code === 'ENOENT' ? 'OPENER_MISSING' : 'OPEN_FAILED',
					code === 'ENOENT'
						? `${cmd} is not installed on the engine host; the file is ${path}`
						: `Could not open the file: ${(e as Error).message}`,
					{ path },
				);
			}
			return { ok: true as const, path, action };
		}),
	);
}
