// Export planner (ARCHITECTURE §9.5, S04 §11): builds the render snapshot with engine-local media,
// classifies every layer for the native path and returns an S04:RP-010 RenderPlan with per-clip blockers
// (RP-008) and warnings (offline media, VFR sources, missing fonts). Paths: `native` | `remotion`, and M2
// `hybrid` = the native composite with layers an extension baked (S11:LBK-002).

import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import type { EncoderChoice, ExportSettings, RenderPlan } from '@jasper/api';
import { installAudioFxProcessors } from '@jasper/audio-fx';
import { mgRegistry } from '@jasper/mg-templates';
import {
	advanced3dLimitWarnings,
	blendModeInfo,
	buildRenderSnapshot,
	clipContentTime,
	collectParamMediaIds,
	defaultEffectRegistry,
	type EffectRegistry,
	effectMediaRefs,
	hasAudioProcessor,
	hasEffectMasks,
	isAnimated,
	loadProject,
	type MediaAsset,
	type MediaHandle,
	maskExportRoute,
	mediaDecodeHints,
	missing3dAssets,
	type PixelInterpretation,
	type ProjectDocument,
	pixelInterpretation,
	proxyKeyOf,
	type Rational,
	type RenderSnapshot,
	type RenderVisualClip,
	ROTO_OBJECT_PARAMS,
	rationalEquals,
	resolveLayerProps,
	rotoExportIssues,
	type SnapshotOptions,
	sequenceFormatOf,
	snapshotGlNeeds,
	THREE_D_ASSET_MISSING,
	trackMatteTracksOf,
	transitionSpec,
	uncoveredPicture,
	warpExportIssues,
} from '@jasper/project';
import { codecHeadroomDb } from '../audio/deliver.ts';
import { pitchEngineWarnings } from '../audio/rubberband.ts';
import { lutRefs } from '../color/extension.ts';
import { type ExportColor, ExportColorError, exportColorOf } from '../color/output.ts';
import type { FontCatalogService } from '../fonts/catalog.ts';
import { layerStill } from '../layer-bake/layer.ts';
import { alphaDecoder } from '../media/alpha.ts';
import type { MediaRecord, MediaRegistry } from '../media/registry.ts';
// wp-m2-anime-templates (S11:ATP-002/008/010)
import {
	missingTemplates,
	missingTemplatesDetail,
	missingTemplatesMessage,
	TEMPLATE_NOT_INSTALLED,
} from '../mg/templates.ts';
// social-comment §7.8: template fonts / emoji (bundled or remote), downloaded before rendering or blocking by name
import {
	checkTemplateAssets,
	engineTemplateAssets,
	TEMPLATE_ASSETS_UNAVAILABLE,
	templateAssetsMessage,
} from '../remote-assets/plan.ts';
import { type WebglStatus, webglRefusal } from '../remotion/webgl-refusal.ts';
import {
	type EncoderRequest,
	fitOutputFormat,
	LEGACY_X264_CHOICE,
	outputFormatChanges,
} from '../tools/encoders.ts';
import {
	adjustmentPlanRefusal,
	isKernelAdjustment,
	isKernelEffect,
	kernelAdjustmentRefusals,
} from './blend/adjust.ts';
import { CaptionExportError, captionBurnMode, captionPlanWarnings } from './captions.ts';
import {
	type AudioOnlySpec,
	audioOnlyBytes,
	type Deliverable,
	DeliverableError,
	deliverableOf,
	type GifSpec,
	gifBytes,
	gifFrames,
	pcmEncoderOf,
} from './deliverables.ts';
import { layerRouteOf } from './layer-routes.ts';
import { describeUse, offlineUsesOf } from './media-guard.ts';
import {
	bakeRecipeOf,
	compositeMemoryBlocker,
	compositeMemoryBudget,
	compositeProfile,
	estimateFrom,
} from './memory.ts';
import { BUILTIN_NATIVE_EFFECTS, type NativeExtension } from './native-ext.ts';
import { blockerSpans, remotionItems, spanList, spanRuns } from './routing.ts';
import { planPictureSegments, segmentPolicyFromEnv } from './segments.ts';
import { soundPlanWarnings } from './sound-credits.ts';
import { needsSubpixel } from './stream/plan.ts';

// audio-fx: the audio effect processors (clip effects and track / submix / Mix inserts) for the offline mixer.
installAudioFxProcessors();

export type PlanCapabilities = {
	/** ffmpeg + encoders present (self-check). */
	native: boolean;
	remotionLocal: 'ready' | 'needs-browser-download' | 'unavailable';
	fframes: 'ready' | 'unavailable';
	/** WP-2G registered an mgMasterProvider. */
	mgMasters: boolean;
	/** `ffmpeg -decoders` of the engine's build; absent = unknown (assume the usual decoders exist). */
	decoders?: readonly string[];
	/**
	 * TL-124: WebGL2 of the render browser (and whether it has float render targets). The Remotion service probes once
	 * and caches the answer; the planner awaits it only when a part drawn by the browser needs WebGL2. Absent =
	 * unknown (nothing is refused; the render decides).
	 */
	webgl?: () => Promise<WebglStatus>;
	/** The probe's answer so far, without waiting for it (`unknown` until it finished; the engine probes at start-up). */
	webglKnown?: () => WebglStatus;
};

/** Largest frame side any path renders (16K). */
export const MAX_FRAME_SIDE = 16384;

/** Refuses frame sizes no path can render (`VALIDATION_FAILED`, naming what is too large). */
export function assertFrameSize(what: string, width: unknown, height: unknown): void {
	const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_FRAME_SIDE;
	if (!ok(width) || !ok(height))
		throw new PlanError(
			'VALIDATION_FAILED',
			400,
			`${what} has a frame size of ${String(width)}×${String(height)}; frames are at most ${MAX_FRAME_SIDE} px wide and high`,
		);
}

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

// edit-structure: nest clips draw their nested stack in the same graph; adjustment layers process the composite.
const NATIVE_VISUAL_KINDS = new Set([
	'video',
	'still',
	'solid',
	'motion-graphic',
	'nest-video',
	'adjustment',
]);

export type OutputSpec = {
	/**
	 * routing.ts layer routes: the picture as lossless 8-bit RGB PNG frames (`outputFile` is an image2 pattern, frame 0 =
	 * the range's first frame) in the working colour space, without the output conversion — a plate the Remotion pass
	 * draws under an adjustment layer. Plain Rec.709 only (the planner routes nothing else per layer).
	 */
	pngFrames?: boolean;
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
	/** audio-mix: 1, 2 or 6 (discrete 5.1). */
	audioChannels: 1 | 2 | 6;
	audioBitrateKbps: number;
	/** audio-mix: delivered sample rate (the mix runs at the sequence rate and is resampled with SoX when different). */
	audioSampleRate: number;
	/** audio-mix: PCM requested (MOV) at these bits per sample (32 = float); absent = not requested. */
	audioPcm?: 16 | 24 | 32;
	/** audio-mix: two-pass loudness normalisation of the final mix. */
	normalize: { targetLufs: number; truePeakDb: number } | null;
	/** Average video bitrate override (see ExportSettings `video.bitrateKbps`). */
	bitrateKbps?: number;
	/** ProRes profile of a `prores` export. */
	proresProfile?: 'hq' | '4444';
	/** wp interchange: straight-alpha ProRes 4444 on a transparent background, no audio (Remotion path). */
	alpha?: boolean;
	/** previews: no audio stream (`ExportSettings.videoOnly`). */
	videoOnly?: boolean;
	/** gaps (Sequence Settings ▸ Pixel Aspect Ratio): the pixel aspect ratio signalled in the file (absent = square). */
	pixelAspect?: Rational;
	/** previews: frames between keyframes (`video.keyframeInterval`); absent = the encoder default. */
	gop?: number;
	/**
	 * Smart rendering: the encoded pieces are joined with copied GOPs as one raw H.264 stream, which keeps no
	 * timestamps — they must not use B-frames (set by the engine, never by a request).
	 */
	noBFrames?: boolean;
	/** color-mgmt: the colour space, tags, bit depth and HDR metadata written (absent = 8-bit BT.709 SDR). */
	color?: ExportColor;
	/** spec 18 AF-EXP-002: the audio encoder of an audio-only file (`pcm_s16le`, `pcm_s24le`, `pcm_f32le`, `flac`, `aac`). */
	audioCodec?: string;
	/** spec 18 AF-EXP-002: bits per sample of a FLAC file. */
	audioBits?: 16 | 24;
};

export type LocalMedia = {
	path: string;
	record: MediaRecord;
	/** imports (Interpret Footage): the asset's pixel interpretation (deinterlace, alpha), applied by every decoder. */
	pixel?: PixelInterpretation | null;
	/**
	 * imports: a picture to decode instead of the file (set by the `imports` extension's `prepare`: the composite of a
	 * Photoshop document, its pixel interpretation already applied).
	 */
	display?: string;
};

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
	/** wp captions: caption tracks burned in (snapshot option) and the caption output settings. */
	captions?: SnapshotOptions['captions'];
	captionSettings?: ExportSettings['captions'];
	/** previews (smart rendering): the stream-copied and rendered pieces of the range. */
	smart?: { codec: import('./smart.ts').SmartCodec; pieces: import('./smart.ts').SmartPiece[] };
	/** previews (Use Previews): the stretches of the range read from render previews, and those rendered. */
	previews?: import('./use-previews.ts').ExportRun[];
	/**
	 * routing.ts: the pieces of an `auto` export routed per span (native / hybrid stretches and `engine: 'remotion'`
	 * ones), joined frame-exactly (service.ts `renderRoutes`). Absent = one path for the range.
	 */
	routes?: import('./use-previews.ts').ExportRun[];
	/**
	 * ranges.ts: the ranges of a multi-range export in file order, each with its own plan's snapshot. `range` is then
	 * their span and `snapshot` the first range's.
	 */
	joined?: import('./ranges.ts').JoinedPart[];
	/**
	 * output-size.ts: the size the native composite is drawn at, decided before the extensions prepare (the layer bake
	 * renders masters at it and aligns rectangles to whole output pixels). Absent = the sequence size.
	 */
	composite?: import('./output-size.ts').CompositeSizePlan;
	/** gaps (`draftUseProxies`): media rendered from their attached proxies (draft exports only). */
	draftProxies?: string[];
	/**
	 * spec 18 AF-EXP: a GIF (the plan renders its ProRes intermediate; the service converts it) or an audio-only file
	 * (the mixdown alone). Absent = a video file.
	 */
	deliverable?:
		| {
				kind: 'gif';
				gif: GifSpec;
				/** The settings of the picture intermediate (what the render paths and their fallbacks plan). */
				render: ExportSettings;
		  }
		| { kind: 'audio'; audio: AudioOnlySpec };
};

/** The engine media key of an asset (engine-store locator), or null. */
export function mediaKeyOf(asset: Pick<MediaAsset, 'locators'>): string | null {
	for (const l of asset.locators) if (l.type === 'engine-store') return l.key;
	return null;
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
		case 'ranges':
			// ExportService.plan plans each range as a `custom` export and joins the plans (ranges.ts)
			throw new PlanError('VALIDATION_FAILED', 400, 'A multi-range export is planned one range at a time');
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

type PlanInput = {
	envelope: { revision: number; document: unknown };
	sequenceId: string;
	settings: ExportSettings;
	/** Force a range (stills: one frame). */
	rangeOverride?: { start: number; end: number };
	/** Single PNG frame: no video encoder needed. */
	still?: boolean;
};

type PlanDeps = {
	registry: MediaRegistry;
	fonts: FontCatalogService;
	capabilities: PlanCapabilities;
	/** Encoder selection (D-13); absent = libx264 (unit tests of the planner alone). */
	selectEncoder?: (req: EncoderRequest) => EncoderChoice | null;
	/** LGPL-only mode: never fall back to an encoder inside Remotion's bundled (GPL) ffmpeg. */
	lgplOnly?: boolean;
	/** M2 native extensions (ARCHITECTURE §19.6), consulted by `nativeBlockers`. */
	extensions?: readonly NativeExtension[];
	/** Effect registry for extension effect lookups (default: the built-in registry). */
	effects?: EffectRegistry;
	/** parity (roto): frames a matte set holds on this engine (null = gone, e.g. cleaned from the cache). */
	rotoSet?: (key: string) => Promise<{ start: number; end: number } | null>;
	/** spec 13 AS-074: memory the native composite may use (bytes); default `compositeMemoryBudget()`. */
	memoryBudget?: number;
};

/** Font ids a text or captions layer draws with: its style, styled runs and Source Text keys. */
function clipFontIds(c: RenderVisualClip): string[] {
	if ('captions' in c.source) return [c.source.captions.style.fontId];
	if (c.kind !== 'text' || !('text' in c.source)) return [];
	const t = c.source.text as {
		style: { fontId: string };
		runs?: { style?: { fontId?: string } }[];
	};
	const keys = (
		c.source as {
			sourceTextKeyframes?: {
				value?: { style?: { fontId?: string }; runs?: { style?: { fontId?: string } }[] };
			}[];
		}
	).sourceTextKeyframes;
	const out = [t.style.fontId];
	for (const ct of [t, ...(keys ?? []).map((k) => k.value)]) {
		if (ct?.style?.fontId) out.push(ct.style.fontId);
		for (const r of ct?.runs ?? []) if (r.style?.fontId) out.push(r.style.fontId);
	}
	return out;
}

/** color-mgmt: the (nested) sequences of a snapshot that blend in linear light ('' = the exported one). */
function linearBlendSequences(snap: RenderSnapshot, name = ''): string[] {
	const out = snap.settings.color?.blendLinear ? [name] : [];
	for (const t of snap.videoTracks)
		for (const c of t.clips)
			if ('nest' in c.source) out.push(...linearBlendSequences(c.source.nest.snapshot, c.name));
	return out;
}

export async function planExport(input: PlanInput, deps: PlanDeps): Promise<PlannedExport> {
	let document: ProjectDocument;
	try {
		const loaded = loadProject(input.envelope, { mgTemplates: mgRegistry });
		document = loaded.document;
	} catch (e) {
		throw new PlanError('VALIDATION_FAILED', 400, `Invalid project: ${(e as Error).message}`);
	}
	const seq = document.sequences[input.sequenceId];
	if (!seq) throw new PlanError('NOT_FOUND', 404, `Sequence ${input.sequenceId} not found`);
	// spec 18 AF-EXP: a GIF is planned as its picture intermediate (`deliverable.render`); an audio-only file plans the
	// mix alone (`planAudioOnly`). The plan id stays over the requested settings.
	const requested = input.settings;
	let deliverable: Deliverable = { kind: 'video' };
	if (!input.still)
		try {
			deliverable = deliverableOf(requested, {
				width: seq.settings.width,
				height: seq.settings.height,
				frameRate: seq.settings.frameRate,
			});
		} catch (e) {
			if (e instanceof DeliverableError) throw new PlanError('VALIDATION_FAILED', 400, e.message);
			throw e;
		}
	const settings = deliverable.kind === 'gif' ? deliverable.render : requested;
	const range = input.rangeOverride ?? exportRange(document, input.sequenceId, settings);

	// Resolve engine-store keys only; client path locators are untrusted.
	const media: Record<string, LocalMedia> = {};
	// Exports use the full-resolution media; `draftUseProxies` (asked for explicitly) decodes attached
	// proxies instead, scaled to the original's frame size (the layout keeps the original's dimensions).
	const draftProxies: string[] = [];
	const proxiesOffline: string[] = [];
	for (const asset of Object.values(document.media)) {
		const key = mediaKeyOf(asset);
		const record = key ? deps.registry.get(key) : null;
		const path = record ? await deps.registry.resolvePath(record.mediaKey) : null;
		if (record && path) {
			const pk = settings.draftUseProxies ? proxyKeyOf(asset) : null;
			const proxyRecord = pk ? deps.registry.get(pk) : null;
			const proxyPath = proxyRecord ? await deps.registry.resolvePath(proxyRecord.mediaKey) : null;
			if (proxyRecord && proxyPath) {
				media[asset.id] = {
					path: proxyPath,
					record: { ...proxyRecord, display: record.display },
					pixel: pixelInterpretation(asset),
				};
				draftProxies.push(asset.id);
			} else {
				if (pk) proxiesOffline.push(asset.id);
				media[asset.id] = { path, record, pixel: pixelInterpretation(asset) };
			}
		}
	}
	/** Fonts not in the catalog (bundled families or the user font library) → their family, FONT_FALLBACK. */
	const fontFallbacks = new Map<string, string>();
	let captionWarnings: RenderPlan['warnings'] = [];
	try {
		captionWarnings = captionPlanWarnings(document, seq, settings, range);
	} catch (e) {
		if (e instanceof CaptionExportError) throw new PlanError('VALIDATION_FAILED', 400, e.message);
		throw e;
	}
	const snapshot = buildRenderSnapshot(document, input.sequenceId, {
		captions: captionBurnMode(settings),
		range,
		resolveMedia: (asset): MediaHandle | null => {
			const m = media[asset.id];
			if (!m) return null;
			return localHandle(asset, m);
		},
		resolveFont: (font, weight, italic) => {
			const r = deps.fonts.resolve(font.family, weight, italic);
			if (r?.fallback) fontFallbacks.set(font.id, font.family);
			return r?.url ?? null;
		},
		templateAssets: engineTemplateAssets(deps.fonts),
	});
	if (deliverable.kind === 'audio') {
		refuseOfflineMedia(snapshot, document, { picture: false, sound: true });
		return planAudioOnly({
			input,
			deps,
			document,
			seq,
			range,
			snapshot,
			media,
			draftProxies,
			proxiesOffline,
			captionWarnings,
			spec: deliverable.audio,
		});
	}

	// Frame buffers are sized by these numbers (`width × height × 4` per layer in the
	// compositing kernels and in ffmpeg). Commands keep sequences within 8192 px; a hostile document or request is
	// refused by name before anything is allocated.
	assertFrameSize('The sequence', seq.settings.width, seq.settings.height);
	if (settings.video?.width !== undefined || settings.video?.height !== undefined)
		assertFrameSize(
			'The export',
			settings.video.width ?? seq.settings.width,
			settings.video.height ?? seq.settings.height,
		);
	for (const c of allVisualClips(snapshot))
		if ('nest' in c.source) {
			const n = c.source.nest.snapshot.settings;
			assertFrameSize(`The nested sequence of clip "${c.name}"`, n.width, n.height);
		}

	// Missing templates block every path so exports cannot contain their preview placeholder cards.
	const missing = missingTemplates(snapshot);
	if (missing.length > 0)
		throw new PlanError(
			TEMPLATE_NOT_INSTALLED,
			409,
			missingTemplatesMessage(missing),
			missingTemplatesDetail(missing),
		);
	// Template fonts and emoji block every path too: the preview's marker card must never be exported, and a host
	// font never stands in for a template's (downloads happen here, before anything renders).
	{
		const clips = allVisualClips(snapshot);
		const issues = await checkTemplateAssets(snapshot, clips, deps.fonts);
		if (issues.length > 0)
			throw new PlanError(TEMPLATE_ASSETS_UNAVAILABLE, 409, templateAssetsMessage(issues, clips), {
				assets: issues,
			});
	}
	// AGENTS §4: content an extension provides that is missing on this engine (a composition clip's bundle or
	// composition) blocks every path, Remotion included: no export or still may contain the preview's offline card.
	{
		const refused = unresolvedClips(allVisualClips(snapshot), deps.extensions ?? []);
		if (refused.length > 0)
			throw new PlanError(
				refused[0]!.code,
				409,
				`Clips cannot be drawn on any path: ${refused
					.slice(0, 5)
					.map((r) => r.reason)
					.join('; ')}${refused.length > 5 ? ` and ${refused.length - 5} more` : ''}`,
				{
					blockers: refused.map((r) => ({ itemId: r.clipId, path: 'native' as const, reason: r.reason })),
					hint: [...new Set(refused.map((r) => r.hint))].join(' '),
				},
			);
	}
	const blockers: RenderPlan['blockers'] = [];
	const warnings: RenderPlan['warnings'] = [];
	{
		const f = sequenceFormatOf(seq.settings);
		if (f.fieldOrder !== 'progressive' && !settings.videoOnly && !input.still)
			warnings.push({
				code: 'FIELDS_PROGRESSIVE',
				message: `The sequence is ${f.fieldOrder} field first; exports are progressive (field-rendered interlaced output is not available)`,
			});
	}
	// frames with no picture on any video track while audio plays export black (a hole left by a lift or a trim)
	if (!input.still && !settings.video?.alpha) {
		const holes = uncoveredPicture(document, seq, range).filter((r) => r.audible);
		if (holes.length) {
			const n = holes.reduce((t, r) => t + r.end - r.start, 0);
			const list = holes.slice(0, 5).map((r) => `${r.start}–${r.end}`);
			warnings.push({
				code: 'UNCOVERED_VIDEO',
				message: `${n} frame${n === 1 ? ' has' : 's have'} no picture on any video track while audio plays (frames ${list.join(', ')}${holes.length > 5 ? ` and ${holes.length - 5} more ranges` : ''}): they export black. Extend a neighbouring video clip over them, or ask the user`,
			});
		}
	}
	// spec 12 §2.11: sounds heard that need a credit without a credits sidecar; a stale / failed Sound Check (info).
	warnings.push(
		...soundPlanWarnings(document, input.sequenceId, snapshot, settings, input.still ? { still: true } : {}),
	);
	// Pitch Shifters set to Rubber Band R3 render with Signalsmith where its module is missing (never silently).
	if (!input.still && !settings.videoOnly) warnings.push(...pitchEngineWarnings(snapshot));
	if (draftProxies.length)
		warnings.push({
			code: 'DRAFT_PROXIES',
			message: `${draftProxies.length} media render from their proxies (Use Proxies: a draft, not full resolution)`,
			itemIds: draftProxies,
		});
	if (proxiesOffline.length)
		warnings.push({
			code: 'PROXY_OFFLINE',
			message: `${proxiesOffline.length} proxies are offline: those media render at full resolution`,
			itemIds: proxiesOffline,
		});
	{
		const issues = warpExportIssues(snapshot);
		const missing = issues.filter((i) => i.kind === 'not-analyzed');
		if (missing.length)
			throw new PlanError('WARP_NOT_ANALYZED', 409, missing.map((i) => i.message).join('; '), {
				clipIds: missing.map((i) => i.clipId),
			});
		for (const i of issues) warnings.push({ code: 'WARP_PARTIAL', message: i.message, itemIds: [i.clipId] });
	}
	// Missing matte frames block every path because exporting them would silently remove the matte.
	{
		const issues = rotoExportIssues(snapshot);
		const missing = issues.filter((i) => i.kind === 'not-computed');
		if (missing.length)
			throw new PlanError('ROTO_NOT_COMPUTED', 409, missing.map((i) => i.message).join('; '), {
				rotos: missing.map(({ clipId, rotoId, frames }) => ({ clipId, rotoId, frames })),
			});
		for (const i of issues) warnings.push({ code: 'ROTO_STALE', message: i.message, itemIds: [i.clipId] });
		if (deps.rotoSet)
			for (const c of allVisualClips(snapshot))
				for (const [id, m] of Object.entries(c.rotos ?? {})) {
					if (!m.key) continue;
					if (
						!c.effects.some(
							(fx) =>
								fx.enabled && (ROTO_OBJECT_PARAMS[fx.effectId] ?? []).some((n) => fx.params[n]?.value === id),
						)
					)
						continue;
					const have = await deps.rotoSet(m.key);
					if (!have || have.start > m.start || have.end < m.end)
						throw new PlanError(
							'ROTO_MATTES_MISSING',
							409,
							`The computed mattes of roto "${m.name}" (clip "${c.name}") are no longer on this engine (cleaned from the media cache or computed elsewhere): propagate it again`,
							{ clipId: c.clipId, rotoId: id },
						);
				}
	}
	// edit-structure: the clips of nested sequences are drawn natively too (in the same graph): they are classified
	// with the sequence's own clips.
	const visual = allVisualClips(snapshot);
	const mgClips: string[] = [];
	// M2 (S11:LBK-002, wp-m2-layer-bake): layers an extension pre-renders with a graphics engine (DOM layers baked
	// through Remotion) — listed as graphics groups; the native path is then `hybrid`.
	const baked: { clipId: string; engine: 'remotion'; frames: number; still?: boolean }[] = [];
	for (const reason of nestBlockers(snapshot))
		blockers.push({ path: 'native', reason: reason.reason, itemId: reason.clipId });
	// color-mgmt: linear-light compositing (Blend using 1.0 gamma / Linearize Working Space) is drawn by the GPU
	// compositor; the native compositor blends encoded values, so it is refused (the Remotion path renders it).
	for (const where of linearBlendSequences(snapshot))
		blockers.push({
			path: 'native',
			reason: `${where ? `nested sequence of clip "${where}": ` : ''}Blend using 1.0 gamma composites in linear light on the GPU compositor (the native compositor blends encoded values)`,
		});
	for (const c of visual) {
		for (const reason of nativeBlockers(c, deps.capabilities, deps.extensions ?? [], deps.effects))
			blockers.push({ itemId: c.clipId, path: 'native', reason });
		// An effect canvas larger than the kernel draws (blend/adjust.ts).
		if (isKernelAdjustment(c) && kernelAdjustmentRefusals(c).length === 0) {
			const pad = adjustmentPlanRefusal(c, snapshot.settings.fps);
			if (pad) blockers.push({ itemId: c.clipId, path: 'native', reason: pad });
		}
		const bakeEngine = (deps.extensions ?? []).map((e) => e.bakes?.(c) ?? null).find((x) => x !== null);
		if (bakeEngine)
			baked.push({
				clipId: c.clipId,
				engine: bakeEngine,
				frames: c.duration + (c.headHandle ?? 0) + (c.tailHandle ?? 0),
				...(bakeRecipeOf(c) === 'still' ? { still: true } : {}),
			});
		else if (c.kind === 'motion-graphic' && !isAnimeTemplate(c)) mgClips.push(c.clipId);
		// Alpha WebM needs the libvpx decoder on the native path (Remotion decodes it in the browser).
		const dec = 'mediaId' in c.source ? alphaDecoder(media[c.source.mediaId]?.record.probe) : null;
		if (dec && deps.capabilities.decoders && !deps.capabilities.decoders.includes(dec))
			blockers.push({
				itemId: c.clipId,
				path: 'native',
				reason: `${c.kind} clip "${c.name}" has an alpha channel that needs the ${dec} decoder, which this ffmpeg build lacks`,
			});
	}
	// Transition framework: GPU transitions are shader stages of the compositions; the native builder renders only the
	// built-in ramps (cross dissolve, dip to black). wave1c: an extension that pre-renders the span (A + B + stage,
	// layer-bake) keeps the export native (`hybrid`): only the span is rendered by Remotion. Without one, the export
	// goes through Remotion.
	for (const track of allVideoTracks(snapshot))
		for (const t of track.transitions ?? []) {
			const engine = (deps.extensions ?? [])
				.map((e) => e.bakesTransition?.(t, track.trackId) ?? null)
				.find((x) => x !== null);
			if (engine) {
				baked.push({ clipId: t.id, engine, frames: t.duration });
				continue;
			}
			const spec = transitionSpec(t.effectId);
			blockers.push({
				itemId: t.id,
				path: 'native',
				reason: `transition "${spec?.label ?? t.effectId}" is a GPU transition and no span renderer is available (rendered by the Remotion path)`,
			});
		}
	// audio-mix: every path's audio is the offline mixer's (clip levels, pan, buses, sends, automation, 5.1,
	// normalisation), so audio never blocks a path — except effects the mixer cannot run, which block them all.
	const unrenderable = unrenderableAudioEffects(snapshot);
	if (unrenderable.length > 0)
		throw new PlanError(
			'AUDIO_EFFECT_UNSUPPORTED',
			409,
			`Audio effects without an export processor: ${[...new Set(unrenderable.map((u) => u.effectId))].join(', ')}`,
			{ effects: unrenderable },
		);
	const audioOut = audioOutputOf(seq, settings);
	const video0 = settings.video;
	// The requested container and audio codec are written where they fit the codec (WP6.5a); what does not fit is
	// reported below (OUTPUT_CONTAINER_CHANGED / AUDIO_CODEC_CHANGED), never changed silently (AGENTS §4).
	// (a video container here: an audio-only file returned above, a GIF plans its MOV intermediate; `deliverableOf`
	// refused FLAC audio in a video file)
	const want = {
		container: settings.container as 'mp4' | 'webm' | 'mov',
		...(settings.audio && !settings.videoOnly
			? { audio: settings.audio.codec as Exclude<typeof settings.audio.codec, 'flac'> }
			: {}),
	};
	const encoder = deps.selectEncoder
		? deps.selectEncoder({
				purpose: 'export',
				codec: video0?.codec ?? 'h264',
				...(video0?.encoder ? { encoder: video0.encoder } : {}),
				...want,
			})
		: { ...LEGACY_X264_CHOICE, ...fitOutputFormat('h264', 'export', true, want) };
	if (!deps.capabilities.native)
		blockers.push({ path: 'native', reason: 'ffmpeg (with a video encoder and aac) is not available' });
	else if (!encoder && !input.still)
		blockers.push({
			path: 'native',
			reason: 'no usable video encoder (H.264, AV1 or VP9) in this ffmpeg build',
		});

	// Template media params (avatars) that are offline: the template draws its placeholder there, so the export says so.
	const templateOffline = new Set<string>();
	for (const c of visual)
		if ('mg' in c.source)
			for (const id of collectParamMediaIds(c.source.mg.params))
				if (!snapshot.media[id]) templateOffline.add(c.clipId);
	if (templateOffline.size > 0)
		warnings.push({
			code: 'OFFLINE_TEMPLATE_MEDIA',
			message: `${templateOffline.size} motion graphic(s) show offline media; those pictures render as placeholders`,
			itemIds: [...templateOffline],
		});
	// Template pictures are drawn as browser images (`TemplateImage`): stills the browser cannot decode get their display
	// picture (imports extension); media no <img> can show (video, Lottie, PDF pages) block every path by name.
	const undrawable: { clipId: string; name: string; mediaId: string; what: string }[] = [];
	for (const c of visual)
		if ('mg' in c.source)
			for (const id of collectParamMediaIds(c.source.mg.params)) {
				const asset = document.media[id];
				const what = asset && snapshot.media[id] ? templatePictureProblem(asset) : null;
				if (what) undrawable.push({ clipId: c.clipId, name: c.name, mediaId: id, what });
			}
	if (undrawable.length > 0)
		throw new PlanError(
			TEMPLATE_MEDIA_UNDRAWABLE,
			409,
			`Motion graphics show media templates cannot draw: ${[...new Set(undrawable.map((u) => `${u.mediaId} (${u.what})`))].join(', ')}`,
			{
				blockers: undrawable.map((u) => ({
					itemId: u.clipId,
					path: 'native' as const,
					reason: `template picture ${u.mediaId} of clip "${u.name}" is ${u.what}; templates draw still pictures only`,
				})),
				hint: 'Pick a still picture (PNG, JPEG, WebP…) for the template param, or None.',
			},
		);
	// LUTs and custom OCIO configs used by colour steps (grades, input LUTs, OCIO interpretations) that are
	// offline: those steps are skipped (the clips render ungraded / uninterpreted there), so the export says so.
	const lutOffline = new Set<string>();
	for (const c of visual)
		for (const id of lutRefs(c)) {
			const kind = document.media[id]?.kind;
			if ((kind === 'lut' || kind === 'color-config') && !media[id]) lutOffline.add(c.clipId);
		}
	if (lutOffline.size > 0)
		warnings.push({
			code: 'LUT_OFFLINE',
			message: `${lutOffline.size} clip(s) use an offline LUT or colour config; the colour steps using it are skipped`,
			itemIds: [...lutOffline],
		});
	// VFR media are mapped by their real timestamps by the retime stage (native) and the preview
	// decoder (Remotion); only an engine without the retime stage still conforms them.
	const vfr = new Set<string>();
	for (const c of visual) {
		if (
			'mediaId' in c.source &&
			media[c.source.mediaId]?.record.probe.variableFrameRate &&
			!(deps.extensions ?? []).some((e) => e.retimes?.(c))
		)
			vfr.add(c.clipId);
	}
	if (vfr.size > 0) {
		warnings.push({
			code: 'VFR_SOURCE',
			message: 'Variable-frame-rate sources are conformed to the sequence frame rate (no retime stage)',
			itemIds: [...vfr],
		});
	}
	if (fontFallbacks.size > 0) {
		const ids = visual.filter((c) => clipFontIds(c).some((id) => fontFallbacks.has(id))).map((c) => c.clipId);
		const families = [...new Set(fontFallbacks.values())].sort();
		warnings.push({
			code: 'FONT_FALLBACK',
			message: `${families.length === 1 ? 'A font is' : 'Fonts are'} not installed: ${families.join(', ')}. The default family is used instead; install ${families.length === 1 ? 'it' : 'them'} in Preferences ▸ Fonts (Graphics ▸ Resolve Fonts…)`,
			itemIds: ids,
		});
	}
	for (const w of snapshot.warnings) warnings.push({ code: w.code, message: w.message, itemIds: [w.clipId] });
	// spec 13 SH-004: estimated text boxes export as the Program monitor shows them; the editor measures them.
	const pendingText = visual.filter((c) => 'text' in c.source && c.source.layoutPending).map((c) => c.clipId);
	if (pendingText.length)
		warnings.push({
			code: 'TEXT_LAYOUT_PENDING',
			message: `${pendingText.length === 1 ? 'A text box is' : `${pendingText.length} text boxes are`} not measured yet (made without an editor window or a render browser): boxes, anchors and backgrounds use an estimate until the project is opened in the editor`,
			itemIds: pendingText,
		});
	warnings.push(...captionWarnings);
	for (const ext of deps.extensions ?? []) {
		if (!ext.warnings) continue;
		for (const c of visual) {
			if (!ext.kinds?.has(c.kind) && !ext.claimsLayer?.(c)) continue;
			for (const w of ext.warnings(c, { fps: snapshot.settings.fps }))
				warnings.push({ code: w.code, message: w.message, itemIds: [c.clipId] });
		}
	}
	if (encoder?.message) warnings.push({ code: 'ENCODER_FALLBACK', message: encoder.message });
	if (!input.still)
		warnings.push(
			// no native encoder: only the dev-only Remotion GPL path can write, and it writes H.264 + AAC in MP4
			...outputFormatChanges(encoder ?? { codec: 'h264', container: 'mp4', audioEncoder: 'aac' }, want),
		);

	const seqFps = seq.settings.frameRate;
	const video = settings.video;
	const outFps = video?.frameRate ?? seqFps;
	const durationSec = ((range.end - range.start) * seqFps.den) / seqFps.num;
	// A non-square-pixel sequence exported at its own frame size delivers the storage width at its pixel aspect
	// ratio (the anamorphic file of a DV / HDV / DVCPRO HD sequence); another size is a square-pixel output.
	const fmt = sequenceFormatOf(seq.settings);
	const matchesSequence =
		!video ||
		(video.width === seq.settings.width && video.height === seq.settings.height) ||
		(video.width === fmt.storageWidth && video.height === fmt.height);
	// (a GIF is square-pixel: its size is the display aspect)
	const anamorphic =
		fmt.par.num !== fmt.par.den && matchesSequence && !input.still && deliverable.kind !== 'gif';
	const _interlaced =
		fmt.fieldOrder !== 'progressive' && matchesSequence && !settings.videoOnly && !input.still;
	const output: OutputSpec = {
		width: anamorphic ? fmt.storageWidth : (video?.width ?? seq.settings.width),
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
		audioChannels: audioOut.channels,
		audioBitrateKbps: settings.audio?.bitrateKbps ?? (audioOut.channels === 6 ? 384 : 192),
		audioSampleRate: audioOut.sampleRate,
		...(settings.audio?.codec === 'pcm' ? { audioPcm: settings.audio.bitDepth ?? 24 } : {}),
		normalize: audioOut.normalize,
		...(video?.bitrateKbps ? { bitrateKbps: video.bitrateKbps } : {}),
		...(video?.proresProfile ? { proresProfile: video.proresProfile } : {}),
		...(video?.alpha ? { alpha: true } : {}),
		...(settings.videoOnly ? { videoOnly: true } : {}),
		...(video?.keyframeInterval ? { gop: video.keyframeInterval } : {}),
		...(anamorphic ? { pixelAspect: { ...fmt.par } } : {}),
	};
	if (anamorphic) output.scaling = 'stretch';
	if (
		video?.alpha &&
		(video.codec !== 'prores' || video.proresProfile !== '4444' || settings.container !== 'mov')
	)
		throw new PlanError('VALIDATION_FAILED', 400, 'Alpha output needs ProRes 4444 in a MOV container');
	// color-mgmt: the written colour space (working by default), bit depth and HDR metadata.
	try {
		output.color = exportColorOf(
			video,
			snapshot.settings.color,
			input.still ? null : (encoder?.encoder ?? null),
		);
	} catch (e) {
		if (e instanceof ExportColorError) throw new PlanError('VALIDATION_FAILED', 400, e.message);
		throw e;
	}
	if (output.color.hdr && output.color.bitDepth === 8 && !input.still)
		warnings.push({
			code: 'HDR_8BIT',
			message: `${output.color.space.label} at 8 bits per component bands in smooth gradients; choose ProRes, AV1 or VP9 for 10-bit`,
		});
	if (output.color.hdr && !input.still && settings.container === 'webm' && encoder?.encoder === 'libvpx-vp9')
		warnings.push({
			code: 'HDR_METADATA_UNSUPPORTED',
			message: 'VP9 in WebM carries the PQ/HLG tags but no mastering-display or content-light metadata here',
		});
	if (!rationalEquals(outFps, seqFps)) {
		warnings.push({
			code: 'FRAME_RATE_CONVERSION',
			message: `Export frame rate ${fpsNum(outFps).toFixed(3)} differs from the sequence (${fpsNum(seqFps).toFixed(3)}); frames are sampled nearest-frame and motion may judder`,
		});
	}

	// spec 13 AS-074: a composite that cannot fit in memory is refused before anything runs (a bake of an hour that
	// ends in an OOM kill, or the engine killed with it), with what it would need.
	// Media decoders count with the threads the composite gives them; a range too big for one graph is split into
	// segments (segments.ts) that run a few at a time, so only a range no segmentation fits is refused.
	if (blockers.length === 0 && !video?.alpha && settings.engine !== 'remotion') {
		const budget = deps.memoryBudget ?? compositeMemoryBudget();
		const profile = compositeProfile(snapshot);
		const whole = estimateFrom(snapshot, profile, range, { threads: availableParallelism() });
		let reason = compositeMemoryBlocker(whole, budget);
		if (reason) {
			const seg = planPictureSegments({
				snapshot: { ...snapshot, range },
				output,
				slots: availableParallelism(),
				policy: segmentPolicyFromEnv(),
				memory: { budget, estimate: (r, threads) => estimateFrom(snapshot, profile, r, { threads }).bytes },
			});
			if (!seg.blocker) reason = null;
			else if (seg.segments.length > 1) reason = seg.blocker;
		}
		if (reason) blockers.push({ path: 'native', reason });
	}
	const nativeEligible = blockers.length === 0;
	// `hybrid` = the native composite with baked graphics layers (S04 §11.2, S11:LBK-002).
	const nativePath = baked.length > 0 ? 'hybrid' : 'native';
	let path: 'native' | 'hybrid' | 'remotion';
	if (video?.alpha) {
		// Alpha masters are drawn by the compositions on a transparent page (the layer-bake master settings).
		if (settings.engine === 'native' || deps.capabilities.remotionLocal === 'unavailable')
			throw new PlanError(
				'PATH_NOT_ELIGIBLE',
				409,
				'Alpha output renders on the Remotion path, which is unavailable',
				{
					blockers: [{ path: 'native', reason: 'alpha output' }],
				},
			);
		path = 'remotion';
	} else if (settings.engine === 'native') {
		if (!nativeEligible) {
			throw new PlanError('PATH_NOT_ELIGIBLE', 409, 'The native path cannot render this sequence', {
				blockers,
			});
		}
		path = nativePath;
	} else if (settings.engine === 'remotion') {
		if (deps.capabilities.remotionLocal === 'unavailable') {
			throw new PlanError('PATH_NOT_ELIGIBLE', 409, 'Remotion rendering is unavailable on this engine', {
				blockers: [{ path: 'hybrid', reason: 'Remotion renderer or compositions bundle missing' }],
			});
		}
		path = 'remotion';
	} else path = nativeEligible ? nativePath : 'remotion';

	// routing.ts (docs/wp-notes/export-span-routing.md): an `auto` export whose native blockers all belong to clips or
	// transitions renders only the frames they are drawn on through Remotion — the whole stack there, as a Remotion
	// export draws it — and the rest on the native path, when that is estimated cheaper than Remotion for everything.
	let routed: {
		runs: import('./use-previews.ts').ExportRun[];
		remotionFrames: number;
		seconds: number;
	} | null = null;
	let routedItems: Set<string> | null = null;
	if (
		path === 'remotion' &&
		settings.engine !== 'remotion' &&
		!video?.alpha &&
		!input.still &&
		deps.capabilities.remotionLocal !== 'unavailable' &&
		// (BT.709 written as worked, any bit depth: the native composite and the browser both work at 8 bits)
		(!output.color || (output.color.space.id === 'rec709' && !output.color.converts))
	) {
		const spans = blockerSpans(snapshot, range, blockers);
		routed = spans && spans.length > 0 ? spanRuns(range, spans) : null;
		if (routed && spans) {
			path = 'hybrid';
			routedItems = remotionItems(snapshot, range, routed.runs);
			// layer-routes.ts: a span whose Remotion items are all adjustment layers is split at them
			const whole = new Map<string, number>();
			let layered = 0;
			routed.runs = routed.runs.map((r) => {
				if (r.kind !== 'render' || r.engine !== 'remotion') return r;
				const route = layerRouteOf(
					snapshot,
					r,
					spans.filter((b) => b.start < r.end && b.end > r.start),
				);
				if ('tracks' in route) {
					layered++;
					return { ...r, layers: route.tracks };
				}
				whole.set(route.reason, (whole.get(route.reason) ?? 0) + 1);
				return r;
			});
			const stretches = routed.runs.filter((r) => r.kind === 'render' && r.engine === 'remotion');
			const reasons = new Map<string, number>();
			for (const b of spans) if (b.reason) reasons.set(b.reason, (reasons.get(b.reason) ?? 0) + 1);
			const why = [...reasons].map(([reason, n]) => (n > 1 ? `${reason} (${n}×)` : reason));
			const total = range.end - range.start;
			warnings.push({
				code: 'REMOTION_SPANS',
				message: `${routed.remotionFrames} of ${total} frames (${Math.round((100 * routed.remotionFrames) / total)} %) need the Remotion path, in ${stretches.length} span${stretches.length === 1 ? '' : 's'}; the rest renders on the native path: frames ${spanList(stretches)}. Why: ${why.slice(0, 10).join('; ')}${why.length > 10 ? `; and ${why.length - 10} more reasons (plan blockers list every one)` : ''}. ${layered} span${layered === 1 ? '' : 's'} split at ${layered === 1 ? 'its' : 'their'} adjustment layers (only those layers on Remotion, over native plates)${whole.size ? `; ${stretches.length - layered} with the whole stack on Remotion: ${[...whole].map(([reason, n]) => (n > 1 ? `${reason} (${n}×)` : reason)).join('; ')}` : ''}`,
				itemIds: [...new Set(spans.flatMap((b) => (b.itemId ? [b.itemId] : [])))],
			});
		}
	}

	// TL-124 / TL-125 / TL-123: what the browser draws and needs WebGL2 for (colour and GPU effects, also in nested
	// sequences; GPU transitions; masked effects; blend modes; 3D layers) is refused here when the render browser has
	// none (or lacks the float targets an effect requires), naming the causes, not as a failure in the middle of a render.
	let webgl: WebglStatus | null = null;
	if ((path === 'remotion' || path === 'hybrid') && deps.capabilities.webgl) {
		const all = snapshotGlNeeds(snapshot, deps.effects);
		const bakedIds = new Set(baked.map((b) => b.clipId));
		// (a routed export: what its Remotion spans draw too)
		const drawn = (id: string | undefined) => !!id && (bakedIds.has(id) || !!routedItems?.has(id));
		const needs = path === 'remotion' ? all : all.filter((n) => drawn(n.clipId) || drawn(n.transitionId));
		if (needs.length > 0) {
			webgl = await deps.capabilities.webgl();
			const refusal = webglRefusal(needs, webgl);
			if (refusal)
				throw new PlanError(refusal.code, 409, refusal.message, {
					path,
					blockers: refusal.needs.map((n) => ({
						path,
						reason: `${n.label}: ${refusal.code === 'WEBGL_UNAVAILABLE' ? 'needs WebGL2' : refusal.message}`,
						...(n.clipId ? { itemId: n.clipId } : n.transitionId ? { itemId: n.transitionId } : {}),
					})),
				});
		}
	}

	// The browser draws every baked or Remotion frame: when its WebGL is a CPU rasteriser (an engine started over SSH,
	// outside the desktop session) the bake takes hours instead of minutes, which is said before it starts (first, so
	// short warning lists keep it). Without a GL need the plan does not wait for the probe.
	if (path === 'remotion' || path === 'hybrid') {
		const s = webgl ?? deps.capabilities.webglKnown?.();
		if (s?.hardware === false)
			warnings.unshift({ code: 'GRAPHICS_SOFTWARE', message: s.message ?? 'Graphics render in software' });
	}

	// AGENTS §4: footage the render browser cannot decode (HEVC, ProRes…) is read through FFmpeg in browser-drawn
	// layers; what cannot be read frame-exactly that way is refused by name here, not as a failure mid-render.
	if (path === 'remotion' || path === 'hybrid') {
		const bakedIds = new Set(baked.map((b) => b.clipId));
		const unreadable = browserDrawnClips(
			snapshot,
			path === 'remotion' ? null : routedItems ? new Set([...bakedIds, ...routedItems]) : bakedIds,
		).flatMap((c) => {
			const reason = 'mediaId' in c.source ? browserFrameProblem(c, media[c.source.mediaId]) : null;
			return reason ? [{ clipId: c.clipId, reason }] : [];
		});
		if (unreadable.length > 0)
			throw new PlanError(
				MEDIA_UNDECODABLE,
				409,
				`Footage the render browser cannot read: ${unreadable
					.slice(0, 5)
					.map((u) => u.reason)
					.join('; ')}${unreadable.length > 5 ? ` and ${unreadable.length - 5} more` : ''}`,
				{
					path,
					blockers: unreadable.map((u) => ({ path, reason: u.reason, itemId: u.clipId })),
					hint: 'Convert the file to MP4 (derive_media) and swap it in with replace_footage.',
				},
			);
	}

	// Spec 19 TL-075: a 3D model or HDR environment that is gone never exports as a scene without it.
	const missing3d = missing3dAssets(snapshot);
	if (missing3d.length > 0)
		throw new PlanError(
			THREE_D_ASSET_MISSING,
			409,
			`3D media is missing: ${[...new Set(missing3d.map((m) => m.label))].slice(0, 5).join(', ')}`,
			{
				path,
				blockers: missing3d.map((m) => ({ path, reason: m.label, itemId: m.clipId })),
			},
		);

	// AGENTS §4: what Advanced 3D's fixed limits leave out (lights, shadow maps, supersampling on the render browser's
	// GPU) is said; the preview's chip says the same, as it draws with the same renderer.
	if (path === 'remotion' || path === 'hybrid')
		for (const w of advanced3dLimitWarnings(snapshot, range, webgl?.maxRenderbufferSize)) warnings.push(w);

	// Spec 19 TL-021, AGENTS §4: a look's picture that is offline would draw the look without it (a reflection on its
	// preset environment, a pattern tile with no marks), so the export refuses, as a missing 3D asset does (TL-075).
	const lookOffline = lookMediaOfflineItems(snapshot, document);
	if (lookOffline.length > 0)
		throw new PlanError(
			LOOK_MEDIA_OFFLINE,
			409,
			`A look's picture is offline: ${[...new Set(lookOffline.map((m) => m.label))].slice(0, 5).join(', ')}`,
			{
				path,
				blockers: lookOffline.map((m) => ({ path, reason: m.label, itemId: m.clipId })),
				hint: 'Relink the picture, or pick another one (or None) in the look layer.',
			},
		);
	// (after the refusals naming a particular kind of missing media: 3D models, look pictures, compositions)
	refuseOfflineMedia(snapshot, document, {
		picture: true,
		sound: deliverable.kind !== 'gif' && !settings.videoOnly && !input.still,
	});

	// S11:LBK-024: baking needs the browser too; a pending download is not a blocker.
	if (path === 'hybrid' && deps.capabilities.remotionLocal === 'needs-browser-download')
		warnings.push({
			code: 'BROWSER_DOWNLOAD',
			message: 'Baking graphics layers first downloads a headless browser',
		});
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
	const pixelFactor = Math.max(0.25, pixels / (1920 * 1080));
	// Baked layers (uncached): masters at ~8 fps over each layer's drawn span (S04:RP-009 seed); stills in sheet
	// renders of up to 128 (spec 13 AS-071, textperf: ≈ 3.4 s fixed per render, ≈ 0.1 s per still).
	const stillBakes = baked.filter((b) => b.still).length;
	const bakeSeconds =
		path === 'hybrid'
			? (baked.reduce((s, b) => s + (b.still ? 0 : b.frames / 8), 0) +
					Math.ceil(stillBakes / 128) * 3.4 +
					stillBakes * 0.1) *
				pixelFactor
			: 0;
	const estimateSeconds = routed
		? (((frames - routed.remotionFrames) * durationSec) / frames / 1.5 + routed.remotionFrames / 8) *
				pixelFactor +
			bakeSeconds
		: path !== 'remotion'
			? (durationSec / 1.5) * pixelFactor + bakeSeconds
			: (frames / 8) * pixelFactor;
	const bpp = 0.1 * 2 ** ((18 - output.crf) / 6);
	const estimateBytes = Math.round(
		(pixels * fpsNum(output.fps) * durationSec * bpp) / 8 +
			(output.audioBitrateKbps * 1000 * durationSec) / 8,
	);

	const graphicsGroups: RenderPlan['segments'][number]['graphicsGroups'] =
		path === 'remotion'
			? [{ id: 'g1', engine: 'remotion', itemIds: visual.map((c) => c.clipId) }]
			: [
					...mgClips.map((id, i) => ({ id: `mg${i + 1}`, engine: 'fframes' as const, itemIds: [id] })),
					...baked.map((b, i) => ({ id: `lb${i + 1}`, engine: b.engine, itemIds: [b.clipId] })),
				];
	const documentRevision = input.envelope.revision;
	const planId = planIdOf({
		documentRevision,
		doc: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
		sequenceId: input.sequenceId,
		settings: requested,
		caps: deps.capabilities,
		encoder: encoder?.encoder ?? null,
		range,
	});
	const plan: PlannedExport['plan'] = {
		planId,
		documentRevision,
		path,
		segments: routed
			? routed.runs.map((r, i) =>
					r.kind === 'render' && r.engine === 'remotion'
						? {
								startFrame: r.start,
								endFrame: r.end,
								mode: 'remotion' as const,
								graphicsGroups: [{ id: `rs${i + 1}`, engine: 'remotion' as const, itemIds: [] }],
							}
						: {
								startFrame: r.start,
								endFrame: r.end,
								mode: mgClips.length + baked.length > 0 ? ('mixed' as const) : ('native' as const),
								graphicsGroups,
							},
				)
			: [
					{
						startFrame: range.start,
						endFrame: range.end,
						mode: path === 'remotion' ? 'remotion' : mgClips.length + baked.length > 0 ? 'mixed' : 'native',
						graphicsGroups,
					},
				],
		// frames on each path, on every picture plan: a one-path plan has them all on its path (a Remotion plan's one
		// segment is its span)
		paths: routed
			? {
					native: frames - routed.remotionFrames,
					remotion: routed.remotionFrames,
					spans: routed.runs.filter((r) => r.kind === 'render' && r.engine === 'remotion').length,
				}
			: path === 'remotion'
				? { native: 0, remotion: frames, spans: 1 }
				: { native: frames, remotion: 0, spans: 0 },
		audio: {
			mode: 'native-mix',
			...(audioOut.normalize
				? {
						normalize: (() => {
							const headroom = codecHeadroomDb({
								codec: audioCodecOf(encoder, output),
								bitrateKbps: output.audioBitrateKbps,
								channels: output.audioChannels,
							});
							return {
								...audioOut.normalize,
								limiterCeilingDb: audioOut.normalize.truePeakDb - headroom,
								codecHeadroomDb: headroom,
							};
						})(),
					}
				: {}),
			sampleRate: output.audioSampleRate,
			channels: output.audioChannels,
			codec: audioCodecOf(encoder, output),
		},
		blockers,
		warnings,
		estimate: { seconds: Math.round(estimateSeconds * 10) / 10, bytes: Math.max(0, estimateBytes) },
		...(encoder ? { encoder } : {}),
	};
	if (deliverable.kind === 'gif') {
		const gif: GifSpec = { ...deliverable.gif, frames: gifFrames(durationSec, deliverable.gif.fps) };
		plan.deliverable = { kind: 'gif', ...gif };
		// GIF has no sound: the picture is the file (AGENTS §4: said, never silent; first, so short lists keep it)
		plan.audio = { mode: 'native-mix' };
		plan.warnings.unshift({
			code: 'GIF_NO_AUDIO',
			message: `GIF files have no sound: the sequence's audio is not exported${requested.credits?.sidecar ? ' (and no sound credits file is written)' : ''}`,
			params: { credits: !!requested.credits?.sidecar },
		});
		// rendering the intermediate, then two passes over it at the GIF size
		plan.estimate = {
			seconds: Math.round((plan.estimate.seconds + (gif.frames * gif.width * gif.height) / 2e7) * 10) / 10,
			bytes: gifBytes(gif),
		};
		return {
			plan,
			document,
			sequenceId: input.sequenceId,
			range,
			snapshot,
			media,
			output,
			captions: captionBurnMode(settings),
			captionSettings: settings.captions,
			...(draftProxies.length ? { draftProxies } : {}),
			...(routed ? { routes: routed.runs } : {}),
			deliverable: { kind: 'gif', gif, render: settings },
		};
	}
	return {
		plan,
		document,
		sequenceId: input.sequenceId,
		range,
		snapshot,
		media,
		output,
		captions: captionBurnMode(settings),
		captionSettings: settings.captions,
		...(draftProxies.length ? { draftProxies } : {}),
		...(routed ? { routes: routed.runs } : {}),
	};
}

/**
 * spec 18 AF-EXP-002: the plan of an audio-only file — the offline mixer over the range (the DSP of the preview and every
 * export path) with the export's rate, channels and loudness normalisation, written as WAV, FLAC or M4A. Nothing visual
 * is planned, so nothing visual blocks it; audio effects the mixer cannot run still refuse it (as on every path).
 */
function planAudioOnly(o: {
	input: PlanInput;
	deps: PlanDeps;
	document: ProjectDocument;
	seq: ProjectDocument['sequences'][string];
	range: { start: number; end: number };
	snapshot: RenderSnapshot;
	media: Record<string, LocalMedia>;
	draftProxies: string[];
	proxiesOffline: string[];
	captionWarnings: RenderPlan['warnings'];
	spec: AudioOnlySpec;
}): PlannedExport {
	const { input, deps, document, seq, range, snapshot, spec } = o;
	const settings = input.settings;
	if (!deps.capabilities.native)
		throw new PlanError('PATH_NOT_ELIGIBLE', 409, 'Audio-only exports need ffmpeg, which is not available', {
			blockers: [{ path: 'native', reason: 'ffmpeg is not available' }],
		});
	const unrenderable = unrenderableAudioEffects(snapshot);
	if (unrenderable.length > 0)
		throw new PlanError(
			'AUDIO_EFFECT_UNSUPPORTED',
			409,
			`Audio effects without an export processor: ${[...new Set(unrenderable.map((u) => u.effectId))].join(', ')}`,
			{ effects: unrenderable },
		);
	const warnings: RenderPlan['warnings'] = [
		...soundPlanWarnings(document, input.sequenceId, snapshot, settings),
	];
	if (o.draftProxies.length)
		warnings.push({
			code: 'DRAFT_PROXIES',
			message: `${o.draftProxies.length} media render from their proxies (Use Proxies: a draft, not full resolution)`,
			itemIds: o.draftProxies,
		});
	if (o.proxiesOffline.length)
		warnings.push({
			code: 'PROXY_OFFLINE',
			message: `${o.proxiesOffline.length} proxies are offline: those media render at full resolution`,
			itemIds: o.proxiesOffline,
		});
	// caption sidecars may go with the sound; burned-in captions have no picture to go into
	warnings.push(...o.captionWarnings);
	if (settings.usePreviews)
		warnings.push({ code: 'PREVIEWS_UNUSED', message: 'Audio-only exports render no picture' });
	const audioOut = audioOutputOf(seq, settings);
	const seqFps = seq.settings.frameRate;
	const durationSec = ((range.end - range.start) * seqFps.den) / seqFps.num;
	const bitrateKbps = settings.audio?.bitrateKbps ?? (audioOut.channels === 6 ? 384 : 192);
	const output: OutputSpec = {
		width: seq.settings.width,
		height: seq.settings.height,
		fps: { num: seqFps.num, den: seqFps.den },
		frames: range.end - range.start,
		durationSec,
		scaling: 'fit',
		crf: 18,
		x264Preset: 'medium',
		speed: 'balanced',
		encoder: null,
		audioChannels: audioOut.channels,
		audioBitrateKbps: bitrateKbps,
		audioSampleRate: audioOut.sampleRate,
		normalize: audioOut.normalize,
		audioCodec: spec.codec,
		...(spec.codec === 'flac' && spec.bitDepth ? { audioBits: spec.bitDepth === 16 ? 16 : 24 } : {}),
	};
	const headroom = codecHeadroomDb({ codec: spec.codec, bitrateKbps, channels: audioOut.channels });
	const planId = planIdOf({
		documentRevision: input.envelope.revision,
		doc: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
		sequenceId: input.sequenceId,
		settings,
		caps: deps.capabilities,
		encoder: spec.codec,
		range,
	});
	const plan: PlannedExport['plan'] = {
		planId,
		documentRevision: input.envelope.revision,
		path: 'audio',
		segments: [],
		audio: {
			mode: 'native-mix',
			...(audioOut.normalize
				? {
						normalize: {
							...audioOut.normalize,
							limiterCeilingDb: audioOut.normalize.truePeakDb - headroom,
							codecHeadroomDb: headroom,
						},
					}
				: {}),
			sampleRate: audioOut.sampleRate,
			channels: audioOut.channels,
			codec: spec.codec,
		},
		blockers: [],
		warnings,
		// the offline mixer runs well faster than real time (an assumption; the normalised delivery adds passes)
		estimate: {
			seconds: Math.round((1 + durationSec / 20) * (audioOut.normalize ? 2 : 1) * 10) / 10,
			bytes: audioOnlyBytes(spec, {
				sampleRate: audioOut.sampleRate,
				channels: audioOut.channels,
				bitrateKbps,
				durationSec,
			}),
		},
		deliverable: {
			kind: 'audio',
			container: spec.container,
			codec: spec.codec,
			sampleRate: audioOut.sampleRate,
			channels: audioOut.channels,
			...(spec.bitDepth ? { bitDepth: spec.bitDepth } : {}),
			...(spec.container === 'm4a' ? { bitrateKbps } : {}),
		},
	};
	return {
		plan,
		document,
		sequenceId: input.sequenceId,
		range,
		snapshot,
		media: o.media,
		output,
		captions: 'none',
		captionSettings: settings.captions,
		...(o.draftProxies.length ? { draftProxies: o.draftProxies } : {}),
		deliverable: { kind: 'audio', audio: spec },
	};
}

/** Enabled audio effects (clips, tracks, submixes, the Mix) with no export processor (`registerAudioProcessor`). */
function unrenderableAudioEffects(
	snapshot: RenderSnapshot,
): { itemId: string; effectId: string; where: 'clip' | 'strip' }[] {
	const out: { itemId: string; effectId: string; where: 'clip' | 'strip' }[] = [];
	for (const a of snapshot.audioClips)
		for (const fx of a.effects)
			if (fx.enabled && !hasAudioProcessor(fx.effectId))
				out.push({ itemId: a.clipId, effectId: fx.effectId, where: 'clip' });
	for (const s of snapshot.audioMix?.strips ?? [])
		if (!s.inaudible || s.kind !== 'track')
			for (const fx of s.inserts)
				if (!hasAudioProcessor(fx.effectId))
					out.push({ itemId: s.id, effectId: fx.effectId, where: 'strip' });
	return out;
}

/** Delivered audio format: channels, rate (Opus is 48 kHz only) and the loudness normalisation in effect. */
function audioOutputOf(
	seq: {
		settings: { audioSampleRate?: number; masterLayout?: string };
		master: { loudness?: { enabled: boolean; targetLufs: number; truePeakDb: number } };
	},
	settings: Pick<ExportSettings, 'audio'>,
): { channels: 1 | 2 | 6; sampleRate: number; normalize: { targetLufs: number; truePeakDb: number } | null } {
	const a = settings.audio;
	const channels = a?.channels ?? (seq.settings.masterLayout === '5.1' ? 6 : 2);
	const sampleRate = a?.codec === 'opus' ? 48000 : (a?.sampleRate ?? seq.settings.audioSampleRate ?? 48000);
	const l = seq.master.loudness;
	const normalize =
		a?.normalize === null
			? null
			: a?.normalize
				? { targetLufs: a.normalize.targetLufs, truePeakDb: a.normalize.truePeakDb ?? -1 }
				: l?.enabled
					? { targetLufs: l.targetLufs, truePeakDb: l.truePeakDb }
					: null;
	return { channels, sampleRate, normalize };
}

/** The audio codec of the deliverable (ffmpeg encoder name). */
export function audioCodecOf(
	encoder: EncoderChoice | null,
	output: Pick<OutputSpec, 'audioPcm' | 'audioCodec'>,
): string {
	// spec 18 AF-EXP-002: an audio-only file's own encoder
	if (output.audioCodec) return output.audioCodec;
	const base = encoder?.audioEncoder ?? 'aac';
	if (base.startsWith('pcm_')) return output.audioPcm ? pcmEncoderOf(output.audioPcm) : base;
	return base;
}

/** The snapshot handle of an engine-local media file (exports, bed renders). */
export function localHandle(asset: MediaAsset, m: LocalMedia): MediaHandle {
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
		...mediaDecodeHints(r.probe, 'render'),
	};
}

/** Plan error code for clips drawn by the render browser whose footage it cannot read (`browserFrameProblem`). */
export const MEDIA_UNDECODABLE = 'MEDIA_UNDECODABLE';

/** ffprobe container names whose frame tables the render page demuxes (mediabunny: MP4/QuickTime, Matroska, MPEG-TS). */
const PAGE_DEMUXED = /(^|,)(mov|mp4|matroska|webm|mpegts)(,|$)/;

/**
 * Why the render browser cannot draw a clip's footage frame-exactly, else null. Footage it cannot decode
 * (`mediaDecodeHints(…, 'render')`: ProRes, HEVC…) is read through the render's FFmpeg (`<OffthreadVideo>`) at the
 * media times of its frames; for variable-frame-rate media those come from the container's frame table, which the
 * page demuxes for MP4/QuickTime, Matroska/WebM and MPEG-TS files only.
 */
export function browserFrameProblem(
	c: Pick<RenderVisualClip, 'name' | 'retime'>,
	m: Pick<LocalMedia, 'record'> | undefined,
): string | null {
	const r = m?.record;
	const vs = r?.probe.streams.find((s) => s.type === 'video');
	if (r?.kind !== 'video' || vs?.type !== 'video' || !c.retime?.vfr) return null;
	if (mediaDecodeHints(r.probe, 'render').browserDecodable !== false || PAGE_DEMUXED.test(r.container))
		return null;
	return `clip "${c.name}" has variable-frame-rate ${vs.codec} video in a ${r.container} file: the render browser cannot decode ${vs.codec} and cannot read that container's frame timestamps`;
}

/**
 * Visual clips the render browser draws: all of them on the Remotion path (`baked` null); on the hybrid path the baked
 * layers, the sides of baked transition spans and the clips nested in baked nest clips.
 */
function browserDrawnClips(snap: RenderSnapshot, baked: ReadonlySet<string> | null): RenderVisualClip[] {
	const out: RenderVisualClip[] = [];
	const walk = (s: RenderSnapshot, all: boolean) => {
		for (const t of s.videoTracks) {
			const sides = new Set<string | null>();
			for (const tr of t.transitions ?? [])
				if (baked?.has(tr.id)) sides.add(tr.outgoingClipId).add(tr.incomingClipId);
			for (const c of t.clips) {
				const drawn = all || !baked || baked.has(c.clipId) || sides.has(c.clipId);
				if (drawn) out.push(c);
				if ('nest' in c.source) walk(c.source.nest.snapshot, drawn);
			}
		}
	};
	walk(snap, false);
	return out;
}

/** Plan error code for template media params holding media a template cannot draw as a picture. */
export const TEMPLATE_MEDIA_UNDRAWABLE = 'TEMPLATE_MEDIA_UNDRAWABLE';
/** Spec 19 TL-021: a look layer's picture (reflection environment, pattern tile…) is offline; the export refuses. */
export const LOOK_MEDIA_OFFLINE = 'LOOK_MEDIA_OFFLINE';
/** A clip's media is offline: the export refuses (`refuseOfflineMedia`). */
export const MEDIA_OFFLINE = 'MEDIA_OFFLINE';

/** Clips whose look reads a picture that is offline, one entry per clip and picture, labelled for the blocker. */
export function lookMediaOfflineItems(
	snapshot: RenderSnapshot,
	document: Pick<ProjectDocument, 'media'>,
): { clipId: string; mediaId: string; label: string }[] {
	const out: { clipId: string; mediaId: string; label: string }[] = [];
	for (const c of allVisualClips(snapshot)) {
		const seen = new Set<string>();
		for (const ref of effectMediaRefs(c.effects)) {
			if (!ref.param.startsWith('appearance.') || snapshot.media[ref.mediaId] || seen.has(ref.mediaId))
				continue;
			seen.add(ref.mediaId);
			const name = document.media[ref.mediaId]?.originalName ?? ref.mediaId;
			out.push({
				clipId: c.clipId,
				mediaId: ref.mediaId,
				label: `look picture "${name}" of clip "${c.name}"`,
			});
		}
	}
	return out;
}

/**
 * Why a medium cannot be a template picture (`TemplateImage` draws still images: an <img>, or its display picture when
 * the browser cannot decode the original), else null.
 */
export function templatePictureProblem(
	asset: Pick<MediaAsset, 'kind'> & { lottie?: unknown; vector?: { format?: string } | null },
): string | null {
	if (asset.kind !== 'image') return `a ${asset.kind} medium`;
	if (asset.lottie) return 'a Lottie animation';
	if (asset.vector && asset.vector.format !== 'svg') return `a ${asset.vector.format ?? 'vector'} page`;
	return null;
}

/** A motion-graphic clip rendered by Remotion (`renderer: 'anime'`, S11:ATP-002), not by fframes. */
export function isAnimeTemplate(c: Pick<RenderVisualClip, 'kind' | 'source'>): boolean {
	return c.kind === 'motion-graphic' && 'mg' in c.source && c.source.mg.renderer === 'anime';
}

/**
 * Reasons a visual layer cannot go through the native builder (S04:RN-020, ARCHITECTURE §9.5), with the M2
 * extensions (§19.6): extension kinds are native-capable, a claimed layer skips the generic Motion / opacity /
 * effect checks, and effects an extension supports are not blockers.
 */
export function nativeBlockers(
	c: RenderVisualClip,
	caps: PlanCapabilities,
	exts: readonly NativeExtension[] = [],
	effects: EffectRegistry = defaultEffectRegistry,
): string[] {
	const out: string[] = [];
	const label = `${c.kind} clip "${c.name}"`;
	// 3D layers are planes of the sequence's 3D scene (depth sort, lights, shadows, depth of field), drawn by
	// the compositions' 3D renderer: the export renders them on the Remotion path (never baked one by one, which would
	// flatten them in their 2D place).
	if (c.threeD) return [`3D layer "${c.name}" is drawn by the 3D renderer (Remotion path)`];
	for (const ext of exts) {
		if (ext.kinds?.has(c.kind) || ext.claimsLayer?.(c)) out.push(...(ext.blockers?.(c) ?? []));
	}
	const extKind = exts.some((e) => e.kinds?.has(c.kind));
	if ('generator' in c.source && !exts.some((e) => e.id === 'synthetic'))
		out.push(`${label} draws a generator that needs the synthetic extension`);
	// Reverse, time remaps, Frame Blending / Optical Flow and VFR media are rendered by the retime
	// extension (or inside a whole-layer bake); without it they would play linearly — a named blocker instead.
	const retimed =
		exts.some((e) => e.retimes?.(c)) ||
		exts.some((e) => e.claimsLayer?.(c) && (e.bakes?.(c) ?? null) !== null);
	const retimeBlocker = (): string | null => {
		if (retimed) return null;
		if (c.speed.reverse) return `${label} plays in reverse`;
		if (c.kind === 'nest-video' && c.timeRemap)
			return `nested sequence clip "${c.name}" is time-remapped (nested stacks play linearly on the native path)`;
		if (c.timeRemap) return `${label} is time-remapped and no retime stage is available`;
		if (c.retime?.interpolation === 'optical-flow' || c.retime?.interpolation === 'frame-blending')
			return `${label} uses ${c.retime.interpolation === 'optical-flow' ? 'Optical Flow' : 'Frame Blending'} and no retime stage is available`;
		if (c.retime?.vfr) return `${label} has variable-frame-rate media and no retime stage is available`;
		return null;
	};
	// wp masks: a Track Matte Key reads the composites of other tracks (matte, clean plate). The native kernel has no
	// Track Matte Key and a layer bake draws its clip alone, without those tracks (the matte would be dropped): the
	// Remotion path renders the clip with them.
	const readTracks = trackMatteTracksOf(c);
	if (readTracks.length)
		out.push(
			`${label} uses a Track Matte Key reading track ${readTracks.join(', ')}, which only the Remotion path renders`,
		);
	if (exts.some((e) => e.claimsLayer?.(c))) {
		const r = retimeBlocker();
		if (r) out.push(r);
		return out;
	}
	if (!NATIVE_VISUAL_KINDS.has(c.kind) && !extKind) {
		out.push(
			c.kind === 'text'
				? `text layer "${c.name}" requires graphics rendering`
				: `${label} requires graphics rendering (not a native-capable layer)`,
		);
		return out;
	}
	// M2 (S11:LBK-002): anime templates are Remotion graphics (baked by the layer-bake extension, which claims them
	// above); the fframes checks apply to fframes templates only.
	if (c.kind === 'motion-graphic' && isAnimeTemplate(c)) {
		out.push(`${label} requires graphics rendering (anime template)`);
		return out;
	}
	if (c.kind === 'motion-graphic' && !(caps.fframes === 'ready' && caps.mgMasters)) {
		out.push(`motion graphic "${c.name}" needs the fframes renderer, which is unavailable`);
	}
	// The fframes master holds exactly the clip's frames: no content for transition handles.
	if (c.kind === 'motion-graphic' && ((c.headHandle ?? 0) > 0 || (c.tailHandle ?? 0) > 0))
		out.push(`motion graphic "${c.name}" is part of a transition that needs handles`);
	// wp masks: Opacity masks of kernel-drawn kinds are native (stream/plan.ts); other masks need the layer bake.
	if (maskExportRoute(c) === 'bake')
		out.push(
			hasEffectMasks(c)
				? `${label} has effect masks, which need the composition to render the layer (no layer bake available)`
				: `${label} has masks the native kernel does not draw on this layer (no layer bake available)`,
		);
	// Keyframed Motion and Opacity are native: the builder samples them per frame (S03:ENG-032, keyframed.ts).
	// keyframes-blend: blend modes are native in the sequence's own stack (the blend pipeline, native.ts);
	// `nestBlockers` refuses them inside nested sequences.
	const rb = retimeBlocker();
	if (rb) out.push(rb);
	// Geometric effects on an adjustment layer: run on the composite by the kernel's GL chain (blend/adjust.ts).
	const adjustKernel = isKernelAdjustment(c);
	if (adjustKernel) out.push(...kernelAdjustmentRefusals(c));
	for (const fx of c.effects) {
		if (!fx.enabled) continue;
		// Built-in effects (crop, flips) render with keyframes too (crop edges per frame, `layerSourceChain`).
		if (BUILTIN_NATIVE_EFFECTS.has(fx.effectId)) continue;
		if (adjustKernel && isKernelEffect(fx.effectId)) continue;
		const animated = Object.values(fx.params).some((p) => isAnimated(p));
		const spec = effects.get(fx.effectId, fx.effectVersion);
		let support: false | 'static' | 'animated' = false;
		for (const ext of exts) {
			const s = ext.effectSupport?.(fx.effectId, spec) ?? false;
			if (s === 'animated' || (s === 'static' && support === false)) support = s;
		}
		if (support === false)
			out.push(`${label} uses effect ${fx.effectId}, which the native path cannot render`);
		else if (support === 'static' && animated) out.push(`${label} has an animated ${fx.effectId}`);
	}
	return out;
}

/**
 * AGENTS §4: clips no path can draw because what an extension provides for them is missing on this engine
 * (`refusals`), and composition clips no extension provides at all (their masters can never exist).
 */
function unresolvedClips(
	clips: readonly RenderVisualClip[],
	exts: readonly NativeExtension[],
): { clipId: string; code: string; reason: string; hint: string }[] {
	const out: { clipId: string; code: string; reason: string; hint: string }[] = [];
	for (const c of clips) {
		const providers = exts.filter((e) => e.kinds?.has(c.kind));
		if (c.kind === 'composition' && providers.length === 0)
			out.push({
				clipId: c.clipId,
				code: 'MG_UNAVAILABLE',
				reason: `composition clip "${c.name}" (${c.clipId}) needs composition masters, which this engine cannot render`,
				hint: 'Export on an engine with composition bundles (features.mgBundles), or delete the clip.',
			});
		for (const e of providers) for (const r of e.refusals?.(c) ?? []) out.push({ clipId: c.clipId, ...r });
	}
	return out;
}

/**
 * S03:RND-032, AGENTS §4: clips whose media is offline would draw the preview's "Media Offline" card (or play
 * silence), so every path refuses them by name before anything renders (`MEDIA_OFFLINE`). `picture` / `sound`: the
 * parts the file holds (an audio-only file has no picture; a picture-only file no sound).
 */
function refuseOfflineMedia(
	snapshot: RenderSnapshot,
	document: ProjectDocument,
	parts: { picture: boolean; sound: boolean },
): void {
	const clips = document.sequences[snapshot.sequenceId]?.clips;
	const offline = offlineUsesOf(snapshot, (id) => clips?.[id]?.name).filter((u) =>
		u.sound ? parts.sound : parts.picture,
	);
	if (offline.length === 0) return;
	const fileOf = (id: string) => document.media[id]?.originalName ?? id;
	const files = [...new Set(offline.map((u) => fileOf(u.mediaId)))];
	throw new PlanError(
		MEDIA_OFFLINE,
		409,
		`Media is offline: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''} (used by ${offline
			.slice(0, 5)
			.map(describeUse)
			.join(
				', ',
			)}${offline.length > 5 ? ` and ${offline.length - 5} more clip(s)` : ''}). An export never draws the Media Offline card.`,
		{
			blockers: offline.map((u) => ({
				itemId: u.clipId,
				path: 'native' as const,
				reason: `${u.sound ? 'audio' : 'video'} clip ${describeUse(u)} uses offline media ${fileOf(u.mediaId)} (${u.mediaId})`,
			})),
			media: [...new Set(offline.map((u) => u.mediaId))].map((id) => ({ mediaId: id, name: fileOf(id) })),
			hint: 'Relink the media (Link Media, or Replace Footage for a new file), or remove or disable those clips, then export again.',
		},
	);
}

/** Visual clips of a snapshot and of every nested snapshot drawn in it. */
export function allVisualClips(snap: RenderSnapshot): RenderVisualClip[] {
	const out: RenderVisualClip[] = [];
	for (const t of snap.videoTracks)
		for (const c of t.clips) {
			out.push(c);
			if ('nest' in c.source) out.push(...allVisualClips(c.source.nest.snapshot));
		}
	return out;
}

/** Video tracks of a snapshot and of every nested snapshot drawn in it. */
export function allVideoTracks(snap: RenderSnapshot): RenderSnapshot['videoTracks'] {
	const out: RenderSnapshot['videoTracks'] = [];
	for (const t of snap.videoTracks) {
		out.push(t);
		for (const c of t.clips) if ('nest' in c.source) out.push(...allVideoTracks(c.source.nest.snapshot));
	}
	return out;
}

/**
 * Native limits of nests: a nest clip drawn sub-pixel (animated Motion) is decoded in a separate process, where the
 * layers of its nested sequence cannot be sub-pixel streams themselves.
 */
function nestBlockers(snap: RenderSnapshot): { clipId: string; reason: string }[] {
	const out: { clipId: string; reason: string }[] = [];
	const subpixel = (c: RenderVisualClip) => {
		const props = resolveLayerProps(c, clipContentTime(c, c.start, snap.settings.fps));
		return needsSubpixel(c, props, {
			bw: Math.max(1, Math.round(c.intrinsicBox.width)),
			bh: Math.max(1, Math.round(c.intrinsicBox.height)),
		});
	};
	for (const t of snap.videoTracks)
		for (const c of t.clips) {
			if (!('nest' in c.source)) continue;
			const sub = c.source.nest.snapshot;
			const ownProcess =
				subpixel(c) || c.effects.some((e) => e.enabled && e.effectId === 'jasper.corner-pin');
			if (ownProcess && allVisualClips(sub).some((x) => !('nest' in x.source) && subpixelIn(sub, x)))
				out.push({
					clipId: c.clipId,
					reason: `nested sequence clip "${c.name}" has animated, sub-pixel or corner-pinned Motion and contains sub-pixel or masked layers`,
				});
			// keyframes-blend: a nested stack is drawn inside one process, where a blend layer cannot reach the blend
			// kernel (the nest clip itself may have any blend mode); nor can a Transform adjustment layer reach its kernel.
			for (const x of sub.videoTracks.flatMap((t) => t.clips)) {
				if ((x.blendMode ?? 'normal') !== 'normal')
					out.push({
						clipId: x.clipId,
						reason: `${x.kind} clip "${x.name}" inside nested sequence clip "${c.name}" uses blend mode "${blendModeInfo(x.blendMode)?.label ?? x.blendMode}" (native blend modes apply to the sequence's own layers)`,
					});
				if (isKernelAdjustment(x))
					out.push({
						clipId: x.clipId,
						reason: `adjustment clip "${x.name}" inside nested sequence clip "${c.name}" has geometric effects (native geometric adjustment layers apply to the sequence's own stack)`,
					});
			}
			out.push(...nestBlockers(sub));
		}
	return out;
}

function subpixelIn(snap: RenderSnapshot, c: RenderVisualClip): boolean {
	// wp masks: layers with Opacity masks are kernel streams too; so are lowered layers (spec 13 AS-070).
	if (maskExportRoute(c) === 'stream' || layerStill(c)) return true;
	const props = resolveLayerProps(c, clipContentTime(c, c.start, snap.settings.fps));
	return needsSubpixel(c, props, {
		bw: Math.max(1, Math.round(c.intrinsicBox.width)),
		bh: Math.max(1, Math.round(c.intrinsicBox.height)),
	});
}
