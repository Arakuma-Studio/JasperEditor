// Native export builder (S03:ENG-030, S04:RN-021/022, ARCHITECTURE §9.5): one input per clip with input
// seeking; per layer setpts (speed) → fps → crop → format=rgba → scale → flips → rotate (transparent, grown
// bounds) → alpha multiply → overlay at the offset derived from the @jasper/project layer matrix; bottom → top
// over a `color` background; audio atrim/atempo/aresample/volume/adelay + amix normalize=0 + pad/trim;
// the selected video encoder (D-13: hardware H.264 / OpenH264 / libx264 in dev / AV1 / VP9) with bt709 tags +
// AAC (MP4, faststart) or Opus (WebM). Inputs are referenced by index only (S04:SC-004).
// Transitions (S01 §13) are built in: a clip's layer also covers its handles, the transition ramps become
// `fade=…:alpha=1` on the layer (the same linear ramps `fadeFactor` evaluates for the composition), the black
// of a dip to black is a colour layer under the track's clips, and audio fades are `afade`.
import {
	clipContentTime,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type Rational,
	type RenderAudioClip,
	type RenderAudioFade,
	type RenderFade,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';
import { alphaDecoder } from '../media/alpha.ts';
import { audioEncodeArgs, LEGACY_X264_CHOICE, videoEncodeArgs } from '../tools/encoders.ts';
import { sec } from '../tools/ffmpeg.ts';
import type { LocalMedia, OutputSpec } from './planner.ts';

export const SAMPLE_RATE = 48000;
/**
 * swscale flags for every YUV ↔ RGB conversion of the composite. Without `accurate_rnd` the default
 * converters round down (a full-frame clip came out about one code value darker per generation), and
 * without the full-chroma flags 4:2:0 chroma is up/down-sampled with the cheap horizontal path.
 */
export const SWS_FLAGS = 'flags=bicubic+accurate_rnd+full_chroma_int+full_chroma_inp';
/**
 * BT.709 tags on the frames themselves. FFmpeg 7.1 takes an encoder's colour description from its input
 * frames, so `-color_primaries` / `-color_trc` alone left ProRes masters untagged (and H.264 half tagged).
 */
export const BT709_FRAME_TAGS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
const OFFLINE_RGBA: [number, number, number, number] = [0.55, 0.05, 0.08, 1];

export type NativeSourceResolver = {
	/** Online local media for a mediaId (null = offline). */
	media(mediaId: string): LocalMedia | null;
	/** Motion-graphic master file (ProRes 4444, frame 0 = clip start) for a clip, from WP-2G. */
	mgMaster(clipId: string): string | null;
};

export type NativeBuildOptions = {
	snapshot: RenderSnapshot;
	output: OutputSpec;
	outputFile: string;
	sources: NativeSourceResolver;
	threads: number;
	/** Single-frame PNG (stills): no audio, RGB output. */
	still?: boolean;
};

export type NativeGraph = {
	/** ffmpeg arguments without the global `-hide_banner … -progress` prefix. */
	args: string[];
	/** Filtergraph text (tests; also written to a script file when large). */
	filter: string;
	inputs: string[][];
	outputFrames: number;
	durationSec: number;
};

const fmt = (n: number) => {
	const r = Math.round(n * 1e6) / 1e6;
	return Object.is(r, -0) ? '0' : String(r);
};

function colorHex([r, g, b, a]: readonly number[]): string {
	const c = (x: number) =>
		Math.round(Math.min(1, Math.max(0, x ?? 0)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `0x${c(r!)}${c(g!)}${c(b!)}${c(a ?? 1)}`;
}

function rate(r: Rational): string {
	return `${r.num}/${r.den}`;
}

function evenCeil(x: number): number {
	return Math.max(1, Math.ceil(x - 1e-6));
}

/** atempo chain for a constant speed (each instance limited to 0.5…100). */
export function atempoChain(speed: number): string[] {
	if (Math.abs(speed - 1) < 1e-9) return [];
	const parts: number[] = [];
	let s = speed;
	while (s < 0.5) {
		parts.push(0.5);
		s /= 0.5;
	}
	while (s > 100) {
		parts.push(100);
		s /= 100;
	}
	parts.push(s);
	return parts.map((p) => `atempo=${fmt(p)}`);
}

/** Matrix of `in_color_matrix` for a probed stream (untagged HD is BT.709 like browsers assume). */
function inColor(m: LocalMedia | null): string {
	const vs = m?.record.probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') return '';
	const matrix = vs.color.matrix;
	const cm =
		matrix === 'bt709'
			? 'bt709'
			: matrix === 'bt470bg' || matrix === 'smpte170m'
				? 'bt601'
				: vs.height >= 720
					? 'bt709'
					: 'bt601';
	return `:in_color_matrix=${cm}:in_range=${vs.color.range === 'pc' ? 'pc' : 'tv'}`;
}

type LayerPlan =
	| { clip: RenderVisualClip; f0: number; f1: number }
	/** Full-frame colour under a track's clips (the black of a dip to black). */
	| { matte: { color: readonly number[] }; f0: number; f1: number };

/**
 * Transition ramps of a layer whose first frame is sequence frame `f0`, as ffmpeg `fade` filters on the
 * alpha channel. `fade` counts frames from the layer's first one and cannot start before it, so a ramp that
 * begins earlier (a cross dissolve's ramp starts one frame before the span; a range export may start inside
 * a ramp) gets `pad` throwaway frames in front, removed again after the fades.
 */
export function fadeFilters(fades: readonly RenderFade[] | undefined, f0: number): string[] {
	const live = (fades ?? []).filter((f) => !(f.type === 'in' && f.start + f.frames <= f0));
	if (live.length === 0) return [];
	const pad = Math.max(0, ...live.map((f) => f0 - f.start));
	return [
		...(pad > 0 ? [`tpad=start=${pad}`] : []),
		...live.map((f) => `fade=t=${f.type}:s=${f.start - f0 + pad}:n=${f.frames}:alpha=1`),
		...(pad > 0 ? [`trim=start_frame=${pad}`] : []),
	];
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

export function buildNativeGraph(o: NativeBuildOptions): NativeGraph {
	const { snapshot: snap, output } = o;
	const fps = snap.settings.fps;
	const W = snap.settings.width;
	const H = snap.settings.height;
	const R0 = snap.range.start;
	const R1 = snap.range.end;
	const frames = R1 - R0;
	const frameSec = fps.den / fps.num;
	const T = frames * frameSec;
	const F = flicksPerFrame(fps);

	const encoder = output.encoder ?? LEGACY_X264_CHOICE;
	const enc = o.still
		? null
		: videoEncodeArgs(encoder, {
				crf: output.crf,
				speed: output.speed ?? 'balanced',
				width: output.width,
				height: output.height,
				fps: output.fps,
				...(output.bitrateKbps ? { bitrateKbps: output.bitrateKbps } : {}),
				...(output.proresProfile ? { proresProfile: output.proresProfile } : {}),
			});
	const inputs: string[][] = [];
	const chains: string[] = [];
	const addInput = (args: string[]) => {
		inputs.push(args);
		return inputs.length - 1;
	};

	// Background: sequence-sized, sequence colour, one extra frame of margin (the final trim is exact).
	chains.push(
		`color=c=${colorHex(snap.settings.backgroundColor)}:s=${W}x${H}:r=${rate(fps)}:d=${fmt(T + frameSec)},format=rgba[bg]`,
	);
	let last = 'bg';
	let li = 0;

	const layers: LayerPlan[] = [];
	for (const track of snap.videoTracks) {
		for (const m of track.mattes ?? []) {
			const f0 = Math.max(m.start, R0);
			const f1 = Math.min(m.start + m.duration, R1);
			if (f1 > f0) layers.push({ matte: m, f0, f1 });
		}
		for (const c of track.clips) {
			// With transitions a clip is drawn from its head handle to the end of its tail handle (S01:TRN-003).
			const f0 = Math.max(c.start - (c.headHandle ?? 0), R0);
			const f1 = Math.min(c.start + c.duration + (c.tailHandle ?? 0), R1);
			if (f1 > f0) layers.push({ clip: c, f0, f1 });
		}
	}

	const half = frameSec / 2;
	for (const layer of layers) {
		const { f0, f1 } = layer;
		const n = f1 - f0;
		const t0 = (f0 - R0) * frameSec;
		const shift = `setpts=PTS-STARTPTS+round(${f0 - R0}*${fps.den}/(${fps.num}*TB))`;
		const enable = `enable='between(t,${fmt(t0 - half)},${fmt(t0 + n * frameSec - half)})'`;
		if ('matte' in layer) {
			const label = `l${li++}`;
			chains.push(
				`color=c=${colorHex(layer.matte.color)}:s=${W}x${H}:r=${rate(fps)}:d=${fmt(n * frameSec + frameSec)},format=rgba,trim=end_frame=${n},${shift}[${label}]`,
				`[${last}][${label}]overlay=x=0:y=0:format=rgb:eof_action=pass:${enable}[o${label}]`,
			);
			last = `o${label}`;
			continue;
		}
		const c = layer.clip;
		const props = resolveLayerProps(c, clipContentTime(c, f0, fps));
		const bw = Math.max(1, Math.round(c.intrinsicBox.width));
		const bh = Math.max(1, Math.round(c.intrinsicBox.height));
		const label = `l${li++}`;
		const f: string[] = [];
		let src: string;

		const local = 'mediaId' in c.source ? o.sources.media(c.source.mediaId) : null;
		const mg = c.kind === 'motion-graphic' ? o.sources.mgMaster(c.clipId) : null;
		const margin = 2 * frameSec;
		if ((c.kind === 'video' || c.kind === 'animated-image') && local) {
			const startSec = clipContentTime(c, f0, fps) / FLICKS_PER_SECOND;
			const srcDur = n * frameSec * c.speed.rate + margin;
			const dec = alphaDecoder(local.record.probe);
			const k = addInput([
				...(dec ? ['-c:v', dec] : []),
				'-ss',
				sec(startSec),
				'-t',
				sec(srcDur),
				'-i',
				local.path,
			]);
			src = `[${k}:v:0]`;
			f.push(`setpts=(PTS-STARTPTS)/${fmt(c.speed.rate)}`, `fps=${rate(fps)}`, `trim=end_frame=${n}`);
			f.push(`scale=${bw}:${bh}${inColor(local)}:${SWS_FLAGS}`, 'setsar=1', 'format=rgba');
		} else if (c.kind === 'still' && local) {
			const k = addInput([
				'-loop',
				'1',
				'-framerate',
				rate(fps),
				'-t',
				sec(n * frameSec + margin),
				'-i',
				local.path,
			]);
			src = `[${k}:v:0]`;
			f.push('setpts=PTS-STARTPTS', `fps=${rate(fps)}`, `trim=end_frame=${n}`);
			f.push(`scale=${bw}:${bh}${inColor(local)}:${SWS_FLAGS}`, 'setsar=1', 'format=rgba');
		} else if (c.kind === 'motion-graphic' && mg) {
			const startSec = (f0 - c.start) * frameSec;
			const k = addInput(['-ss', sec(startSec), '-t', sec(n * frameSec + margin), '-i', mg]);
			src = `[${k}:v:0]`;
			f.push(
				'setpts=PTS-STARTPTS',
				`fps=${rate(fps)}`,
				`trim=end_frame=${n}`,
				`scale=${bw}:${bh}`,
				'setsar=1',
				'format=rgba',
			);
		} else {
			// Solids, and offline media as the "Media Offline" colour card (S04:AS-010).
			const rgba = 'color' in c.source ? c.source.color : OFFLINE_RGBA;
			src = '';
			f.push(
				`color=c=${colorHex(rgba)}:s=${bw}x${bh}:r=${rate(fps)}:d=${fmt(n * frameSec + frameSec)}`,
				'format=rgba',
				`trim=end_frame=${n}`,
			);
		}

		// Effects in stack order (crop first by convention, S01:FX-003); only native-capable ones reach here.
		for (const fx of props.effects) {
			if (!fx.enabled) continue;
			if (fx.effectId === 'jasper.crop') {
				const l = Math.round((Number(fx.params.left ?? 0) / 100) * bw);
				const r = Math.round((Number(fx.params.right ?? 0) / 100) * bw);
				const t = Math.round((Number(fx.params.top ?? 0) / 100) * bh);
				const b = Math.round((Number(fx.params.bottom ?? 0) / 100) * bh);
				const cw = Math.max(1, bw - l - r);
				const ch = Math.max(1, bh - t - b);
				if (l || r || t || b) f.push(`crop=${cw}:${ch}:${l}:${t}`, `pad=${bw}:${bh}:${l}:${t}:color=black@0`);
			} else if (fx.effectId === 'jasper.flip-horizontal') f.push('hflip');
			else if (fx.effectId === 'jasper.flip-vertical') f.push('vflip');
		}

		// Motion: M = P + R·S·(q − A) (S03:DM-010). Scale → flips → rotation about the center.
		const tv = props.transform;
		let outW = bw;
		let outH = bh;
		let cx = W / 2;
		let cy = H / 2;
		if (tv) {
			const sxs = ((tv.uniformScale ? tv.scale : tv.scaleWidth) / 100) * (tv.flipH ? -1 : 1);
			const sys = (tv.scale / 100) * (tv.flipV ? -1 : 1);
			const sw = Math.max(1, Math.round(Math.abs(sxs) * bw));
			const sh = Math.max(1, Math.round(Math.abs(sys) * bh));
			if (sw !== bw || sh !== bh) f.push(`scale=${sw}:${sh}:flags=bicubic`);
			if (sxs < 0) f.push('hflip');
			if (sys < 0) f.push('vflip');
			outW = sw;
			outH = sh;
			const deg = ((((tv.rotation % 360) + 540) % 360) - 180) as number; // (-180, 180]
			const a = (deg * Math.PI) / 180;
			if (Math.abs(deg) < 1e-9) {
				// none
			} else if (Math.abs(deg - 90) < 1e-9) {
				f.push('transpose=clock');
				[outW, outH] = [sh, sw];
			} else if (Math.abs(deg + 90) < 1e-9) {
				f.push('transpose=cclock');
				[outW, outH] = [sh, sw];
			} else if (Math.abs(Math.abs(deg) - 180) < 1e-9) {
				f.push('hflip', 'vflip');
			} else {
				outW = evenCeil(Math.abs(sw * Math.cos(a)) + Math.abs(sh * Math.sin(a)));
				outH = evenCeil(Math.abs(sw * Math.sin(a)) + Math.abs(sh * Math.cos(a)));
				f.push(`rotate=a=${fmt(a)}:ow=${outW}:oh=${outH}:c=black@0`);
			}
			const m = props.matrix;
			cx = m.a * (bw / 2) + m.c * (bh / 2) + m.e;
			cy = m.b * (bw / 2) + m.d * (bh / 2) + m.f;
		}
		if (props.opacity < 100) f.push(`colorchannelmixer=aa=${fmt(props.opacity / 100)}`);
		f.push(...fadeFilters(c.fades, f0));
		// Shift the layer to its place on the timeline in whole frames. `setpts` truncates its result, so an
		// offset written in decimal seconds (3.333333 s for frame 100 at 30 fps) landed one frame early.
		f.push(shift);
		chains.push(`${src}${f.join(',')}[${label}]`);

		const x = Math.round(cx - outW / 2);
		const y = Math.round(cy - outH / 2);
		const next = `o${label}`;
		chains.push(`[${last}][${label}]overlay=x=${x}:y=${y}:format=rgb:eof_action=pass:${enable}[${next}]`);
		last = next;
	}

	// Output conversion: rate, size (fit/fill/stretch), bt709 TV-range 4:2:0 (S04:RN-021, EX-003/004).
	const vout: string[] = [];
	const sameRate = output.fps.num * fps.den === fps.num * output.fps.den;
	if (!sameRate) vout.push(`fps=${rate(output.fps)}`);
	if (output.width !== W || output.height !== H) {
		if (output.scaling === 'stretch') vout.push(`scale=${output.width}:${output.height}`);
		else if (output.scaling === 'fill')
			vout.push(
				`scale=${output.width}:${output.height}:force_original_aspect_ratio=increase`,
				`crop=${output.width}:${output.height}`,
			);
		else
			vout.push(
				`scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease`,
				`pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
			);
	}
	vout.push(`trim=end_frame=${output.frames}`, 'setpts=PTS-STARTPTS');
	if (o.still) vout.push('format=rgb24');
	else {
		// The encoder's pixel format (yuv420p; nv12 + hwupload for QSV/VAAPI; 4:2:2/4:4:4 10-bit for ProRes).
		vout.push(`scale=out_color_matrix=bt709:out_range=tv:${SWS_FLAGS}`, 'setsar=1', BT709_FRAME_TAGS);
		vout.push(...enc!.filters);
	}
	chains.push(`[${last}]${vout.join(',')}[vout]`);

	// Audio (skipped for stills).
	if (!o.still) {
		const totalSamples = Math.round(output.durationSec * SAMPLE_RATE);
		const mixIn: string[] = [];
		let ai = 0;
		for (const a of snap.audioClips) {
			const m = o.sources.media(a.mediaId);
			if (!m) continue; // offline audio is silent
			const stream = m.record.probe.streams.find(
				(s) => s.index === a.channels.streamIndex && s.type === 'audio',
			)
				? a.channels.streamIndex
				: m.record.probe.streams.find((s) => s.type === 'audio')?.index;
			if (stream === undefined) continue;
			const f0 = Math.max(a.start, R0);
			const f1 = Math.min(a.start + a.duration, R1);
			if (f1 <= f0) continue;
			const n = f1 - f0;
			const startSec = audioContentSec(a, f0, F);
			const k = addInput(['-ss', sec(startSec), '-t', sec(n * frameSec * a.speed.rate + 0.1), '-i', m.path]);
			const db = a.gainDb + a.volumeDb.value + a.track.volumeDb.value + snap.master.volumeDb.value;
			const samples = Math.round(n * frameSec * SAMPLE_RATE);
			const delay = Math.round((f0 - R0) * frameSec * SAMPLE_RATE);
			const chain = [
				'asetpts=PTS-STARTPTS',
				...atempoChain(a.speed.rate),
				`aresample=${SAMPLE_RATE}`,
				`aformat=sample_fmts=fltp:channel_layouts=${output.audioChannels === 1 ? 'mono' : 'stereo'}`,
				`volume=${fmt(db)}dB`,
				`atrim=end_sample=${samples}`,
				'asetpts=PTS-STARTPTS',
				...audioFadeFilters(a.fades, f0, frameSec),
				...(delay > 0 ? [`adelay=delays=${delay}S:all=1`] : []),
			];
			chains.push(`[${k}:${stream}]${chain.join(',')}[a${ai}]`);
			mixIn.push(`[a${ai}]`);
			ai++;
		}
		const layout = output.audioChannels === 1 ? 'mono' : 'stereo';
		if (mixIn.length === 0) {
			chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=${layout},atrim=end_sample=${totalSamples}[aout]`);
		} else {
			const mix =
				mixIn.length === 1
					? `${mixIn[0]}anull`
					: `${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=longest:dropout_transition=0`;
			chains.push(`${mix},apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[aout]`);
		}
	}

	const filter = chains.join(';\n');
	const args: string[] = [...(enc?.pre ?? [])];
	for (const inp of inputs) args.push(...inp);
	args.push('-filter_complex', filter, '-map', '[vout]');
	if (o.still) {
		args.push('-frames:v', '1', '-update', '1', '-f', 'image2', '-c:v', 'png', o.outputFile);
	} else {
		args.push(
			'-map',
			'[aout]',
			...enc!.video,
			'-colorspace',
			'bt709',
			'-color_primaries',
			'bt709',
			'-color_trc',
			'bt709',
			'-color_range',
			'tv',
			'-r',
			rate(output.fps),
			'-frames:v',
			String(output.frames),
			...audioEncodeArgs(encoder.audioEncoder, output.audioBitrateKbps),
			'-ar',
			String(SAMPLE_RATE),
			'-ac',
			String(output.audioChannels),
			'-threads',
			String(Math.max(1, o.threads)),
			...(encoder.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			encoder.container,
			o.outputFile,
		);
	}
	return { args, filter, inputs, outputFrames: output.frames, durationSec: output.durationSec };
}

/** Content time in seconds of an audio clip at sequence frame `f` (S01:CLP-004). */
function audioContentSec(a: RenderAudioClip, f: number, F: number): number {
	const i = f - a.start;
	return (a.sourceIn + i * F * a.speed.rate) / FLICKS_PER_SECOND;
}
