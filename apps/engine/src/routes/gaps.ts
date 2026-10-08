// Workstream `gaps` (docs/wp-notes/gaps.md):
//   GET  /api/media/:mediaKey/location   where the media file is on this host (Edit Original)
//   POST /api/media/:mediaKey/open       reveal it in the file browser / open it in its default application
// (local engines only: a remote engine must never launch programs on its host for a browser client).
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { MediaOpenRequestSchema, ScratchCheckRequestSchema, type ScratchLocation } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { isLoopbackHost } from '../context.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { freeDiskBytes } from '../tools/fs.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type K = { Params: { mediaKey: string } };
type P = { Params: { projectId: string } };

const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{16}$/;
/** "Same as Project" for generated media: a folder inside the project's engine folder. */
export const PROJECT_MEDIA_DIR = 'Generated Media';

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

/** Never `open` these with the host opener: it would run a program instead of showing media. */
const EXECUTABLE =
	/\.(exe|com|bat|cmd|msi|scr|ps1|vbs|js|jse|wsf|lnk|url|jar|sh|bash|zsh|command|app|desktop|appimage|run|bin|pkg|dmg|deb|rpm)$/i;

/** The host command that reveals / opens a path (overridable with `JASPER_OPEN_COMMAND` for tests and kiosks). */
export function openerFor(
	action: 'reveal' | 'open',
	path: string,
	platform: NodeJS.Platform = process.platform,
	override?: string,
): { cmd: string; args: string[] } {
	if (override) return { cmd: override, args: [action, path] };
	if (platform === 'darwin') return { cmd: 'open', args: action === 'reveal' ? ['-R', path] : [path] };
	if (platform === 'win32')
		return action === 'reveal'
			? { cmd: 'explorer.exe', args: [`/select,${path}`] }
			: { cmd: 'cmd.exe', args: ['/c', 'start', '""', path] };
	// Linux / BSD: freedesktop. xdg-open cannot select a file, so reveal opens its folder.
	return { cmd: 'xdg-open', args: [action === 'reveal' ? dirname(path) : path] };
}

/** Spawns the opener detached; resolves when it started (ENOENT → a typed error). */
function launch(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
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

	// ---- Project Settings ▸ Scratch Disks
	app.get<P>(
		'/api/projects/:projectId/scratch',
		guarded<P>(async (req) => {
			const id = req.params.projectId;
			if (!PROJECT_ID_RE.test(id)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
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
			if (action === 'open' && EXECUTABLE.test(path))
				throw new HttpError(400, 'NOT_MEDIA', 'This file is a program, not media; it is not opened');
			const { cmd, args } = openerFor(action, path, process.platform, process.env.JASPER_OPEN_COMMAND);
			try {
				await launch(cmd, args);
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
