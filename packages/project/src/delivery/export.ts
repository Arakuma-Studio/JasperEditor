// The export format of a delivery target (spec 18 AF-VER-004): what a platform preset writes for a sequence — H.264 +
// AAC in MP4 (the engine's LGPL encoder selector picks the H.264 encoder, or substitutes and says so), the sequence's
// frame shape fitted into the platform's recommended frame size, a frame rate the platform takes and loudness
// normalisation to its level. A sequence whose shape the platform does not show as this target (a horizontal sequence
// for a vertical target) is refused with a hint to Auto Reframe: it is never cropped silently. Pure.
import type { Rational } from '../time.ts';
import { DELIVERY_DEFAULT_LUFS, type DeliveryTarget } from './targets.ts';

/** Export preset id of a delivery target (`delivery-<target id>`). */
export const deliveryPresetId = (t: Pick<DeliveryTarget, 'id'>): string => `delivery-${t.id}`;

/** The H.264 quality of every delivery preset (x264-style CRF; bitrate encoders map it). */
export const DELIVERY_CRF = 18;
export const DELIVERY_AUDIO_KBPS = 256;

export type DeliveryExportFormat = {
	presetId: string;
	container: 'mp4';
	videoCodec: 'h264';
	width: number;
	height: number;
	frameRate: Rational;
	crf: number;
	audio: { codec: 'aac'; sampleRate: 48000; bitrateKbps: number };
	normalize: { targetLufs: number; truePeakDb: number };
};

export type DeliveryExportRefusal = {
	code: 'E_INVALID_PARAM';
	message: string;
	/** The tool (and editor command) that makes a sequence of the target's shape. */
	hint: 'auto_reframe_sequence';
	aspect: DeliveryTarget['aspect'];
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const aspectValue = (a: DeliveryTarget['aspect']) => {
	const [w, h] = a.split(':').map(Number) as [number, number];
	return w / h;
};

/**
 * The frame rate a target takes for a sequence rate: the sequence's own when the platform takes it, else the
 * recommended rate nearest to it.
 */
function deliveryRate(t: DeliveryTarget, fps: Rational): Rational {
	const f = fps.den > 0 ? fps.num / fps.den : Number.NaN;
	const l = t.limits;
	if (
		Number.isFinite(f) &&
		f <= l.maxFrameRate + 1e-6 &&
		(l.minFrameRate === null || f >= l.minFrameRate - 1e-6)
	)
		return { num: fps.num, den: fps.den };
	let best = l.frameRates[0] ?? 30;
	for (const r of l.frameRates) if (Math.abs(r - f) < Math.abs(best - f)) best = r;
	return { num: best, den: 1 };
}

export function deliveryExportFormat(
	t: DeliveryTarget,
	seq: { width: number; height: number; frameRate: Rational },
): { ok: true; format: DeliveryExportFormat } | { ok: false; refusal: DeliveryExportRefusal } {
	const w = seq.width;
	const h = seq.height;
	const shape = w > 0 && h > 0 ? w / h : Number.NaN;
	const vertical = aspectValue(t.aspect) < 1;
	const range = t.limits.aspectRange;
	const outside =
		!Number.isFinite(shape) || (range !== null && (shape < range.min - 1e-6 || shape > range.max + 1e-6));
	if ((vertical && w > h) || outside) {
		return {
			ok: false,
			refusal: {
				code: 'E_INVALID_PARAM',
				message: `${t.name} takes ${t.aspect} pictures and this sequence is ${w} × ${h}${vertical && w > h ? ' (horizontal)' : ''}: it would have to be cropped. Make a ${t.aspect} copy with Auto Reframe first (auto_reframe_sequence {aspect: "${t.aspect}"}, or Sequence ▸ Auto Reframe Sequence…) and export that.`,
				hint: 'auto_reframe_sequence',
				aspect: t.aspect,
			},
		};
	}
	const box = t.limits.recommendedSize;
	const scale = Math.min(box.width / w, box.height / h);
	return {
		ok: true,
		format: {
			presetId: deliveryPresetId(t),
			container: 'mp4',
			videoCodec: 'h264',
			width: even(w * scale),
			height: even(h * scale),
			frameRate: deliveryRate(t, seq.frameRate),
			crf: DELIVERY_CRF,
			audio: { codec: 'aac', sampleRate: 48000, bitrateKbps: DELIVERY_AUDIO_KBPS },
			normalize: {
				targetLufs: t.limits.loudnessLufs ?? DELIVERY_DEFAULT_LUFS,
				truePeakDb: t.limits.truePeakDbtp,
			},
		},
	};
}
