// 3D model assets (three-d): .glb / .gltf / .obj files register as media of kind `model` through the asset-prober hook
// of media/probe.ts. The prober parses the file with the shared parser of @jasper/project (the renderer loads it with
// the same code); a file it cannot read fails the import with the parser's reason (INVALID_MODEL).
import { readFile, stat } from 'node:fs/promises';
import { EMPTY_PROBE, ModelParseError, modelFormatOf, parseModel } from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { AssetProber } from '../media/probe.ts';

/** Largest model file accepted. */
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export const modelProber: AssetProber = {
	id: 'three-d.model',
	matches: (file) => modelFormatOf(file) !== null,
	async probe(file) {
		const format = modelFormatOf(file)!;
		const st = await stat(file);
		if (st.size > MAX_MODEL_BYTES)
			throw new JobError(
				'INVALID_MODEL',
				`Model file too large (${st.size} bytes, max ${MAX_MODEL_BYTES})`,
				false,
			);
		const bytes = new Uint8Array(await readFile(file));
		try {
			parseModel(bytes, format);
		} catch (e) {
			if (e instanceof ModelParseError || e instanceof SyntaxError)
				throw new JobError('INVALID_MODEL', `Cannot read the 3D model: ${e.message}`, false);
			throw e;
		}
		return {
			kind: 'model',
			container: format,
			probe: { ...EMPTY_PROBE, streams: [] },
			browserPlayable: 'no',
			durationSec: null,
			frameCount: null,
			interlaced: false,
			hasVideo: false,
			hasAudio: false,
			display: null,
		};
	},
};
