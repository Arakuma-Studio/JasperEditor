// Clip processing on the web side (S07 §6): step labels, the processed-version relation of media assets and
// the steps a Process Clip dialog state produces. Pure (no React, no engine) so tests and the badge host share
// it. The label/order helpers mirror apps/engine/src/processing/proc/recipe.ts (web may not import engine code,
// ARCHITECTURE §3.1).
import { FLICKS_PER_SECOND, type MediaAsset, type ProcessStep, type ProjectDocument } from '@jasper/project';

export type StepOp = ProcessStep['op'];

/**
 * UI order of steps (S07:PST-021, revised): deblock → denoise → de-judder → stabilise → upscale (de-judder must
 * see the original capture cadence; see apps/engine/src/processing/proc/recipe.ts).
 */
export const STEP_ORDER: readonly StepOp[] = ['deblock', 'denoise', 'dejudder', 'stabilize', 'upscale'];

/** Human label of one step (item names, badges, tooltips), e.g. `Stabilized`, `Upscaled 2×`. */
export function stepLabel(step: ProcessStep): string {
	switch (step.op) {
		case 'stabilize':
			return 'Stabilized';
		case 'dejudder':
			return 'De-juddered';
		case 'denoise':
			return 'Denoised';
		case 'deblock':
			return 'Deblocked';
		case 'upscale':
			return `Upscaled ${step.scale}×`;
		default:
			return String((step as { op: string }).op);
	}
}

export function recipeLabel(steps: readonly ProcessStep[]): string {
	return steps.map(stepLabel).join(' · ');
}

export function sortSteps(steps: readonly ProcessStep[]): ProcessStep[] {
	return [...steps].sort((a, b) => STEP_ORDER.indexOf(a.op) - STEP_ORDER.indexOf(b.op));
}

type MediaTable = Pick<ProjectDocument, 'media'>;

/** The processing steps of a processed version (derivation recipe `process`), or null for other media. */
export function processedSteps(
	asset: Pick<MediaAsset, 'derivation'> | undefined | null,
): ProcessStep[] | null {
	const d = asset?.derivation;
	if (d?.recipe.op !== 'process') return null;
	return (d.recipe as { steps: ProcessStep[] }).steps;
}

export function isProcessed(asset: Pick<MediaAsset, 'derivation'> | undefined | null): boolean {
	return processedSteps(asset) !== null;
}

/** Derivations a clip can swap between (same frame count and rate): processing and plain transcodes. */
function isVersion(asset: MediaAsset | undefined): boolean {
	const op = asset?.derivation?.recipe.op;
	return op === 'process' || op === 'transcode';
}

/** The original a media asset is a version of (itself for originals; null for unknown ids). */
export function originalOf(doc: MediaTable, mediaId: string): string | null {
	let id = mediaId;
	const seen = new Set<string>();
	for (;;) {
		const m = doc.media[id] as MediaAsset | undefined;
		if (!m) return seen.size === 0 ? null : id;
		if (seen.has(id)) return id;
		seen.add(id);
		const from = m.derivation?.fromMediaId;
		if (!isVersion(m) || !from || !doc.media[from]) return id;
		id = from;
	}
}

/** The original first, then every processed version of it (document order). */
export function versionsOf(doc: MediaTable, mediaId: string): string[] {
	const original = originalOf(doc, mediaId);
	if (!original) return [];
	const rest = Object.keys(doc.media).filter((id) => id !== original && originalOf(doc, id) === original);
	return [original, ...rest];
}

/** Label of a version in the Media Version dropdown: "Original" or its step labels. */
export function versionLabel(doc: MediaTable, mediaId: string): string {
	const m = doc.media[mediaId] as MediaAsset | undefined;
	if (!m) return mediaId;
	const steps = processedSteps(m);
	if (steps) return recipeLabel(steps);
	if (isVersion(m)) return m.originalName;
	return 'Original';
}

/** Tooltip text of a processed version: `Processed version of <original> — Denoised · Upscaled 2×`. */
export function processedTooltip(doc: MediaTable, mediaId: string): string | null {
	const m = doc.media[mediaId] as MediaAsset | undefined;
	const steps = processedSteps(m);
	if (!m || !steps) return null;
	const from = m.derivation ? (doc.media[m.derivation.fromMediaId] as MediaAsset | undefined) : undefined;
	return `Processed version${from ? ` of ${from.originalName}` : ''} — ${recipeLabel(steps)}`;
}

// ------------------------------------------------------------------ dialog state → steps

export type DenoisePreset = 'light' | 'medium' | 'strong';
export const DENOISE_PRESETS: Record<DenoisePreset, number> = { light: 0.25, medium: 0.5, strong: 0.8 };
export type DenoiseMethod = 'atadenoise' | 'fftdnoiz' | 'nlmeans';

export type ProcessForm = {
	deblock: { on: boolean; filter: 'weak' | 'strong' };
	denoise: { on: boolean; method: DenoiseMethod; preset: DenoisePreset };
	stabilize: {
		on: boolean;
		method: 'auto' | 'vidstab' | 'deshake';
		smoothing: number;
		borders: 'crop' | 'keep';
		rotation: boolean;
	};
	dejudder: { on: boolean; mode: 'auto' | 'force' };
	upscale: {
		on: boolean;
		model: string;
		scale: 2 | 4;
		/** `model` = the model's output (N× the source), `fhd` = 1920×1080, `custom` = width × height. */
		size: 'model' | 'fhd' | 'custom';
		width: number;
		height: number;
		/** 0..1 blend towards a Lanczos upscale. */
		mix: number;
	};
};

export function defaultForm(
	opts: { denoiseMethod?: DenoiseMethod; model?: { id: string; scale: 2 | 4 } } = {},
): ProcessForm {
	return {
		deblock: { on: false, filter: 'weak' },
		denoise: { on: false, method: opts.denoiseMethod ?? 'atadenoise', preset: 'medium' },
		stabilize: { on: false, method: 'auto', smoothing: 15, borders: 'crop', rotation: true },
		dejudder: { on: false, mode: 'auto' },
		upscale: {
			on: false,
			model: opts.model?.id ?? '',
			scale: opts.model?.scale ?? 2,
			size: 'model',
			width: 1920,
			height: 1080,
			mix: 0,
		},
	};
}

/** The steps of a dialog state, in the fixed UI order (S07:PST-021). */
export function stepsFromForm(f: ProcessForm): ProcessStep[] {
	const steps: ProcessStep[] = [];
	if (f.deblock.on) steps.push({ op: 'deblock', filter: f.deblock.filter });
	if (f.denoise.on)
		steps.push({ op: 'denoise', method: f.denoise.method, strength: DENOISE_PRESETS[f.denoise.preset] });
	if (f.dejudder.on) steps.push({ op: 'dejudder', mode: f.dejudder.mode });
	if (f.stabilize.on)
		steps.push({
			op: 'stabilize',
			method: f.stabilize.method,
			smoothing: Math.round(Math.min(120, Math.max(1, f.stabilize.smoothing))),
			borders: f.stabilize.borders,
			rotation: f.stabilize.rotation,
		});
	if (f.upscale.on && f.upscale.model) {
		const u: Extract<ProcessStep, { op: 'upscale' }> = {
			op: 'upscale',
			model: f.upscale.model,
			scale: f.upscale.scale,
		};
		if (f.upscale.size === 'fhd') u.size = { width: 1920, height: 1080 };
		else if (f.upscale.size === 'custom')
			u.size = {
				width: Math.max(1, Math.round(f.upscale.width)),
				height: Math.max(1, Math.round(f.upscale.height)),
			};
		if (f.upscale.mix > 0) u.mix = Math.round(f.upscale.mix * 100) / 100;
		steps.push(u);
	}
	return steps;
}

// ------------------------------------------------------------------ rough time estimate

/** Seconds per frame at 1280×720 on one CPU machine (measured roughly on a laptop; only an estimate). */
const SEC_PER_FRAME_720P: Record<string, number> = {
	deblock: 0.004,
	'denoise:atadenoise': 0.006,
	'denoise:fftdnoiz': 0.04,
	'denoise:nlmeans': 0.35,
	'stabilize:vidstab': 0.05,
	'stabilize:deshake': 0.03,
	dejudder: 0.12,
	upscale: 1.2,
};
const ENCODE_SEC_PER_FRAME_720P = 0.01;
const OVERHEAD_SEC = 4;

export type SourceInfo = { frames: number; width: number; height: number };

/** Source frames and size of a video asset (null when the probe has no video stream or duration). */
export function sourceInfo(asset: MediaAsset | undefined): SourceInfo | null {
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (!asset || !vs || vs.type !== 'video') return null;
	const dur = asset.probe.durationFlicks;
	if (!dur) return null;
	const fps = vs.frameRate.num / vs.frameRate.den;
	return {
		frames: Math.max(1, Math.round((dur / FLICKS_PER_SECOND) * fps)),
		width: vs.width,
		height: vs.height,
	};
}

/**
 * A deliberately simple estimate (frames × per-step seconds per frame, scaled by pixel count; a CUDA remote
 * makes the upscale ~20× faster). Shown to the user as "≈ … (estimate)".
 */
export function estimateSeconds(
	steps: readonly ProcessStep[],
	src: SourceInfo,
	opts: { gpu?: boolean; stabilizeEngine?: 'vidstab' | 'deshake' } = {},
): number {
	const px = (src.width * src.height) / (1280 * 720);
	let perFrame = ENCODE_SEC_PER_FRAME_720P * px;
	let scale = 1;
	for (const s of steps) {
		let key: string = s.op;
		if (s.op === 'denoise') key = `denoise:${s.method}`;
		if (s.op === 'stabilize') {
			const m = s.method === 'auto' ? (opts.stabilizeEngine ?? 'vidstab') : s.method;
			key = `stabilize:${m}`;
		}
		let cost = (SEC_PER_FRAME_720P[key] ?? 0.05) * px * scale;
		if (s.op === 'upscale') {
			if (opts.gpu) cost /= 20;
			scale = s.scale * s.scale; // later steps (none in UI order) and the encode see the bigger frames
		}
		perFrame += cost;
	}
	perFrame += ENCODE_SEC_PER_FRAME_720P * px * (scale - 1);
	return OVERHEAD_SEC + perFrame * src.frames;
}

export function formatDuration(sec: number): string {
	if (sec < 60) return `${Math.max(5, Math.round(sec / 5) * 5)} s`;
	const min = sec / 60;
	if (min < 60) return `${Math.round(min)} min`;
	const h = Math.floor(min / 60);
	const m = Math.round(min % 60);
	return m ? `${h} h ${m} min` : `${h} h`;
}
