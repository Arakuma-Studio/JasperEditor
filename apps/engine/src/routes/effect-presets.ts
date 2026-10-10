// Effect preset library (M3, S03:FX-030, AGT-020). Owner: wp-m3-presets.
//   GET    /api/effect-presets                     → {revision, folders, presets} (user library; built-ins ship
//                                                    in @jasper/project and are not served here)
//   POST   /api/effect-presets                     → Save Preset… (id + timestamps assigned)
//   PUT    /api/effect-presets/:presetId           → rename / move / type / description
//   DELETE /api/effect-presets/:presetId
//   POST   /api/effect-presets/folders             → new preset bin
//   PUT    /api/effect-presets/folders/:folderId   → rename / move bin
//   DELETE /api/effect-presets/folders/:folderId   → bin with everything inside
//   POST   /api/effect-presets/import              → Import… of a .json file
// Every change publishes `effectPresets.changed {revision}` so every editor window refreshes its Presets bin.
import {
	EffectPresetCreateRequestSchema,
	EffectPresetFolderCreateRequestSchema,
	EffectPresetFolderUpdateRequestSchema,
	EffectPresetImportRequestSchema,
	EffectPresetUpdateRequestSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { EffectPresetLibrary } from '../effect-presets/library.ts';
import { guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type PresetParams = { Params: { presetId: string } };
type FolderParams = { Params: { folderId: string } };

export default async function effectPresetRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const library = new EffectPresetLibrary(core.config.paths.effectPresetsFile, {
		onChange: (revision) => core.broadcaster.publish('effectPresets.changed', { revision }),
		log: (m) => app.log.warn(m),
	});
	app.jasper.services.effectPresets = library;

	app.get(
		'/api/effect-presets',
		guarded(async () => library.list()),
	);
	app.post(
		'/api/effect-presets',
		guarded(async (req, reply) => {
			const body = parseOr400(EffectPresetCreateRequestSchema, req.body ?? {});
			reply.code(201);
			return library.create(body.preset, body.folderId);
		}),
	);
	app.put<PresetParams>(
		'/api/effect-presets/:presetId',
		guarded<PresetParams>(async (req) =>
			library.update(req.params.presetId, parseOr400(EffectPresetUpdateRequestSchema, req.body ?? {})),
		),
	);
	// Security review AGT-3: the library is the user's, shared by every project, and has no undo. Deleting from it
	// is the user's decision: the editor window deletes after its own confirmation, an agent (MCP
	// `delete_effect_preset`, any other client with the token) is asked about in the editor first.
	app.delete<PresetParams>(
		'/api/effect-presets/:presetId',
		guarded<PresetParams>(async (req) => {
			const preset = (await library.list()).presets.find((p) => p.id === req.params.presetId);
			if (preset)
				await requireUserApproval(app, req, {
					label: 'Delete effect preset',
					summary: `delete the preset "${preset.name}" from your preset library`,
					reasons: ['deletes a preset of your library; this cannot be undone'],
				});
			return { ok: true as const, ...(await library.remove(req.params.presetId)) };
		}),
	);
	app.post(
		'/api/effect-presets/folders',
		guarded(async (req, reply) => {
			const body = parseOr400(EffectPresetFolderCreateRequestSchema, req.body ?? {});
			reply.code(201);
			return library.createFolder(body.name, body.parentId);
		}),
	);
	app.put<FolderParams>(
		'/api/effect-presets/folders/:folderId',
		guarded<FolderParams>(async (req) =>
			library.updateFolder(
				req.params.folderId,
				parseOr400(EffectPresetFolderUpdateRequestSchema, req.body ?? {}),
			),
		),
	);
	app.delete<FolderParams>(
		'/api/effect-presets/folders/:folderId',
		guarded<FolderParams>(async (req) => {
			const lib = await library.list();
			const folder = lib.folders.find((f) => f.id === req.params.folderId);
			if (folder) {
				const inside = library.contentsOf(lib, folder.id);
				await requireUserApproval(app, req, {
					label: 'Delete preset bin',
					summary: `delete the preset bin "${folder.name}" with ${inside.presets} preset${inside.presets === 1 ? '' : 's'} and ${inside.folders} bin${inside.folders === 1 ? '' : 's'} inside`,
					reasons: ['deletes presets of your library; this cannot be undone'],
				});
			}
			return { ok: true as const, ...(await library.removeFolder(req.params.folderId)) };
		}),
	);
	app.post(
		'/api/effect-presets/import',
		guarded(async (req) => {
			const body = parseOr400(EffectPresetImportRequestSchema, req.body ?? {});
			return library.import(body.file, body.folderId);
		}),
	);
}
