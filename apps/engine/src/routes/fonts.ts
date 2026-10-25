import type { FastifyInstance } from 'fastify';
import { asRemoteAssetError, type RemoteAssetError } from '../remote-assets/fetcher.ts';
import { serveFile } from '../tools/http.ts';
import { fail, guarded } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

/** HTTP status of a remote-asset failure (social-comment §7.8). */
export function remoteAssetStatus(e: RemoteAssetError): number {
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
	const { fonts, remoteAssets } = coreServices(app);
	app.get('/api/fonts', async () => fonts.catalog());
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
						return serveFile(req, reply, img.path, { cache: 'immutable', contentType: img.contentType });
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
					return serveFile(req, reply, img.path, { cache: 'immutable', contentType: img.contentType });
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
