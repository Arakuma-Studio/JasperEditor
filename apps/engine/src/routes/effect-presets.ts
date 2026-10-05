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
	app.delete<PresetParams>(
		'/api/effect-presets/:presetId',
		guarded<PresetParams>(async (req) => ({
			ok: true as const,
			...(await library.remove(req.params.presetId)),
		})),
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
		guarded<FolderParams>(async (req) => ({
			ok: true as const,
			...(await library.removeFolder(req.params.folderId)),
		})),
	);
	app.post(
		'/api/effect-presets/import',
		guarded(async (req) => {
			const body = parseOr400(EffectPresetImportRequestSchema, req.body ?? {});
			return library.import(body.file, body.folderId);
		}),
	);
}
