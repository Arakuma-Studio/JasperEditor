// Spec 19 TL-087: `POST /api/title-looks/poster` answers a PNG. A client that leaves stops waiting, and nothing renders
// once the last client has left.
import { join } from 'node:path';
import { LookPosterRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { serveFile } from '../tools/http.ts';
import { clientGoneSignal, guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';
import { LookPosterService } from '../title-looks/posters.ts';

export default async function titleLookRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const posters = new LookPosterService({
		dir: join(app.jasper.config.appdir, 'mg', 'posters'),
		remotion: core.remotion,
		resolveFont: (family, weight, italic) => {
			const f = core.fonts.resolve(family, weight, italic);
			return f ? core.signer.signUrl(core.origin(), f.url) : null;
		},
	});
	app.jasper.services.lookPosters = posters;
	app.addHook('onClose', async () => posters.close());
	app.post(
		'/api/title-looks/poster',
		guarded(async (req, reply) => {
			const gone = clientGoneSignal(reply);
			const body = parseOr400(LookPosterRequestSchema, req.body);
			const { file, cached } = await posters.poster(body, gone);
			reply.header('x-jasper-poster', cached ? 'cached' : 'rendered');
			return serveFile(req, reply, file, { cache: 'revalidate', contentType: 'image/png' });
		}),
	);
}
