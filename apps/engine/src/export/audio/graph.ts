// The audio section of the native composite (S04:RN-021) and of the Remotion path's native mix (audio-fx): one
// chain per audio clip, mixed with `amix normalize=0`, padded/trimmed to the output length → `[aout]`.
// - Clips without effects, pan or reversal: ffmpeg only — `atrim/asetpts/atempo/aresample/volume/afade/adelay`.
// - Clips with them (audio-fx): the shared DSP chain (plan.ts / stream.ts) on a raw `pipe:N` input, placed with
//   `adelay`; their levels, fades and pan are applied by the chain.
import {
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type RenderAudioClip,
	type RenderAudioFade,
	type RenderSnapshot,
} from '@jasper/project';
import { sec } from '../../tools/ffmpeg.ts';
import { audioVolumeFilters } from '../keyframed.ts';
import type { LocalMedia } from '../planner.ts';
import { type AudioDspPlan, atempoChain, audioClipNeedsDsp, planAudioDsp, SAMPLE_RATE } from './plan.ts';

export type AudioMix = {
	chains: string[];
	/** DSP clips: the plan streamed into the composite's `pipe:<fd>`. */
	streams: { fd: number; plan: AudioDspPlan }[];
};

/** The audio stream of a clip's media (its own `streamIndex`, else the first audio stream). */
export function audioStreamOf(a: RenderAudioClip, m: LocalMedia): number | undefined {
	return m.record.probe.streams.find((s) => s.index === a.channels.streamIndex && s.type === 'audio')
		? a.channels.streamIndex
		: m.record.probe.streams.find((s) => s.type === 'audio')?.index;
}

export function buildAudioMix(o: {
	snapshot: RenderSnapshot;
	durationSec: number;
	audioChannels: 1 | 2;
	media(mediaId: string): LocalMedia | null;
	addInput(args: string[]): number;
	/** fd of the first DSP pipe (`3 + video streams`). */
	firstFd: number;
}): AudioMix {
	const snap = o.snapshot;
	const fps = snap.settings.fps;
	const R0 = snap.range.start;
	const R1 = snap.range.end;
	const frameSec = fps.den / fps.num;
	const F = flicksPerFrame(fps);
	const layout = o.audioChannels === 1 ? 'mono' : 'stereo';
	const totalSamples = Math.round(o.durationSec * SAMPLE_RATE);
	const chains: string[] = [];
	const streams: AudioMix['streams'] = [];
	const mixIn: string[] = [];
	let ai = 0;
	for (const a of snap.audioClips) {
		const m = o.media(a.mediaId);
		if (!m) continue; // offline audio is silent
		const stream = audioStreamOf(a, m);
		if (stream === undefined) continue;
		if (audioClipNeedsDsp(a)) {
			const plan = planAudioDsp({
				clip: a,
				media: { path: m.path, streamIndex: stream },
				fps,
				range: snap.range,
				master: snap.master,
			});
			if (!plan) continue;
			const fd = o.firstFd + streams.length;
			streams.push({ fd, plan });
			const k = o.addInput(['-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', `pipe:${fd}`]);
			const chain = [
				'asetpts=PTS-STARTPTS',
				`aformat=sample_fmts=fltp:channel_layouts=${layout}`,
				`atrim=end_sample=${plan.outCount}`,
				...(plan.delay > 0 ? [`adelay=delays=${plan.delay}S:all=1`] : []),
			];
			chains.push(`[${k}:a:0]${chain.join(',')}[a${ai}]`);
			mixIn.push(`[a${ai}]`);
			ai++;
			continue;
		}
		// A crossfade plays the clip's handles: content from `headHandle` frames before its start to
		// `tailHandle` frames after its end (S10:TUI-052); its fades cover the span.
		const f0 = Math.max(a.start - (a.headHandle ?? 0), R0);
		const f1 = Math.min(a.start + a.duration + (a.tailHandle ?? 0), R1);
		if (f1 <= f0) continue;
		const n = f1 - f0;
		const startSec = Math.max(0, audioContentSec(a, f0, F));
		const k = o.addInput(['-ss', sec(startSec), '-t', sec(n * frameSec * a.speed.rate + 0.1), '-i', m.path]);
		const samples = Math.round(n * frameSec * SAMPLE_RATE);
		const delay = Math.round((f0 - R0) * frameSec * SAMPLE_RATE);
		const chain = [
			'asetpts=PTS-STARTPTS',
			...atempoChain(a.speed.rate),
			`aresample=${SAMPLE_RATE}`,
			`aformat=sample_fmts=fltp:channel_layouts=${layout}`,
			// Clip, track and master volume (keyframed: per-frame gain, keyframed.ts).
			...audioVolumeFilters(a, snap.master, f0, f1, fps),
			`atrim=end_sample=${samples}`,
			'asetpts=PTS-STARTPTS',
			...audioFadeFilters(a.fades, f0, frameSec),
			...(delay > 0 ? [`adelay=delays=${delay}S:all=1`] : []),
		];
		chains.push(`[${k}:${stream}]${chain.join(',')}[a${ai}]`);
		mixIn.push(`[a${ai}]`);
		ai++;
	}
	if (mixIn.length === 0) {
		chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=${layout},atrim=end_sample=${totalSamples}[aout]`);
	} else {
		const mix =
			mixIn.length === 1
				? `${mixIn[0]}anull`
				: `${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=longest:dropout_transition=0`;
		chains.push(`${mix},apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[aout]`);
	}
	return { chains, streams };
}

/**
 * Audio fades of a clip chain whose first sample is sequence frame `f0`, as `afade` (sample accurate;
 * `tri` = linear, `qsin` = equal power). A fade that began before `f0` is padded like `fadeFilters`.
 */
export function audioFadeFilters(
	fades: readonly RenderAudioFade[] | undefined,
	f0: number,
	frameSec: number,
): string[] {
	const samplesOf = (frames: number) => Math.round(frames * frameSec * SAMPLE_RATE);
	const live = (fades ?? []).filter((f) => !(f.type === 'in' && f.start + f.frames <= f0));
	if (live.length === 0) return [];
	const pad = samplesOf(Math.max(0, ...live.map((f) => f0 - f.start)));
	return [
		...(pad > 0 ? [`adelay=delays=${pad}S:all=1`] : []),
		...live.map(
			(f) =>
				`afade=t=${f.type}:ss=${samplesOf(f.start - f0) + pad}:ns=${samplesOf(f.frames)}:curve=${f.curve === 'equal-power' ? 'qsin' : 'tri'}`,
		),
		...(pad > 0 ? [`atrim=start_sample=${pad}`, 'asetpts=PTS-STARTPTS'] : []),
	];
}

/** Content time in seconds of an audio clip at sequence frame `f` (S01:CLP-004; before `start` = head handle). */
function audioContentSec(a: RenderAudioClip, f: number, F: number): number {
	const i = f - a.start;
	return (a.sourceIn + i * F * a.speed.rate) / FLICKS_PER_SECOND;
}
