// `scene.bind` (docs/wp-notes/scene-file.md § Ownership): merges layer → clip bindings of one sequence into
// `extensions["jasper.scene"]`. One undo step with the rest of the apply's transaction.
import { patchSceneBindings, SCENE_EXTENSION_KEY } from '../../scene/bindings.ts';
import { latest } from '../draft-read.ts';
import type { HandlerMap } from './util.ts';

export const SCENE_OWNER = 'scene-file';

export const sceneHandlers = {
	'scene.bind': (doc, cmd, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		for (const [layer, clipId] of Object.entries(cmd.clipIds))
			if (clipId !== null && !seq.clips[clipId])
				h.fail('E_NOT_FOUND', `Clip not found in sequence ${seq.id}: ${clipId} (layer "${layer}")`, {
					path: ['clipIds', layer],
				});
		const next = patchSceneBindings(
			{ extensions: latest(doc.extensions) as Record<string, unknown> },
			seq.id,
			cmd.clipIds,
		);
		if (next) doc.extensions[SCENE_EXTENSION_KEY] = next;
		else delete doc.extensions[SCENE_EXTENSION_KEY];
		return { sequenceId: seq.id, layers: Object.keys(next?.sequences[seq.id]?.layers ?? {}).length };
	},
} satisfies HandlerMap;
