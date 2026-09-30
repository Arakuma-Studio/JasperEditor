// Export planner (ARCHITECTURE §9.5, S04 §11): builds the render snapshot with engine-local media,
// classifies every layer for the native path and returns an S04:RP-010 RenderPlan with per-clip blockers
// (RP-008) and warnings (offline media, VFR sources, missing fonts). M1 paths: `native` | `remotion`.
import { createHash } from 'node:crypto';
import type { EncoderChoice, ExportSettings, RenderPlan } from '@jasper/api';
import {
	buildRenderSnapshot,
	isAnimated,
	loadProject,
	type MediaAsset,
	type MediaHandle,
	mediaDecodeHints,
	type ProjectDocument,
	type Rational,
	type RenderSnapshot,
	type RenderVisualClip,
	rationalEquals,
} from '@jasper/project';
import type { FontCatalogService } from '../fonts/catalog.ts';
import { alphaDecoder } from '../media/alpha.ts';
import type { MediaRecord, MediaRegistry } from '../media/registry.ts';
import { type EncoderRequest, LEGACY_X264_CHOICE } from '../tools/encoders.ts';

export type PlanCapabilities = {
	/** ffmpeg + encoders present (self-check). */
	native: boolean;
	remotionLocal: 'ready' | 'needs-browser-download' | 'unavailable';
	fframes: 'ready' | 'unavailable';
	/** WP-2G registered an mgMasterProvider. */
	mgMasters: boolean;
	/** `ffmpeg -decoders` of the engine's build; absent = unknown (assume the usual decoders exist). */
	decoders?: readonly string[];
};

export class PlanError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'PlanError';
	}
}

/** Effects the native builder reproduces exactly (static params only). */
export const NATIVE_EFFECTS = new Set(['jasper.crop', 'jasper.flip-horizontal', 'jasper.flip-vertical']);
const NATIVE_VISUAL_KINDS = new Set(['video', 'still', 'solid', 'motion-graphic']);

export type OutputSpec = {
	width: number;
	height: number;
	fps: Rational;
	/** Exact output frame count (S04:RN-022). */
	frames: number;
	durationSec: number;
	scaling: 'fit' | 'fill' | 'stretch';
	crf: number;
	x264Preset: 'veryfast' | 'medium' | 'slow';
	speed: 'fast' | 'balanced' | 'best';
	/** Video encoder (D-13); null = no usable encoder (the native path is blocked). */
	encoder: EncoderChoice | null;
	audioChannels: 1 | 2;
	audioBitrateKbps: number;
};

export type LocalMedia = { path: string; record: MediaRecord };

export type PlannedExport = {
	plan: RenderPlan & { planId: string; documentRevision: number };
	document: ProjectDocument;
	sequenceId: string;
	range: { start: number; end: number };
	/** Snapshot whose media handles point at engine-local files (`url` = absolute path). */
	snapshot: RenderSnapshot;
	/** mediaId → online local file. */
	media: Record<string, LocalMedia>;
	output: OutputSpec;
};

/** The engine media key of an asset (engine-store locator), or null. */
export function mediaKeyOf(asset: Pick<MediaAsset, 'locators'>): string | null {
	for (const l of asset.locators) if (l.type === 'engine-store') return l.key;
	return null;
}

function staticOk(a: { keyframes: readonly unknown[] } | undefined | null): boolean {
	return !isAnimated(a);
}

function fpsNum(r: Rational): number {
	return r.num / r.den;
}

function exportRange(
	doc: ProjectDocument,
	sequenceId: string,
	settings: ExportSettings,
): { start: number; end: number } {
	const seq = doc.sequences[sequenceId]!;
	let end = 0;
	for (const c of Object.values(seq.clips)) end = Math.max(end, c.start + c.duration);
	let r: { start: number; end: number };
	switch (settings.range.type) {
		case 'in-out':
			r = { start: seq.inPoint ?? 0, end: seq.outPoint ?? end };
			break;
		case 'work-area':
			r = seq.workArea ? { start: seq.workArea.start, end: seq.workArea.end } : { start: 0, end };
			break;
		case 'custom':
			r = { start: settings.range.startFrame, end: settings.range.endFrame };
			break;
		default:
			r = { start: 0, end };
	}
	if (!(r.end > r.start)) throw new PlanError('VALIDATION_FAILED', 400, 'The export range is empty');
	return r;
}

/** Deterministic plan id over revision, document content, settings and capabilities (S04:RP-011). */
function planIdOf(parts: unknown): string {
	return `pln_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)}`;
}

export type PlanInput = {
	envelope: { revision: number; document: unknown };
	sequenceId: string;
	settings: ExportSettings;
	/** Force a range (stills: one frame). */
	rangeOverride?: { start: number; end: number };
	/** Single PNG frame: no video encoder needed. */
	still?: boolean;
};

export type PlanDeps = {
	registry: MediaRegistry;
	fonts: FontCatalogService;
	capabilities: PlanCapabilities;
	/** Encoder selection (D-13); absent = libx264 (unit tests of the planner alone). */
	selectEncoder?: (req: EncoderRequest) => EncoderChoice | null;
	/** LGPL-only mode: never fall back to an encoder inside Remotion's bundled (GPL) ffmpeg. */
	lgplOnly?: boolean;
};

export async function planExport(input: PlanInput, deps: PlanDeps): Promise<PlannedExport> {
	let document: ProjectDocument;
	try {
		const loaded = loadProject(input.envelope);
		document = loaded.document;
	} catch (e) {
		throw new PlanError('VALIDATION_FAILED', 400, `Invalid project: ${(e as Error).message}`);
	}
	const seq = document.sequences[input.sequenceId];
	if (!seq) throw new PlanError('NOT_FOUND', 404, `Sequence ${input.sequenceId} not found`);
	const settings = input.settings;
	const range = input.rangeOverride ?? exportRange(document, input.sequenceId, settings);

	// ---- media resolution (engine-store keys only: never trust path locators from a client, S04:SC-003)
	const media: Record<string, LocalMedia> = {};
	const offline: string[] = [];
	for (const asset of Object.values(document.media)) {
		const key = mediaKeyOf(asset);
		const record = key ? deps.registry.get(key) : null;
		const path = record ? await deps.registry.resolvePath(record.mediaKey) : null;
		if (record && path) media[asset.id] = { path, record };
		else offline.push(asset.id);
	}
	const fontFallbacks = new Set<string>();
	const snapshot = buildRenderSnapshot(document, input.sequenceId, {
		range,
		resolveMedia: (asset): MediaHandle | null => {
			const m = media[asset.id];
			if (!m) return null;
			return localHandle(asset, m);
		},
		resolveFont: (font, weight, italic) => {
			const r = deps.fonts.resolve(font.family, weight, italic);
			if (r?.fallback) fontFallbacks.add(font.id);
			return r?.url ?? null;
		},
	});

	// ---- classification
	const blockers: RenderPlan['blockers'] = [];
	const warnings: RenderPlan['warnings'] = [];
	const visual = snapshot.videoTracks.flatMap((t) => t.clips);
	const mgClips: string[] = [];
	for (const c of visual) {
		for (const reason of nativeBlockers(c, deps.capabilities))
			blockers.push({ itemId: c.clipId, path: 'native', reason });
		if (c.kind === 'motion-graphic') mgClips.push(c.clipId);
		// Alpha WebM needs the libvpx decoder on the native path (Remotion decodes it in the browser).
		const dec = 'mediaId' in c.source ? alphaDecoder(media[c.source.mediaId]?.record.probe) : null;
		if (dec && deps.capabilities.decoders && !deps.capabilities.decoders.includes(dec))
			blockers.push({
				itemId: c.clipId,
				path: 'native',
				reason: `${c.kind} clip "${c.name}" has an alpha channel that needs the ${dec} decoder, which this ffmpeg build lacks`,
			});
	}
	for (const a of snapshot.audioClips) {
		const why: string[] = [];
		if (!staticOk(a.volumeDb) || !staticOk(a.pan) || !staticOk(a.track.volumeDb) || !staticOk(a.track.pan))
			why.push('animated audio levels are not supported by the native path in M1');
		if (a.pan.value !== 0 || a.track.pan.value !== 0)
			why.push('audio pan is not supported by the native path in M1');
		if (a.effects.some((fx) => fx.enabled)) why.push('audio effects require the Remotion path in M1');
		if (a.speed.reverse) why.push('reversed audio is not supported by the native path');
		for (const reason of why) blockers.push({ itemId: a.clipId, path: 'native', reason });
	}
	if (!staticOk(snapshot.master.volumeDb))
		blockers.push({ path: 'native', reason: 'animated master volume' });
	const video0 = settings.video;
	const encoder = deps.selectEncoder
		? deps.selectEncoder({
				purpose: 'export',
				codec: video0?.codec ?? 'h264',
				...(video0?.encoder ? { encoder: video0.encoder } : {}),
			})
		: LEGACY_X264_CHOICE;
	if (!deps.capabilities.native)
		blockers.push({ path: 'native', reason: 'ffmpeg (with a video encoder and aac) is not available' });
	else if (!encoder && !input.still)
		blockers.push({
			path: 'native',
			reason: 'no usable video encoder (H.264, AV1 or VP9) in this ffmpeg build',
		});

	// ---- warnings
	const offlineUsed = new Set<string>();
	for (const c of visual)
		if ('mediaId' in c.source && snapshot.media[c.source.mediaId] === null) offlineUsed.add(c.clipId);
	for (const a of snapshot.audioClips) if (snapshot.media[a.mediaId] === null) offlineUsed.add(a.clipId);
	if (offlineUsed.size > 0) {
		warnings.push({
			code: 'OFFLINE_MEDIA',
			message: `${offlineUsed.size} clip(s) use offline media and render as "Media Offline"`,
			itemIds: [...offlineUsed],
		});
	}
	const vfr = new Set<string>();
	for (const c of visual) {
		if ('mediaId' in c.source && media[c.source.mediaId]?.record.probe.variableFrameRate) vfr.add(c.clipId);
	}
	if (vfr.size > 0) {
		warnings.push({
			code: 'VFR_SOURCE',
			message: 'Variable-frame-rate sources are conformed to the sequence frame rate',
			itemIds: [...vfr],
		});
	}
	if (fontFallbacks.size > 0) {
		const ids = visual
			.filter((c) => c.kind === 'text' && 'text' in c.source && fontFallbacks.has(c.source.text.style.fontId))
			.map((c) => c.clipId);
		warnings.push({
			code: 'FONT_FALLBACK',
			message: 'Some fonts are not bundled; the default family is used instead',
			itemIds: ids,
		});
	}
	for (const w of snapshot.warnings) warnings.push({ code: w.code, message: w.message, itemIds: [w.clipId] });
	if (encoder?.message) warnings.push({ code: 'ENCODER_FALLBACK', message: encoder.message });

	// ---- output spec
	const seqFps = seq.settings.frameRate;
	const video = settings.video;
	const outFps = video?.frameRate ?? seqFps;
	const durationSec = ((range.end - range.start) * seqFps.den) / seqFps.num;
	const output: OutputSpec = {
		width: video?.width ?? seq.settings.width,
		height: video?.height ?? seq.settings.height,
		fps: { num: outFps.num, den: outFps.den },
		frames: rationalEquals(outFps, seqFps)
			? range.end - range.start
			: Math.max(1, Math.round((durationSec * outFps.num) / outFps.den)),
		durationSec,
		scaling: video?.scaling ?? 'fit',
		crf: video?.quality.value ?? 18,
		x264Preset:
			video?.encoderSpeed === 'fast' ? 'veryfast' : video?.encoderSpeed === 'best' ? 'slow' : 'medium',
		speed: video?.encoderSpeed ?? 'balanced',
		encoder,
		audioChannels: settings.audio?.channels ?? 2,
		audioBitrateKbps: settings.audio?.bitrateKbps ?? 192,
	};
	if (!rationalEquals(outFps, seqFps)) {
		warnings.push({
			code: 'FRAME_RATE_CONVERSION',
			message: `Export frame rate ${fpsNum(outFps).toFixed(3)} differs from the sequence (${fpsNum(seqFps).toFixed(3)}); frames are sampled nearest-frame and motion may judder`,
		});
	}

	// ---- path choice (S04:RP-001, RP-012)
	const nativeEligible = blockers.length === 0;
	let path: 'native' | 'remotion';
	if (settings.engine === 'native') {
		if (!nativeEligible) {
			throw new PlanError('PATH_NOT_ELIGIBLE', 409, 'The native path cannot render this sequence', {
				blockers,
			});
		}
		path = 'native';
	} else if (settings.engine === 'remotion') {
		if (deps.capabilities.remotionLocal === 'unavailable') {
			throw new PlanError('PATH_NOT_ELIGIBLE', 409, 'Remotion rendering is unavailable on this engine', {
				blockers: [{ path: 'hybrid', reason: 'Remotion renderer or compositions bundle missing' }],
			});
		}
		path = 'remotion';
	} else path = nativeEligible ? 'native' : 'remotion';

	if (path === 'remotion') {
		if (!encoder && deps.lgplOnly && !input.still) {
			throw new PlanError(
				'ENCODER_UNAVAILABLE',
				409,
				'No LGPL-compatible video encoder is available for the Remotion path',
			);
		}
		if (deps.capabilities.remotionLocal === 'unavailable')
			warnings.push({
				code: 'REMOTION_UNAVAILABLE',
				message: 'Remotion rendering is unavailable on this engine',
			});
		else if (deps.capabilities.remotionLocal === 'needs-browser-download')
			warnings.push({
				code: 'BROWSER_DOWNLOAD',
				message: 'The first Remotion render downloads a headless browser',
			});
		if (!rationalEquals(outFps, seqFps)) {
			output.fps = { ...seqFps };
			output.frames = range.end - range.start;
			warnings.push({
				code: 'FRAME_RATE_IGNORED',
				message: 'The Remotion path renders at the sequence frame rate in M1',
			});
		}
		const seqAspect = seq.settings.width / seq.settings.height;
		if (Math.abs(output.width / output.height - seqAspect) > 0.01) {
			output.width = seq.settings.width;
			output.height = seq.settings.height;
			warnings.push({
				code: 'SIZE_IGNORED',
				message: 'The Remotion path keeps the sequence aspect ratio in M1',
			});
		}
	}

	const frames = range.end - range.start;
	const pixels = output.width * output.height;
	const estimateSeconds =
		path === 'native'
			? (durationSec / 1.5) * Math.max(0.25, pixels / (1920 * 1080))
			: (frames / 8) * Math.max(0.25, pixels / (1920 * 1080));
	const bpp = 0.1 * 2 ** ((18 - output.crf) / 6);
	const estimateBytes = Math.round(
		(pixels * fpsNum(output.fps) * durationSec * bpp) / 8 +
			(output.audioBitrateKbps * 1000 * durationSec) / 8,
	);

	const graphicsGroups: RenderPlan['segments'][number]['graphicsGroups'] =
		path === 'remotion'
			? [{ id: 'g1', engine: 'remotion', itemIds: visual.map((c) => c.clipId) }]
			: mgClips.map((id, i) => ({ id: `mg${i + 1}`, engine: 'fframes' as const, itemIds: [id] }));
	const documentRevision = input.envelope.revision;
	const planId = planIdOf({
		documentRevision,
		doc: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
		sequenceId: input.sequenceId,
		settings,
		caps: deps.capabilities,
		encoder: encoder?.encoder ?? null,
		range,
	});
	const plan: PlannedExport['plan'] = {
		planId,
		documentRevision,
		path,
		segments: [
			{
				startFrame: range.start,
				endFrame: range.end,
				mode: path === 'remotion' ? 'remotion' : mgClips.length > 0 ? 'mixed' : 'native',
				graphicsGroups,
			},
		],
		audio: { mode: path === 'remotion' ? 'remotion' : 'native-mix' },
		blockers,
		warnings,
		estimate: { seconds: Math.round(estimateSeconds * 10) / 10, bytes: Math.max(0, estimateBytes) },
		...(encoder ? { encoder } : {}),
	};
	return { plan, document, sequenceId: input.sequenceId, range, snapshot, media, output };
}

function localHandle(asset: MediaAsset, m: LocalMedia): MediaHandle {
	const r = m.record;
	return {
		url: m.path,
		proxyUrl: null,
		kind: asset.kind,
		width: r.display?.width ?? null,
		height: r.display?.height ?? null,
		durationFlicks: r.probe.durationFlicks,
		hasAudio: r.hasAudio,
		rotation: r.probe.rotationDegrees,
		...mediaDecodeHints(r.probe),
	};
}

/** Reasons a visual layer cannot go through the native builder (S04:RN-020, ARCHITECTURE §9.5). */
export function nativeBlockers(c: RenderVisualClip, caps: PlanCapabilities): string[] {
	const out: string[] = [];
	const label = `${c.kind} clip "${c.name}"`;
	if (!NATIVE_VISUAL_KINDS.has(c.kind)) {
		out.push(
			c.kind === 'text'
				? `text layer "${c.name}" requires graphics rendering`
				: `${label} requires graphics rendering (not a native-capable layer)`,
		);
		return out;
	}
	if (c.kind === 'motion-graphic' && !(caps.fframes === 'ready' && caps.mgMasters)) {
		out.push(`motion graphic "${c.name}" needs the fframes renderer, which is unavailable`);
	}
	// The fframes master holds exactly the clip's frames: no content for transition handles.
	if (c.kind === 'motion-graphic' && ((c.headHandle ?? 0) > 0 || (c.tailHandle ?? 0) > 0))
		out.push(`motion graphic "${c.name}" is part of a transition that needs handles`);
	const t = c.transform;
	if (
		t &&
		(!staticOk(t.position) ||
			!staticOk(t.anchor) ||
			!staticOk(t.scale) ||
			!staticOk(t.scaleWidth) ||
			!staticOk(t.rotation))
	)
		out.push(`${label} has animated Motion (keyframes), not native in M1`);
	if (!staticOk(c.opacity)) out.push(`${label} has animated opacity, not native in M1`);
	if (c.blendMode !== 'normal') out.push(`${label} uses blend mode "${c.blendMode}"`);
	if (c.speed.reverse) out.push(`${label} plays in reverse`);
	for (const fx of c.effects) {
		if (!fx.enabled) continue;
		if (!NATIVE_EFFECTS.has(fx.effectId)) out.push(`${label} uses effect ${fx.effectId}, not native in M1`);
		else if (Object.values(fx.params).some((p) => isAnimated(p)))
			out.push(`${label} has an animated ${fx.effectId}`);
	}
	return out;
}
