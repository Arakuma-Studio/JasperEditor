// RegisteredMedia (engine `POST /api/media/register`) → the `media.register` command that adds the asset
// and a Project item to the document (ARCHITECTURE D-09: an `engine-store` locator keyed by the engine's
// mediaKey, plus the file's `path` locator; the probe is copied as is).
import type { RegisteredMedia } from '@jasper/api';
import { importedDescriptors, type MediaLocator } from '@jasper/project';

/** Engine identity used in `engine-store` locators (M1 talks to exactly one local engine). */
export const LOCAL_ENGINE_ID = 'local';

export function mediaRegisterCommand(reg: RegisteredMedia, ref: string, itemRef: string, name?: string) {
	const locators: MediaLocator[] = [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }];
	const seen = new Set<string>();
	for (const l of reg.locators)
		if (l.type === 'path' && !seen.has(l.path)) {
			seen.add(l.path);
			locators.push(l);
		}
	return {
		type: 'media.register',
		asset: {
			kind: reg.kind,
			fingerprint: reg.fingerprint,
			originalName: reg.originalName,
			sizeBytes: reg.sizeBytes,
			container: reg.container,
			probe: reg.probe,
			locators,
			// M2: LUT header (S06:LUT-001).
			...(reg.lut ? { lut: reg.lut } : {}),
			...(reg.colorConfig ? { colorConfig: reg.colorConfig } : {}),
			// imports: vector / Lottie / layered / image-sequence descriptors.
			...importedDescriptors(reg),
		},
		...(name ? { name } : {}),
		ref,
		itemRef,
	};
}
