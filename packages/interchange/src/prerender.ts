// Pre-rendering for export (EffectCraft's `prerender: unsupported | all | none` design): clips a format cannot
// represent are rendered by the engine's export pipeline to ProRes 4444 with alpha (one movie per clip, the clip
// alone on a transparent frame, Motion/Opacity/effects baked in) and referenced as media instead.
import {
	type BlendMode,
	type Clip,
	isEnabledMulticamClip,
	isKnownClipKind,
	type ProjectDocument,
	type Sequence,
	type Transform,
} from '@jasper/project';
import { formatCarriesBlend } from './blend.ts';
import { hasExpression } from './jasper-export.ts';
import type { Format } from './options.ts';

export const PRERENDER_MODES = ['unsupported', 'all', 'none'] as const;
export type PrerenderMode = (typeof PRERENDER_MODES)[number];

/** What a format can represent of a visual clip (for other applications, not JasperEditor's own metadata). */
type Caps = {
	video: boolean;
	transform: 'full' | 'uniform' | 'none';
	opacity: boolean;
	speed: boolean;
	nesting: boolean;
};

export const FORMAT_CAPS: Record<Format, Caps> = {
	fcp7: { video: true, transform: 'uniform', opacity: true, speed: true, nesting: true },
	fcpxml: { video: true, transform: 'full', opacity: true, speed: true, nesting: true },
	otio: { video: true, transform: 'none', opacity: false, speed: true, nesting: true },
	edl: { video: true, transform: 'none', opacity: false, speed: true, nesting: false },
	aaf: { video: true, transform: 'none', opacity: false, speed: false, nesting: false },
	omf: { video: false, transform: 'none', opacity: false, speed: false, nesting: false },
	ale: { video: false, transform: 'none', opacity: false, speed: false, nesting: false },
};

/** Default pre-render mode per format: OTIO keeps everything in its JasperEditor metadata. */
export function defaultPrerenderMode(format: Format): PrerenderMode {
	return format === 'otio' || !FORMAT_CAPS[format].video ? 'none' : 'unsupported';
}

export type PrerenderJob = {
	clipId: string;
	sequenceId: string;
	clipName: string;
	/** Why the clip is rendered. */
	reason: string;
	startFrame: number;
	durationFrames: number;
};

function isIdentityTransform(
	t: Transform,
	box: { width: number; height: number } | null,
	frame: { width: number; height: number },
): boolean {
	const anim = [t.position, t.anchor, t.scale, t.scaleWidth, t.rotation].some((a) => a.keyframes.length > 0);
	if (anim) return false;
	const cx = frame.width / 2;
	const cy = frame.height / 2;
	const ax = box ? box.width / 2 : t.anchor.value[0];
	const ay = box ? box.height / 2 : t.anchor.value[1];
	return (
		Math.abs(t.position.value[0] - cx) < 1e-6 &&
		Math.abs(t.position.value[1] - cy) < 1e-6 &&
		Math.abs(t.anchor.value[0] - ax) < 1e-6 &&
		Math.abs(t.anchor.value[1] - ay) < 1e-6 &&
		t.scale.value === 100 &&
		(t.uniformScale || t.scaleWidth.value === 100) &&
		t.rotation.value === 0 &&
		!t.flipH &&
		!t.flipV
	);
}

/** Why a clip cannot be a plain clip of `format` (null = it can), regardless of the mode. */
export function prerenderReason(doc: ProjectDocument, seq: Sequence, c: Clip, format: Format): string | null {
	const caps = FORMAT_CAPS[format];
	if (!caps.video) return null;
	if (!isKnownClipKind(c.kind)) return null;
	switch (c.kind) {
		case 'text':
			// text-animators: animators and text paths are drawn by the composition, so the pre-render carries them.
			return (c as { animators?: unknown[] }).animators?.length ? 'text clip with animators' : 'text clip';
		case 'shape':
			return 'shape clip';
		case 'motion-graphic':
			return 'motion graphic clip';
		case 'composition':
			return 'composition clip';
		case 'captions':
			return format === 'fcpxml' || format === 'otio' ? null : 'captions clip';
		case 'audio':
		case 'nest-audio':
		case 'adjustment':
		case 'synthetic-audio':
			return null;
	}
	const v = c as Clip & {
		transform: Transform;
		opacity: { value: number; keyframes: unknown[] };
		effects?: { enabled: boolean }[];
		trackedBy?: unknown;
	};
	// Formats without nests write an enabled multi-camera clip as its angle's clips (see `fromJasper`).
	const flattens = isEnabledMulticamClip(c) && !c.frameHold && !!doc.sequences[c.sequenceId]?.multicam;
	if (c.kind === 'nest-video' && !caps.nesting && !flattens) return 'nested sequence';
	const any = c as Clip & { masks?: unknown[]; effects?: { enabled: boolean; masks?: unknown[] }[] };
	if (any.masks?.length || (any.effects ?? []).some((e) => e.enabled && e.masks?.length)) return 'masks';
	if (hasExpression(c)) return 'expressions';
	if ((v.effects ?? []).some((e) => e.enabled)) return 'effects';
	const blend = (c as { blendMode?: BlendMode }).blendMode;
	if (blend && !formatCarriesBlend(format, blend)) return `blend mode ${blend}`;
	if (c.frameHold && !caps.speed) return 'frame hold';
	if (v.trackedBy) return 'tracking';
	const frame = { width: seq.settings.width, height: seq.settings.height };
	let box: { width: number; height: number } | null = null;
	if (c.kind === 'video' || c.kind === 'still' || c.kind === 'animated-image') {
		const a = doc.media[c.mediaId];
		const vs = a?.probe.streams.find((s) => s.type === 'video');
		if (vs && vs.type === 'video') {
			const swap = a!.probe.rotationDegrees === 90 || a!.probe.rotationDegrees === 270;
			box = swap ? { width: vs.height, height: vs.width } : { width: vs.width, height: vs.height };
		}
	} else if (c.kind === 'solid') box = frame;
	else if (c.kind === 'nest-video') {
		const inner = doc.sequences[c.sequenceId];
		if (inner) box = { width: inner.settings.width, height: inner.settings.height };
	}
	const t = v.transform;
	if (caps.transform === 'none' && !isIdentityTransform(t, box, frame)) return 'Motion';
	if (caps.transform === 'uniform') {
		if (t.flipH || t.flipV) return 'flipped Motion';
		const nonUniform =
			!t.uniformScale &&
			(t.scaleWidth.value !== t.scale.value ||
				t.scaleWidth.keyframes.length > 0 ||
				t.scale.keyframes.length > 0);
		if (nonUniform) return 'non-uniform scale';
	}
	if (!caps.opacity && (v.opacity.value !== 100 || v.opacity.keyframes.length > 0)) return 'Opacity';
	if (!caps.speed && (c.speed.rate !== 1 || c.speed.reverse)) return 'speed change';
	// FCP7 XML and OTIO (metadata) carry solids as generators; FCPXML generators are Motion templates.
	if (c.kind === 'solid' && format !== 'fcp7' && format !== 'otio')
		return 'solid (no generators in this format)';
	return null;
}

/** The clips the engine must render before exporting `sequenceId` to `format` under `mode`. */
export function planPrerender(
	doc: ProjectDocument,
	sequenceId: string,
	format: Format,
	mode: PrerenderMode,
): PrerenderJob[] {
	if (mode === 'none' || !FORMAT_CAPS[format].video) return [];
	const out: PrerenderJob[] = [];
	const seen = new Set<string>();
	const walk = (sid: string) => {
		if (seen.has(sid)) return;
		seen.add(sid);
		const seq = doc.sequences[sid] as Sequence | undefined;
		if (!seq) return;
		const visual = new Set([...seq.videoTracks, ...seq.captionTracks].map((t) => t.id));
		for (const c of Object.values(seq.clips) as Clip[]) {
			if (!visual.has(c.trackId)) continue;
			const why = prerenderReason(doc, seq, c, format);
			const all = mode === 'all' && c.kind !== 'adjustment' && isKnownClipKind(c.kind);
			if (why || all)
				out.push({
					clipId: c.id,
					sequenceId: sid,
					clipName: c.name,
					reason: why ?? 'pre-render all clips',
					startFrame: c.start,
					durationFrames: c.duration,
				});
			if (c.kind === 'nest-video' && FORMAT_CAPS[format].nesting && !(why || all)) walk(c.sequenceId);
		}
	};
	walk(sequenceId);
	out.sort((a, b) =>
		a.sequenceId === b.sequenceId ? a.startFrame - b.startFrame : a.sequenceId < b.sequenceId ? -1 : 1,
	);
	return out;
}
