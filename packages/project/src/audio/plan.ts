// The audio mix topology handed to every renderer (preview Web Audio graph, offline export mixer, loudness and
// ducking analysis): strips in processing order (audio tracks, submixes in order, the Mix), their routes, sends,
// automation and the solo resolution. Pure data (JSON), part of the render snapshot.
//
// Signal path of every strip (Premiere's documented order, as in the FilmCraft reference):
//
//   track input (clips: gain → clip effects → clip volume → fades → clip pan → track width)
//     → input map → pre-fader inserts → pre-fader sends → mute → fader (volume) → meter
//     → post-fader inserts → post-fader sends → pan / balance / 5.1 panner → output (submix or Mix)
//   submix: bus sum → the same strip path → output (the Mix or a later submix)
//   Mix:    bus sum → pre-fader inserts → fader → post-fader inserts → loudness gain → true-peak limiter → meter → out
//
// Solo: when any strip is soloed, a strip stays audible if it is soloed or solo-safe, feeds (directly or through
// submixes) a soloed or solo-safe strip, or is fed by one. Everything else is solo-muted (silent, sends included).
// Track mute sits after the pre-fader sends, so pre-fader sends of a muted track keep sending, as in Premiere.
import type { AudioChannelFormat, AutomationMode, InputMap } from '../schema/audio.ts';
import { LANE_MUTE, LANE_PAN51_CENTER, LANE_PAN51_LFE, LANE_PAN51_X, LANE_PAN51_Y } from '../schema/audio.ts';
import type { Animatable } from '../schema/common.ts';
import type { EffectInstance, Sequence } from '../schema/sequence.ts';
import {
	laneAnimatable,
	listStrips,
	loudnessGainOf,
	MASTER_STRIP_ID,
	type StripKind,
	type StripView,
} from './strip.ts';

export type RenderSend = {
	id: string;
	/** Destination strip id (a submix). */
	target: string;
	levelDb: Animatable<number>;
	/** −100 … 100. */
	pan: number;
	preFader: boolean;
};

export type RenderStrip = {
	id: string;
	kind: StripKind;
	label: string;
	name: string;
	format: AudioChannelFormat;
	/** Format of the bus this strip's output feeds (`null` for the Mix). */
	outputFormat: AudioChannelFormat | null;
	automation: AutomationMode;
	/** Volume (dB), pan (−100…100) and the mixer lanes, already reduced to their static value when the mode is Off. */
	volumeDb: Animatable<number>;
	pan: Animatable<number>;
	/** 0 / 1 hold lane. */
	mute: Animatable<number>;
	pan51: {
		x: Animatable<number>;
		y: Animatable<number>;
		center: Animatable<number>;
		lfe: Animatable<number>;
	};
	inputMap: InputMap;
	/** Enabled inserts in slot order (`postFader` says where they sit). */
	inserts: EffectInstance[];
	sends: RenderSend[];
	/** Destination strip id; null for the Mix. */
	output: string | null;
	/** Solo-muted: contributes nothing (sends included). */
	silent: boolean;
	/** Muted for the whole range with no pre-fader send: its clips need not be decoded. */
	inaudible: boolean;
};

export type RenderAudioMix = {
	sampleRate: number;
	masterFormat: AudioChannelFormat;
	/** Processing order: audio tracks, submixes (a submix only feeds a later one), the Mix last. */
	strips: RenderStrip[];
	/**
	 * Loudness normalisation of the Mix and its true-peak limiter ceiling, when enabled + analysed: the analysis's
	 * converged delivery for the current target (`loudnessGainOf`), else `target − measured` at the target ceiling.
	 */
	loudness: { gainDb: number; truePeakDb: number } | null;
};

function staticOf(a: Animatable<number>, off: boolean): Animatable<number> {
	return off && a.keyframes.length ? { value: a.value, keyframes: [] } : a;
}

/** Ids of the strips that stay audible under solo (all of them when nothing is soloed). */
export function soloAudible(strips: readonly StripView[]): Set<string> {
	const all = new Set(strips.map((s) => s.id));
	const soloed = strips.filter((s) => s.kind !== 'master' && s.solo);
	if (soloed.length === 0) return all;
	// edges: strip → output, strip → send targets
	const out = new Map<string, string[]>();
	for (const s of strips) {
		const targets = [...(s.output ? [s.output] : []), ...s.sends.filter((x) => !x.mute).map((x) => x.target)];
		out.set(s.id, targets);
	}
	const into = new Map<string, string[]>();
	for (const [src, ts] of out) for (const t of ts) into.set(t, [...(into.get(t) ?? []), src]);
	const keep = new Set<string>([MASTER_STRIP_ID]);
	const seeds = strips.filter((s) => s.kind !== 'master' && (s.solo || s.soloSafe)).map((s) => s.id);
	// downstream of a soloed/safe strip (it must reach the Mix) and upstream (what feeds it). Each walk has its own
	// visited set: a strip already kept by another seed's walk must still be walked through (A1 → S1 → soloed S2
	// keeps everything else that feeds S1).
	const walk = (start: string, edges: Map<string, string[]>) => {
		const seen = new Set<string>([start]);
		const stack = [start];
		while (stack.length) {
			const id = stack.pop()!;
			keep.add(id);
			for (const n of edges.get(id) ?? [])
				if (!seen.has(n)) {
					seen.add(n);
					stack.push(n);
				}
		}
	};
	for (const s of seeds) {
		walk(s, out);
		walk(s, into);
	}
	return keep;
}

/** The mix topology of a sequence (the `audioMix` of the render snapshot). */
export function buildAudioMix(seq: Sequence): RenderAudioMix {
	const views = listStrips(seq);
	const audible = soloAudible(views);
	const byId = new Map(views.map((v) => [v.id, v]));
	const strips: RenderStrip[] = views.map((v) => {
		const off = v.automation === 'off';
		const lane = (k: string) => staticOf(laneAnimatable(v, k) ?? { value: 0, keyframes: [] }, off);
		const sends: RenderSend[] = v.sends
			.filter((x) => !x.mute && byId.get(x.target)?.kind === 'submix')
			.map((x) => ({
				id: x.id,
				target: x.target,
				levelDb: staticOf(x.levelDb, off),
				pan: x.pan ?? 0,
				preFader: !!x.preFader,
			}));
		const mute = lane(LANE_MUTE);
		const mutedThroughout =
			mute.keyframes.length === 0 ? mute.value >= 0.5 : mute.keyframes.every((k) => k.value >= 0.5);
		const silent = !audible.has(v.id);
		const outputFormat = v.output === null ? null : (byId.get(v.output)?.format ?? null);
		return {
			id: v.id,
			kind: v.kind,
			label: v.label,
			name: v.name,
			format: v.format,
			outputFormat,
			automation: v.automation,
			volumeDb: staticOf(v.volumeDb, off),
			pan: staticOf(v.pan, off),
			mute,
			pan51: {
				x: lane(LANE_PAN51_X),
				y: lane(LANE_PAN51_Y),
				center: lane(LANE_PAN51_CENTER),
				lfe: lane(LANE_PAN51_LFE),
			},
			inputMap: v.inputMap,
			inserts: v.effects.filter((e) => e.enabled),
			sends,
			output: v.output,
			silent,
			inaudible: silent || (mutedThroughout && !sends.some((x) => x.preFader)),
		};
	});
	// A submix that nothing audible feeds is inaudible too (no need to run its inserts on silence).
	// the preview's normalisation: the analysis's converged delivery gain and limiter ceiling (= the export's PCM path)
	const loud = loudnessGainOf(seq.master.loudness);
	return {
		sampleRate: (seq.settings.audioSampleRate as number | undefined) ?? 48000,
		masterFormat: (seq.settings.masterLayout as AudioChannelFormat | undefined) ?? 'stereo',
		strips,
		loudness: loud ? { gainDb: loud.gainDb, truePeakDb: loud.truePeakDb } : null,
	};
}

/** Strip ids whose clips must be played (not silent, not muted throughout without pre-fader sends). */
export function playedTracks(mix: RenderAudioMix): Set<string> {
	return new Set(mix.strips.filter((s) => s.kind === 'track' && !s.inaudible).map((s) => s.id));
}
