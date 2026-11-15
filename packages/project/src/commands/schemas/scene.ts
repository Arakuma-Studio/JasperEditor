// Scene files (docs/wp-notes/scene-file.md § Ownership): `scene.bind` records which clips `jasper apply` created for
// the layers of a scene file, so a later apply can remove the clip of a layer that left the file and nothing else.
import { z } from 'zod';
import { MAX_SCENE_BINDINGS } from '../../scene/bindings.ts';
import { cmd, IdRefSchema } from './common.ts';

export const SceneBindCmd = cmd('scene.bind', {
	sequenceId: IdRefSchema,
	/** Layer id → the clip it made in `sequenceId` (null forgets the layer); other layers are kept. */
	clipIds: z
		.record(z.string().min(1).max(200), IdRefSchema.nullable())
		.refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= MAX_SCENE_BINDINGS, {
			message: `1…${MAX_SCENE_BINDINGS} layers`,
		}),
});

export const SCENE_COMMANDS = [SceneBindCmd] as const;
