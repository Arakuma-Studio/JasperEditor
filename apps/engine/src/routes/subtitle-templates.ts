// spec 13 AS-020: the user subtitle template library over HTTP (`/api/subtitle-templates`).
import { SubtitleTemplateSaveRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { SubtitleTemplateLibrary } from '../subtitle-templates/library.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Params = { Params: { templateId: string } };

export default async function subtitleTemplateRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const library = new SubtitleTemplateLibrary(core.config.paths.subtitleTemplatesFile, {
		onChange: (revision) => core.broadcaster.publish('subtitleTemplates.changed', { revision }),
		log: (m) => app.log.warn(m),
	});
	app.jasper.services.subtitleTemplates = library;

	app.get(
		'/api/subtitle-templates',
		guarded(async () => library.list()),
	);
	app.put<Params>(
		'/api/subtitle-templates/:templateId',
		guarded<Params>(async (req) => {
			const body = parseOr400(SubtitleTemplateSaveRequestSchema, req.body ?? {});
			return library.save(req.params.templateId, body.template);
		}),
	);
	// The library is the user's, shared by every project, and has no undo: an agent's delete is approved in the editor.
	app.delete<Params>(
		'/api/subtitle-templates/:templateId',
		guarded<Params>(async (req) => {
			const t = (await library.list()).templates.find((x) => x.id === req.params.templateId);
			if (t)
				await requireUserApproval(app, req, {
					label: 'Delete subtitle template',
					summary: `delete the subtitle template "${t.name}" from your template library`,
					reasons: ['deletes a template of your library; this cannot be undone'],
				});
			return { ok: true as const, ...(await library.remove(req.params.templateId)) };
		}),
	);
}
