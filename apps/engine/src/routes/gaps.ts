// Workstream `gaps` (docs/wp-notes/gaps.md):
//   GET  /api/media/:mediaKey/location   where the media file is on this host (Edit Original)
//   POST /api/media/:mediaKey/open       reveal it in the file browser / open it in its default application
// (local engines only: a remote engine must never launch programs on its host for a browser client).
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MediaOpenRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { isLoopbackHost } from '../context.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type K = { Params: { mediaKey: string } };

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
