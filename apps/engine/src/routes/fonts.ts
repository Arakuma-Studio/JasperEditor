// Bundled font catalog and files (ARCHITECTURE §9.2, S04:FT-001…003).
import type { FastifyInstance } from 'fastify';
import { serveFile } from '../tools/http.ts';
import { fail, guarded } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function fontsRoutes(app: FastifyInstance): Promise<void> {
	const { fonts } = coreServices(app);
	app.get('/api/fonts', async () => fonts.catalog());
	app.get<{ Params: { '*': string } }>(
		'/fonts/*',
		guarded<{ Params: { '*': string } }>(async (req, reply) => {
			const file = fonts.filePath(req.params['*']);
			if (!file) return fail(reply, 404, 'FONT_NOT_FOUND', 'Unknown font file');
			return serveFile(req, reply, file, { cache: 'immutable' });
		}),
	);
}
