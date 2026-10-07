// three-d: loading 3D model media for Advanced 3D (the shared parser of @jasper/project; base colour images decoded
// with createImageBitmap). Models are cached by URL; the format is sniffed from the bytes (media URLs carry no name).
import { type ModelFormat, type ParsedModel, parseModel, type Vec3 } from '@jasper/project';

export type LoadedModel = {
	model: ParsedModel;
	/** Decoded base colour image of each primitive (null: none). */
	textures: (ImageBitmap | null)[];
};

type Entry =
	| { state: 'loading'; promise: Promise<void> }
	| { state: 'ready'; value: LoadedModel }
	| { state: 'error'; error: string };
const cache = new Map<string, Entry>();

export function sniffModelFormat(bytes: Uint8Array): ModelFormat {
	if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
	for (let i = 0; i < Math.min(bytes.length, 64); i++) {
		const c = bytes[i]!;
		if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xef || c === 0xbb || c === 0xbf)
			continue;
		return c === 0x7b ? 'gltf' : 'obj';
	}
	return 'obj';
}

/** The loaded model of a URL, or its state. Starts loading on first call; `onChange` runs when it settles. */
export function modelAt(url: string, onChange: () => void): Entry {
	const hit = cache.get(url);
	if (hit) {
		if (hit.state === 'loading') hit.promise.then(onChange, onChange);
		return hit;
	}
	const promise = (async () => {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			const model = parseModel(bytes, sniffModelFormat(bytes));
			const textures = await Promise.all(
				model.primitives.map(async (p) => {
					if (!p.material.texture) return null;
					try {
						return await createImageBitmap(
							new Blob([p.material.texture.bytes as BlobPart], { type: p.material.texture.mime }),
						);
					} catch {
						return null;
					}
				}),
			);
			cache.set(url, { state: 'ready', value: { model, textures } });
		} catch (e) {
			cache.set(url, { state: 'error', error: (e as Error).message ?? String(e) });
		}
	})();
	const entry: Entry = { state: 'loading', promise };
	cache.set(url, entry);
	promise.then(onChange, onChange);
	return entry;
}

/**
 * Model units → layer px (row-major 4×4): the model fitted to half the frame height, its bounding-box centre at the
 * frame centre (z 0); glTF's y up / +z towards the viewer become y down / +z away.
 */
export function modelToLayer(
	bounds: { min: Vec3; max: Vec3 },
	frame: { width: number; height: number },
): number[] {
	const c: Vec3 = [
		(bounds.min[0] + bounds.max[0]) / 2,
		(bounds.min[1] + bounds.max[1]) / 2,
		(bounds.min[2] + bounds.max[2]) / 2,
	];
	const ext = Math.max(
		bounds.max[0] - bounds.min[0],
		bounds.max[1] - bounds.min[1],
		bounds.max[2] - bounds.min[2],
		1e-9,
	);
	const s = (0.5 * frame.height) / ext;
	return [
		s,
		0,
		0,
		frame.width / 2 - s * c[0],
		0,
		-s,
		0,
		frame.height / 2 + s * c[1],
		0,
		0,
		-s,
		s * c[2],
		0,
		0,
		0,
		1,
	];
}
