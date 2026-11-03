// Spec 19 title-look routes.
// TL-054: the user look library. Deleting is the user's decision, as for effect presets (security review AGT-3): the
// editor window deletes after its own confirmation, an agent is asked about in the editor first.
// TL-087: `POST /api/title-looks/poster` answers a PNG. A client that leaves stops waiting, and nothing renders
// once the last client has left.
import { join } from 'node:path';
import {
	LookPosterRequestSchema,
	TitleLookCreateRequestSchema,
	TitleLookExportRequestSchema,
	TitleLookImportRequestSchema,
	TitleLookUpdateRequestSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { UserLookLibrary } from '../title-looks/library.ts';
import { LookPosterService } from '../title-looks/posters.ts';
import { serveFile } from '../tools/http.ts';
import { clientGoneSignal, guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type LookParams = { Params: { lookId: string } };

export default async function titleLookRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const library = new UserLookLibrary(core.config.paths.titleLooksFile, {
		onChange: (revision) => core.broadcaster.publish('titleLooks.changed', { revision }),
		log: (m) => app.log.warn(m),
	});
	app.jasper.services.titleLooks = library;
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

	app.get(
		'/api/title-looks',
		guarded(async () => library.list()),
	);
	app.post(
		'/api/title-looks',
		guarded(async (req, reply) => {
			const body = parseOr400(TitleLookCreateRequestSchema, req.body ?? {});
			reply.code(201);
			return library.save(body);
		}),
	);
	app.post(
		'/api/title-looks/import',
		guarded(async (req) => library.import(parseOr400(TitleLookImportRequestSchema, req.body ?? {}).file)),
	);
	app.post(
		'/api/title-looks/export',
		guarded(async (req) => library.export(parseOr400(TitleLookExportRequestSchema, req.body ?? {}).ids)),
	);
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
	app.put<LookParams>(
		'/api/title-looks/:lookId',
		guarded<LookParams>(async (req) =>
			library.update(req.params.lookId, parseOr400(TitleLookUpdateRequestSchema, req.body ?? {})),
		),
	);
	app.delete<LookParams>(
		'/api/title-looks/:lookId',
		guarded<LookParams>(async (req) => {
			const look = (await library.list()).looks.find((l) => l.id === req.params.lookId);
			if (look)
				await requireUserApproval(app, req, {
					label: 'Delete look',
					summary: `delete the look "${look.name}" from your look library`,
					reasons: ['deletes a look of your library; this cannot be undone'],
				});
			return { ok: true as const, ...(await library.remove(req.params.lookId)) };
		}),
	);
}
