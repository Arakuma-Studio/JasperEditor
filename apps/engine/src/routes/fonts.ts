// Fonts (S04 §18, ARCHITECTURE §9.2): the catalog (`GET /api/fonts`: bundled families, then the user font library)
// and its files (`/fonts/<id>/<file>`, `/fonts/library/<fontId>.<ext>`, immutable; signed URLs serve the headless
// Remotion browser). wp fonts: the user font library routes — list, install (upload body or a local path), remove
// (an agent's removal needs the user's approval in the editor, security review AGT-3), and which saved projects use
// a face. social-comment §7.8: `/fonts/remote|emoji|images/…` serve the remote-asset manifest's files (downloaded
// on first request when the network policy allows).
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';
import { FontInstallPathRequestSchema, type FontUsageResponse, type LibraryFont } from '@jasper/api';
import { projectLookFontFamilies } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUserApproval } from '../agent/user-approval.ts';
import { isLoopbackHost } from '../context.ts';
import { asRemoteAssetError, REMOTE_IMAGE_CSP, type RemoteAssetError } from '../remote-assets/fetcher.ts';
import { serveFile } from '../tools/http.ts';
import { fail, guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { type CoreServices, coreServices } from '../tools/services.ts';

/** Saved projects read for one usage answer (each is parsed in full). */
const USAGE_MAX_PROJECTS = 200;

const InstallQuerySchema = z.object({ fileName: z.string().max(255).optional() });

/** Reads a request body stream, refusing (413) as soon as it passes `max` bytes. */
async function readCapped(body: Readable, max: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body) {
		const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		size += b.length;
		if (size > max) {
			body.destroy();
			throw new HttpError(413, 'FONT_TOO_LARGE', `The font file is larger than ${max} bytes`);
		}
		chunks.push(b);
	}
	return new Uint8Array(Buffer.concat(chunks, size));
}

/** Saved projects whose fonts, or whose project looks, render with the face (or its family). */
async function fontUsage(core: CoreServices, face: LibraryFont): Promise<FontUsageResponse> {
	const projects = await core.projects.list();
	const out: FontUsageResponse['projects'] = [];
	let scanned = 0;
	for (const p of projects.slice(0, USAGE_MAX_PROJECTS)) {
		let doc: { fonts?: unknown } | null;
		try {
			doc = (await core.projects.get(p.projectId)).envelope.document as { fonts?: unknown } | null;
		} catch {
			continue; // unreadable or newer project: not counted
		}
		scanned++;
		const fonts = doc?.fonts;
		const named: unknown[] =
			fonts && typeof fonts === 'object'
				? Object.values(fonts as Record<string, unknown>).map(
						(ref) => (ref as { family?: unknown } | null)?.family,
					)
				: [];
		// spec 19 TL-053: a project look names its family before any text is set in it.
		named.push(...projectLookFontFamilies(doc));
		const families = new Set<string>();
		for (const family of named)
			if (typeof family === 'string' && core.fonts.usesLibraryFace(family, face.id)) families.add(family);
		if (families.size) out.push({ projectId: p.projectId, name: p.name, families: [...families] });
	}
	return { projects: out, scanned, truncated: projects.length > USAGE_MAX_PROJECTS };
}

/** HTTP status of a remote-asset failure (social-comment §7.8). */
function remoteAssetStatus(e: RemoteAssetError): number {
	switch (e.code) {
		case 'REMOTE_ASSET_UNKNOWN':
		case 'DOWNLOAD_NOT_FOUND':
			return 404;
		case 'REMOTE_ASSETS_OFF':
			return 409;
		case 'DOWNLOAD_TIMEOUT':
			return 504;
		case 'ASSET_CACHE_WRITE':
		case 'REMOTE_ASSET_FAILED':
			return 500;
		default:
			// upstream failures: bad status, hash mismatch, wrong content
			return 502;
	}
}

export default async function fontsRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const { fonts, fontLibrary: library, remoteAssets } = core;
	app.get('/api/fonts', async () => fonts.catalog());

	app.get(
		'/api/fonts/library',
		guarded(async () => library.list()),
	);

	app.post<{ Querystring: { fileName?: string } }>(
		'/api/fonts/library',
		guarded<{ Querystring: { fileName?: string } }>(async (req, reply) => {
			const q = parseOr400(InstallQuerySchema, req.query ?? {});
			const body = req.body as Readable | undefined;
			if (!body || typeof (body as Readable).pipe !== 'function')
				throw new HttpError(415, 'BAD_REQUEST', 'Send the font file as application/octet-stream');
			const max = library.list().limits.maxFileBytes;
			const declared = Number(req.headers['content-length']);
			if (Number.isFinite(declared) && declared > max) {
				body.destroy();
				throw new HttpError(
					413,
					'FONT_TOO_LARGE',
					`The font file is ${declared} bytes; at most ${max} bytes are accepted`,
				);
			}
			const bytes = await readCapped(body, max);
			const r = await library.install(bytes, q.fileName ?? 'font');
			reply.code(r.installed.length ? 201 : 200);
			return r;
		}),
	);

	app.post(
		'/api/fonts/library/install-path',
		guarded(async (req, reply) => {
			// Path installs read the engine's file system: a local / desktop feature (S04:SC-002), like path media.
			if (!core.config.dev && !isLoopbackHost(core.config.host))
				throw new HttpError(
					403,
					'LOCAL_MODE_ONLY',
					'Installing fonts from a path is only available in local mode',
				);
			const { path } = parseOr400(FontInstallPathRequestSchema, req.body ?? {});
			if (!isAbsolute(path)) throw new HttpError(400, 'VALIDATION_FAILED', 'path must be absolute');
			const st = await stat(path).catch(() => null);
			if (!st) throw new HttpError(404, 'NOT_FOUND', 'No file at that path');
			if (!st.isFile()) throw new HttpError(400, 'VALIDATION_FAILED', 'path is not a file');
			const max = library.list().limits.maxFileBytes;
			if (st.size > max)
				throw new HttpError(
					413,
					'FONT_TOO_LARGE',
					`The font file is ${st.size} bytes; at most ${max} bytes are accepted`,
				);
			const r = await library.install(new Uint8Array(await readFile(path)), basename(path));
			reply.code(r.installed.length ? 201 : 200);
			return r;
		}),
	);

	app.get<{ Params: { fontId: string } }>(
		'/api/fonts/library/:fontId/usage',
		guarded<{ Params: { fontId: string } }>(async (req) => {
			const face = library.get(req.params.fontId);
			if (!face) throw new HttpError(404, 'FONT_NOT_FOUND', `Font not found: ${req.params.fontId}`);
			return fontUsage(core, face);
		}),
	);

	app.delete<{ Params: { fontId: string } }>(
		'/api/fonts/library/:fontId',
		guarded<{ Params: { fontId: string } }>(async (req) => {
			const face = library.get(req.params.fontId);
			if (!face) throw new HttpError(404, 'FONT_NOT_FOUND', `Font not found: ${req.params.fontId}`);
			if (!req.jasperEditor) {
				const usage = await fontUsage(core, face);
				const n = usage.projects.length;
				const names = usage.projects
					.slice(0, 5)
					.map((p) => `"${p.name}"`)
					.join(', ');
				await requireUserApproval(app, req, {
					label: 'Remove font',
					summary: `remove the font "${face.fullName}" (${face.postscriptName}) from your font library${n ? `; ${n} saved project${n === 1 ? ' uses' : 's use'} it: ${names}${n > 5 ? ', …' : ''}` : ''}`,
					reasons: [
						'removes a font of your library, shared by every project; this cannot be undone',
						...(n ? ['text set in it falls back to the default font until it is installed again'] : []),
					],
				});
			}
			const r = await library.remove(face.id);
			return { ok: true as const, ...r };
		}),
	);

	app.get<{ Params: { '*': string } }>(
		'/fonts/*',
		guarded<{ Params: { '*': string } }>(async (req, reply) => {
			const rest = req.params['*'];
			// social-comment §7.8: remote platform fonts (`remote/<id>-<hash>.<format>`), emoji images
			// (`emoji/<pack>/<version>/<key>.<format>`) and remote images (`images/<id>-<hash>.<format>`), downloaded on first request when the network policy allows. They
			// live under /fonts/ so signed URLs (headless renders), the dev proxy and the service worker treat them like
			// the bundled fonts.
			if (rest.startsWith('remote/') || rest.startsWith('emoji/') || rest.startsWith('images/')) {
				try {
					if (rest.startsWith('remote/')) {
						const file = await remoteAssets.ensureFontFile(rest.slice('remote/'.length));
						return serveFile(req, reply, file, { cache: 'immutable' });
					}
					// remote images of the manifest (`images/<id>-<hash>.<format>`: platform default avatars…)
					if (rest.startsWith('images/')) {
						const img = await remoteAssets.ensureImageFile(rest.slice('images/'.length));
						return serveFile(req, reply, img.path, {
							cache: 'immutable',
							contentType: img.contentType,
							extraHeaders: { 'content-security-policy': REMOTE_IMAGE_CSP },
						});
					}
					const parts = rest.slice('emoji/'.length).split('/');
					if (parts.length !== 3) return fail(reply, 404, 'NOT_FOUND', 'Unknown emoji image');
					let pack: string;
					let version: string;
					try {
						pack = decodeURIComponent(parts[0]!);
						version = decodeURIComponent(parts[1]!);
					} catch {
						return fail(reply, 404, 'NOT_FOUND', 'Unknown emoji image');
					}
					const img = await remoteAssets.ensureEmojiFile(pack, version, parts[2]!);
					// SVG packs (Twemoji…) are markup served from the engine origin: no scripts, nothing external
					// (on top of the download check), and never sniffed as anything else (serveFile's nosniff).
					return serveFile(req, reply, img.path, {
						cache: 'immutable',
						contentType: img.contentType,
						extraHeaders: { 'content-security-policy': REMOTE_IMAGE_CSP },
					});
				} catch (e) {
					const err = asRemoteAssetError(e);
					return reply
						.code(remoteAssetStatus(err))
						.header('cache-control', 'no-store')
						.type('application/json')
						.send(err.toJSON());
				}
			}
			const file = fonts.filePath(rest);
			if (!file) return fail(reply, 404, 'FONT_NOT_FOUND', 'Unknown font file');
			return serveFile(req, reply, file, { cache: 'immutable' });
		}),
	);
}
