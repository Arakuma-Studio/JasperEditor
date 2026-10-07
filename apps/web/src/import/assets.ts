// RegisteredMedia → document MediaAsset (ARCHITECTURE D-09, §9.2): a new `med_` id, an `engine-store`
// locator whose key is the engine's mediaKey, a `path` locator on desktop, and the probe copied as is.
import type { RegisteredMedia } from '@jasper/api';
import {
	flicksPerFrame,
	importedDescriptors,
	type MediaAsset,
	type MediaLocator,
	nearestAllowedRate,
	type ProjectDocument,
	type Rational,
	rationalEquals,
	type Sequence,
	supportsDropFrame,
} from '@jasper/project';

/** Engine identity used in `engine-store` locators. M1 talks to exactly one (local) engine. */
export const LOCAL_ENGINE_ID = 'local';

export function buildMediaAsset(
	reg: RegisteredMedia,
	opts: { id: string; engineId?: string; now: string; path?: string | null },
): MediaAsset {
	const locators: MediaLocator[] = [
		{ type: 'engine-store', engineId: opts.engineId ?? LOCAL_ENGINE_ID, key: reg.mediaKey },
	];
	const paths = new Set<string>();
	for (const l of reg.locators) {
		if (l.type === 'path' && !paths.has(l.path)) {
			paths.add(l.path);
			locators.push(l);
		}
	}
	if (opts.path && !paths.has(opts.path))
		locators.push({ type: 'path', path: opts.path, relativeToProject: null });
	return {
		id: opts.id,
		kind: reg.kind,
		fingerprint: reg.fingerprint,
		originalName: reg.originalName,
		sizeBytes: reg.sizeBytes,
		container: reg.container,
		probe: JSON.parse(JSON.stringify(reg.probe)),
		locators,
		derivation: null,
		importedAt: opts.now,
		// M2: LUT header (S06:LUT-001).
		...(reg.lut ? { lut: JSON.parse(JSON.stringify(reg.lut)) } : {}),
		...(reg.colorConfig ? { colorConfig: JSON.parse(JSON.stringify(reg.colorConfig)) } : {}),
		// imports: vector / Lottie / layered / image-sequence descriptors.
		...importedDescriptors(reg),
	};
}

/** The engine media key of an asset (first `engine-store` locator), or null. */
export function mediaKeyOf(asset: Pick<MediaAsset, 'locators'> | undefined | null): string | null {
	const l = asset?.locators.find((x) => x.type === 'engine-store');
	return l && l.type === 'engine-store' ? l.key : null;
}

export function videoStream(asset: Pick<MediaAsset, 'probe'>) {
	const s = asset.probe.streams.find((x) => x.type === 'video');
	return s && s.type === 'video' ? s : null;
}
export function audioStreams(asset: Pick<MediaAsset, 'probe'>) {
	return asset.probe.streams.flatMap((s) => (s.type === 'audio' ? [s] : []));
}

/** Display size after the rotation matrix (S01:AST-002: the probe stores true source dimensions). */
export function displayBox(asset: Pick<MediaAsset, 'probe'>): { width: number; height: number } | null {
	const vs = videoStream(asset);
	if (!vs) return null;
	const swap = asset.probe.rotationDegrees === 90 || asset.probe.rotationDegrees === 270;
	return swap ? { width: vs.height, height: vs.width } : { width: vs.width, height: vs.height };
}

const isVisual = (a: Pick<MediaAsset, 'kind'>) =>
	a.kind === 'video' || a.kind === 'image' || a.kind === 'animated-image';

/** Timeline length (frames at `rate`) a placement of the whole asset takes (mirrors `clip.place`). */
export function placementFrames(
	doc: Pick<ProjectDocument, 'settings'>,
	asset: MediaAsset,
	rate: Rational,
): number {
	const F = flicksPerFrame(rate);
	if (asset.kind === 'video' || asset.kind === 'audio') {
		const dur = asset.probe.durationFlicks ?? 0;
		return Math.max(1, Math.floor(dur / F + 1e-9));
	}
	return Math.max(1, Math.round((doc.settings.defaultStillDurationFrames * rate.num) / (rate.den * 30)));
}

export type SequenceSettingsPatch = {
	width?: number;
	height?: number;
	frameRate?: Rational;
	dropFrame?: boolean;
};

/**
 * Clip-mismatch check (S01:SEQ-005, S04:IN-008): for the first visual clip into an empty sequence, the
 * settings patch that would adopt the clip's display size and frame rate, or null when they already match.
 */
export function mismatchPatch(
	seq: Pick<Sequence, 'settings' | 'clips'>,
	asset: MediaAsset,
): SequenceSettingsPatch | null {
	if (Object.keys(seq.clips).length > 0 || !isVisual(asset)) return null;
	const box = displayBox(asset);
	if (!box) return null;
	const even = (n: number) => Math.max(16, Math.min(8192, n - (n % 2)));
	const patch: SequenceSettingsPatch = {};
	if (even(box.width) !== seq.settings.width || even(box.height) !== seq.settings.height) {
		patch.width = even(box.width);
		patch.height = even(box.height);
	}
	const vs = videoStream(asset);
	if (asset.kind === 'video' && vs) {
		const r = nearestAllowedRate(vs.frameRate);
		if (!rationalEquals(r, seq.settings.frameRate)) {
			patch.frameRate = r;
			patch.dropFrame = supportsDropFrame(r);
		}
	}
	return Object.keys(patch).length ? patch : null;
}

export function formatRate(r: Rational | null | undefined): string {
	if (!r) return '';
	const v = r.num / r.den;
	return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
}
