// Ruler tick selection and labels (S02:TL-201/202, Appendix A.9).
import {
	type AudioDisplayFormat,
	dropFrameToNominal,
	fieldsToFrames,
	formatAudioTime,
	nominalFps,
	type Rational,
	supportsDropFrame,
} from '@jasper/project';
import { formatTimecode } from '../../../gaps/time-display.ts';
import { frameToX, type Viewport } from './viewport.ts';

const MIN_MAJOR_PX = 80;
const MIN_MINOR_PX = 8;
const PER_FRAME_TICKS_PX = 6;

/** Candidate major intervals in (nominal) frames, ascending (TL-201). */
function majorCandidates(rate: Rational): number[] {
	const fps = nominalFps(rate);
	const out = [1, 2, 5, 10];
	if (fps % 2 === 0) out.push(fps / 2);
	for (const s of [1, 2, 5, 10, 15, 30]) out.push(s * fps);
	for (const m of [1, 2, 5, 10, 15, 30]) out.push(m * 60 * fps);
	for (const h of [1, 2]) out.push(h * 3600 * fps);
	return [...new Set(out)].sort((a, b) => a - b);
}

type TickPlan = { major: number; minor: number; perFrame: boolean };

/** A.9: smallest major with ≥ 80 px; minor division of [10, 5, 4, 2] with ≥ 8 px; per-frame ticks ≥ 6 px/frame. */
function chooseTicks(pxPerFrame: number, rate: Rational): TickPlan {
	const cands = majorCandidates(rate);
	const major = cands.find((c) => c * pxPerFrame >= MIN_MAJOR_PX) ?? cands[cands.length - 1]!;
	let minor = major;
	for (const k of [10, 5, 4, 2]) {
		const step = major / k;
		if (Number.isInteger(step) && step * pxPerFrame >= MIN_MINOR_PX) {
			minor = step;
			break;
		}
	}
	return { major, minor, perFrame: pxPerFrame >= PER_FRAME_TICKS_PX };
}

type Tick = { frame: number; x: number; kind: 'major' | 'minor' | 'frame'; label?: string };

function nominalToFrame(n: number, rate: Rational, drop: boolean): number {
	if (!drop) return n;
	const fps = nominalFps(rate);
	const f = n % fps;
	const totalS = Math.floor(n / fps);
	return fieldsToFrames(Math.floor(totalS / 3600), Math.floor(totalS / 60) % 60, totalS % 60, f, rate, {
		dropFrame: true,
	});
}

/** Short label form: drop the zero hour (and a zero minute) under one hour (TL-202). */
function shortLabel(tc: string, sequenceUnderHour: boolean): string {
	if (!sequenceUnderHour) return tc;
	const m = /^(-?)00([:;])(\d\d)([:;])(\d\d[:;]\d\d)$/.exec(tc);
	if (!m) return tc;
	return m[3] === '00' ? `${m[1]}${m[4]}${m[5]}` : `${m[1]}${m[3]}${m[4]}${m[5]}`;
}

/**
 * Ticks for the visible range `[x0, x1)` of the ruler (clip-area px). Positions come from exact frames
 * (TL-102); drop-frame sequences place ticks on displayed-timecode multiples (TL-201).
 */
export function rulerTicks(
	v: Viewport,
	rate: Rational,
	opts: {
		dropFrame: boolean;
		startFrames: number;
		sequenceEnd: number;
		x0?: number;
		x1?: number;
		/** gaps (Show Audio Time Units): label in audio time units of the sequence sample rate. */
		audio?: { sampleRate: number; format: AudioDisplayFormat };
	},
): Tick[] {
	const drop = opts.dropFrame && supportsDropFrame(rate);
	const plan = chooseTicks(v.pxPerFrame, rate);
	const x0 = opts.x0 ?? 0;
	const x1 = opts.x1 ?? v.width;
	const f0 = Math.max(0, Math.floor(v.scrollFrame + x0 / v.pxPerFrame) - plan.major);
	const f1 = Math.ceil(v.scrollFrame + x1 / v.pxPerFrame) + plan.major;
	const n0 = drop ? dropFrameToNominal(f0, rate) : f0;
	const n1 = drop ? dropFrameToNominal(f1, rate) : f1;
	const underHour = opts.sequenceEnd < 3600 * nominalFps(rate);
	const ticks: Tick[] = [];
	const seen = new Set<number>();
	const push = (frame: number, kind: Tick['kind']) => {
		if (seen.has(frame)) return;
		const x = frameToX(v, frame);
		if (x < x0 - 200 || x > x1 + 200) return;
		seen.add(frame);
		const t: Tick = { frame, x, kind };
		if (kind === 'major')
			t.label = opts.audio
				? formatAudioTime(frame, rate, opts.audio.sampleRate, opts.audio.format, opts.startFrames)
				: shortLabel(
						formatTimecode(frame, rate, { dropFrame: drop, startFrames: opts.startFrames }),
						underHour,
					);
		ticks.push(t);
	};
	for (let n = Math.ceil(n0 / plan.major) * plan.major; n <= n1; n += plan.major)
		push(nominalToFrame(n, rate, drop), 'major');
	if (plan.minor < plan.major)
		for (let n = Math.ceil(n0 / plan.minor) * plan.minor; n <= n1; n += plan.minor)
			push(nominalToFrame(n, rate, drop), 'minor');
	if (plan.perFrame) for (let f = f0; f <= f1; f++) push(f, 'frame');
	return ticks.sort((a, b) => a.frame - b.frame);
}
