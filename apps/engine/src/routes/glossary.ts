// The personal speech glossary (spec 17 SC-070 / SC-071; docs/wp-notes/script-correction.md "Personal glossary"):
//   GET    /api/speech/glossary                 → {revision, readOnly, repairs, limits, entries}
//   GET    /api/speech/glossary/export          → the importable file {format: 'jasper-speech-glossary', version, …}
//   GET    /api/speech/glossary/:entryId        → one entry
//   POST   /api/speech/glossary                 → add, or merge the spellings into the entry with the same `to`
//   POST   /api/speech/glossary/remember        → the same, counting one more teaching ("Remember", SC-071)
//   PUT    /api/speech/glossary/:entryId        → edit the spellings, target or language (an agent dropping
//                                                spellings or changing the target needs the user's approval)
//   DELETE /api/speech/glossary/:entryId        → delete it (an agent needs the user's approval in the editor)
//   POST   /api/speech/glossary/import          → merge a glossary file (additive)
// Writes to a glossary written by a newer version → 409 GLOSSARY_READ_ONLY; the change event is `glossary.changed`.
import {
	GlossaryImportRequestSchema,
	GlossarySaveRequestSchema,
	GlossaryUpdateRequestSchema,
} from '@jasper/api';
import { cleanGlossaryText, glossarySpellingKey } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { SpeechGlossary } from '../speech/glossary.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type EntryParams = { Params: { entryId: string } };

export default async function glossaryRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const glossary = new SpeechGlossary(core.config.paths.speechGlossaryFile, {
		onChange: (revision) => core.broadcaster.publish('glossary.changed', { revision }),
		log: (m) => app.log.warn(m),
	});
	app.jasper.services.speechGlossary = glossary;

	app.get(
		'/api/speech/glossary',
		guarded(async (_req, reply) => {
			reply.header('cache-control', 'no-store');
			return glossary.list();
		}),
	);
	app.get(
		'/api/speech/glossary/export',
		guarded(async (_req, reply) => {
			reply.header('cache-control', 'no-store');
			return glossary.exportFile();
		}),
	);
	app.get<EntryParams>(
		'/api/speech/glossary/:entryId',
		guarded<EntryParams>(async (req) => glossary.get(req.params.entryId)),
	);
	app.post(
		'/api/speech/glossary',
		guarded(async (req, reply) => {
			const r = await glossary.save(parseOr400(GlossarySaveRequestSchema, req.body ?? {}));
			reply.code(r.created ? 201 : 200);
			return r;
		}),
	);
	app.post(
		'/api/speech/glossary/remember',
		guarded(async (req, reply) => {
			const r = await glossary.save(parseOr400(GlossarySaveRequestSchema, req.body ?? {}), true);
			reply.code(r.created ? 201 : 200);
			return r;
		}),
	);
	// An edit that drops spellings or changes the right spelling loses something the glossary cannot undo: an agent
	// asks the user first (adding spellings or setting the language does not).
	app.put<EntryParams>(
		'/api/speech/glossary/:entryId',
		guarded<EntryParams>(async (req) => {
			const patch = parseOr400(GlossaryUpdateRequestSchema, req.body ?? {});
			const entry = await glossary.get(req.params.entryId);
			const kept = new Set((patch.from ?? entry.from).map(glossarySpellingKey));
			const dropped = entry.from.filter((f) => !kept.has(glossarySpellingKey(f)));
			const retargeted = patch.to !== undefined && cleanGlossaryText(patch.to) !== entry.to;
			if (dropped.length || retargeted)
				await requireUserApproval(app, req, {
					label: 'Change glossary entry',
					summary: [
						retargeted ? `change “${entry.to}” to “${cleanGlossaryText(patch.to!)}”` : `change “${entry.to}”`,
						dropped.length ? `removing ${dropped.map((f) => `“${f}”`).join(', ')}` : '',
					]
						.filter(Boolean)
						.join(', ')
						.concat(' in your speech glossary'),
					reasons: ['changes an entry of your glossary; this cannot be undone'],
				});
			return glossary.update(req.params.entryId, patch);
		}),
	);
	// The glossary is the user's, shared by every project, and has no undo: an agent's delete is asked about in the
	// editor first (as for effect and cleanup presets, security review AGT-3). The editor window deletes after its
	// own confirmation.
	app.delete<EntryParams>(
		'/api/speech/glossary/:entryId',
		guarded<EntryParams>(async (req) => {
			const entry = await glossary.get(req.params.entryId);
			await requireUserApproval(app, req, {
				label: 'Delete glossary entry',
				summary: `delete “${entry.to}”${entry.from.length ? ` (corrects ${entry.from.map((f) => `“${f}”`).join(', ')})` : ''} from your speech glossary`,
				reasons: ['deletes an entry of your glossary; this cannot be undone'],
			});
			return { ok: true as const, ...(await glossary.remove(req.params.entryId)) };
		}),
	);
	app.post(
		'/api/speech/glossary/import',
		guarded(async (req) => {
			const body = parseOr400(GlossaryImportRequestSchema, req.body ?? {});
			return glossary.import(body.file);
		}),
	);
}
