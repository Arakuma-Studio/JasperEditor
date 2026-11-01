// Derive Media ▸ … (spec 18 AF-OPS-002): the form of each derivation op, its recipe and its field problems (the
// engine's refusal codes, `deriveProblems`), and the job → `media.derive` flow (one undo step "Derive Media").
import {
	type DeriveResult,
	DeriveResultSchema,
	type EngineJob,
	LOCAL_ENGINE_ID,
	TERMINAL_JOB_STATES,
} from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	DERIVE_LIMITS,
	type DeriveOp,
	type DeriveRecipe,
	deriveProblems,
	deriveSourceKinds,
	FLICKS_PER_SECOND,
	type MediaAsset,
	type MediaLocator,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { mediaKeyOf } from '../import/assets.ts';

export const DERIVE_MEDIA_DIALOG = 'derive.media';
export const DERIVE_TX_LABEL = 'Derive Media';

/** Project panel ▸ Derive Media ▸ <op>… */
export const DERIVE_MENU_LABELS: Record<DeriveOp, string> = {
	'conform-cfr': 'Conform to Constant Frame Rate…',
	reverse: 'Reverse…',
	'denoise-audio': 'Denoise Audio…',
	'extract-audio': 'Extract Audio…',
	'time-stretch': 'Time Stretch…',
	range: 'Subclip Range…',
};

export const DERIVE_DIALOG_TITLES: Record<DeriveOp, string> = {
	'conform-cfr': 'Conform to Constant Frame Rate',
	reverse: 'Reverse',
	'denoise-audio': 'Denoise Audio',
	'extract-audio': 'Extract Audio',
	'time-stretch': 'Time Stretch',
	range: 'Subclip Range',
};

/** What each op makes (shown under the title). */
export const DERIVE_DESCRIPTIONS: Record<DeriveOp, string> = {
	'conform-cfr':
		'A copy at a constant frame rate: frames are placed by their timestamps (repeated or dropped) and the sound stays in sync.',
	reverse: 'A copy that plays backwards, picture and sound.',
	'denoise-audio':
		'A 24-bit WAV of the first audio stream with steady background noise reduced (FFmpeg afftdn).',
	'extract-audio': 'One audio stream as its own audio file.',
	'time-stretch': 'A faster or slower copy; the picture keeps the source frame rate.',
	range: 'The frames from In up to (not including) Out as a new file that stays linked to its source frames.',
};

/** Coded refusals (engine and client), in the editor's words. */
export const DERIVE_ERROR_HINTS: Record<string, string> = {
	NO_AUDIO: 'The media has no such audio stream.',
	NO_VIDEO: 'The media has no video stream.',
	UNSUPPORTED_RATE: 'The rate is outside what this operation supports.',
	OUT_OF_RANGE: 'The range lies outside the media.',
	EMPTY_RANGE: 'The range holds no frame: Out must be after In.',
	UNSUPPORTED_MEDIA: 'This media cannot be used for this operation.',
	MEDIA_OFFLINE: 'The media is offline: relink it first.',
	ENCODER_UNAVAILABLE: 'The engine has no encoder for this output.',
	INVALID_PARAM: 'A value is outside its range.',
	ASSET_NOT_FOUND: 'The engine does not know this media; import it again.',
	DERIVE_FAILED: 'The operation failed on the engine.',
	DISK_FULL: 'The disk is full.',
	JOB_CANCELLED: 'The operation was cancelled.',
};

export const FPS_PRESETS: readonly { value: string; label: string }[] = [
	{ value: '24000/1001', label: '23.976 fps' },
	{ value: '24/1', label: '24 fps' },
	{ value: '25/1', label: '25 fps' },
	{ value: '30000/1001', label: '29.97 fps' },
	{ value: '30/1', label: '30 fps' },
	{ value: '48/1', label: '48 fps' },
	{ value: '50/1', label: '50 fps' },
	{ value: '60000/1001', label: '59.94 fps' },
	{ value: '60/1', label: '60 fps' },
	{ value: '120/1', label: '120 fps' },
];

export type DeriveForm = {
	/** conform-cfr: `num/den`. */
	fps: string;
	/** denoise-audio, 0…1. */
	strength: number;
	/** extract-audio. */
	streamIndex: number;
	format: 'wav' | 'flac';
	/** time-stretch: speed factor. */
	rate: number;
	preservePitch: boolean;
	/** range, seconds. */
	inSec: number;
	outSec: number;
};

export type DeriveProblem = { code: string; message: string; field?: string };

export function durationSecOf(asset: Pick<MediaAsset, 'probe'>): number | null {
	const d = asset.probe.durationFlicks;
	return d === null ? null : d / FLICKS_PER_SECOND;
}

/** The nearest preset to the media's own rate (a VFR file's average), else 30. */
function defaultFps(asset: Pick<MediaAsset, 'probe'>): string {
	const v = asset.probe.streams.find((s) => s.type === 'video');
	if (v?.type !== 'video' || !(v.frameRate.num > 0 && v.frameRate.den > 0)) return '30/1';
	const own = v.frameRate.num / v.frameRate.den;
	let best = FPS_PRESETS[0]!.value;
	let dist = Number.POSITIVE_INFINITY;
	for (const p of FPS_PRESETS) {
		const [n, d] = p.value.split('/').map(Number);
		const dd = Math.abs(n! / d! - own);
		if (dd < dist) {
			dist = dd;
			best = p.value;
		}
	}
	return best;
}

/** Defaults of a dialog: the first audio stream, the media's whole length (or its In/Out marks), speed 2×. */
export function defaultDeriveForm(
	asset: Pick<MediaAsset, 'probe'>,
	marks?: { in: { flicks: number } | null; out: { flicks: number } | null } | null,
): DeriveForm {
	const audio = asset.probe.streams.find((s) => s.type === 'audio');
	const dur = durationSecOf(asset) ?? 0;
	const inSec = marks?.in ? marks.in.flicks / FLICKS_PER_SECOND : 0;
	const outSec = marks?.out ? marks.out.flicks / FLICKS_PER_SECOND : dur;
	return {
		fps: defaultFps(asset),
		strength: 0.5,
		streamIndex: audio?.index ?? 0,
		format: 'wav',
		rate: 2,
		preservePitch: true,
		inSec: Math.max(0, Math.min(inSec, dur)),
		outSec: Math.max(0, Math.min(outSec, dur)),
	};
}

export function recipeFromForm(op: DeriveOp, f: DeriveForm): DeriveRecipe {
	switch (op) {
		case 'conform-cfr': {
			const [num, den] = f.fps.split('/').map((x) => Number(x));
			return { op, frameRate: { num: num ?? 0, den: den ?? 1 } };
		}
		case 'reverse':
			return { op };
		case 'denoise-audio':
			return { op, strength: f.strength };
		case 'extract-audio':
			return { op, streamIndex: f.streamIndex, format: f.format };
		case 'time-stretch':
			return { op, rate: f.rate, preservePitch: f.preservePitch };
		case 'range':
			return {
				op,
				inFlicks: Math.max(0, Math.round(f.inSec * FLICKS_PER_SECOND)),
				outFlicks: Math.max(0, Math.round(f.outSec * FLICKS_PER_SECOND)),
			};
	}
}

/** The coded problems of `op` with these values on `asset` (empty = the engine can run it). */
export function deriveFormProblems(
	asset: Pick<MediaAsset, 'kind' | 'probe'>,
	op: DeriveOp,
	f: DeriveForm,
): DeriveProblem[] {
	if (!deriveSourceKinds(op).includes(asset.kind))
		return [
			{ code: 'UNSUPPORTED_MEDIA', message: `${op} needs ${deriveSourceKinds(op).join(' or ')} media` },
		];
	return deriveProblems(asset, recipeFromForm(op, f));
}

export const RATE_BOUNDS = { min: DERIVE_LIMITS.minRate, max: DERIVE_LIMITS.maxRate };

/** A coded error of the derive flow (engine refusal, job failure, rejected transaction). */
export class DeriveError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'DeriveError';
	}
}

function engineCode(e: unknown): DeriveError {
	if (e instanceof DeriveError) return e;
	if (e instanceof EngineError) {
		const inner = (e.detail as { code?: unknown } | undefined)?.code;
		return new DeriveError(typeof inner === 'string' ? inner : e.code, e.message);
	}
	return new DeriveError('DERIVE_FAILED', e instanceof Error ? e.message : String(e));
}

/** `media.derive` for a finished derive job (the asset = the engine's RegisteredMedia of the output). */
export function deriveCommand(
	fromMediaId: string,
	res: DeriveResult,
	replaceInClips: readonly string[] = [],
) {
	const reg = res.registered;
	const locators: MediaLocator[] = [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }];
	for (const l of reg.locators) if (l.type === 'path') locators.push(l);
	return {
		type: 'media.derive' as const,
		fromMediaId,
		recipe: res.recipe,
		asset: {
			fingerprint: reg.fingerprint,
			originalName: reg.originalName,
			sizeBytes: reg.sizeBytes,
			container: reg.container,
			probe: reg.probe,
			locators,
			recipeVersion: res.recipeVersion,
			recipeHash: res.recipeHash,
		},
		...(res.range ? { range: res.range } : {}),
		...(replaceInClips.length ? { replaceInClips: [...replaceInClips] } : {}),
	};
}

export type DeriveRun = {
	/** The engine job once queued (Cancel uses it). */
	onJob?(job: EngineJob): void;
	pollMs?: number;
};

/**
 * Queues the op on the engine, follows the job and commits ONE `media.derive` ("Derive Media"). Runs to the end
 * when the dialog closes (the result is still added). Rejects with a coded DeriveError.
 */
export async function runDerive(
	session: EditorSession,
	engine: EngineClient,
	mediaId: string,
	recipe: DeriveRecipe,
	opts: DeriveRun & { replaceInClips?: readonly string[] } = {},
): Promise<{ mediaId: string; itemId?: string; result: DeriveResult }> {
	const asset = session.getCommitted().media[mediaId] as MediaAsset | undefined;
	const key = mediaKeyOf(asset);
	if (!asset || !key) throw new DeriveError('ASSET_NOT_FOUND', 'This media is not stored by the engine');
	let job: EngineJob;
	try {
		job = await engine.deriveMedia(key, { projectId: session.projectId, recipe });
	} catch (e) {
		throw engineCode(e);
	}
	opts.onJob?.(job);
	let transient = 0;
	while (!TERMINAL_JOB_STATES.has(job.state)) {
		await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
		try {
			job = await engine.getJob(job.id);
			transient = 0;
		} catch (e) {
			if (e instanceof EngineError && (e.code === 'NETWORK' || e.retryable) && ++transient < 10) continue;
			throw engineCode(e);
		}
		opts.onJob?.(job);
	}
	if (job.state !== 'succeeded')
		throw new DeriveError(
			job.error?.code ?? (job.state === 'cancelled' ? 'JOB_CANCELLED' : 'DERIVE_FAILED'),
			job.error?.message ?? `The job ${job.state}`,
		);
	const parsed = DeriveResultSchema.safeParse(job.result);
	if (!parsed.success) throw new DeriveError('DERIVE_FAILED', 'The engine returned an unusable result');
	const r = session.apply({
		label: DERIVE_TX_LABEL,
		origin: 'user',
		commands: [deriveCommand(mediaId, parsed.data, opts.replaceInClips ?? [])],
	});
	if (!r.ok) {
		const err = r.errors[0];
		throw new DeriveError(err?.code ?? 'E_INTERNAL', err?.message ?? 'The derived media could not be added');
	}
	const value = r.results[0] as { mediaId: string; itemId?: string };
	return { mediaId: value.mediaId, ...(value.itemId ? { itemId: value.itemId } : {}), result: parsed.data };
}
