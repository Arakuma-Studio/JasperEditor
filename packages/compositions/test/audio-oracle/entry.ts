// Browser side of audio-preview-oracle.test.ts: renders the preview mix graph (MixGraph with the real AudioWorklet
// effect slots, meters and limiter) in an OfflineAudioContext, with each clip's source scheduled the way AudioLayer
// schedules it (early by `graph.clipLead(clip)`), and returns the Mix samples.
import type { Rational, RenderAudioClip, RenderAudioMix } from '@jasper/project';
import { installAudioFxPreview } from '../../src/audio/fx-inserts.ts';
import {
	clipHasEffects,
	clipLevelAt,
	MixGraph,
	mixWorkletReady,
	setMixWorkletUrl,
} from '../../src/audio/graph.ts';

type Spec = {
	workletUrl: string;
	mix: RenderAudioMix;
	/** A mix the graph is built with first (an edit then arrives as a new mix of the same topology). */
	before?: RenderAudioMix;
	/** `volume`: what Remotion's per-clip gain applies (AudioLayer's volume callback; static clips here). */
	clips: { clip: RenderAudioClip; data: number[][]; s0: number; volume: number }[];
	fps: Rational;
	length: number;
};

const tick = () => new Promise((r) => setTimeout(r, 0));

async function render(spec: Spec): Promise<{ channels: number[][]; latency: number; leads: number[] }> {
	setMixWorkletUrl(spec.workletUrl);
	installAudioFxPreview();
	const sr = spec.mix.sampleRate;
	const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: spec.length, sampleRate: sr });
	const graph = new MixGraph(ctx as unknown as AudioContext, ctx.destination);
	if (!(await mixWorkletReady(ctx))) throw new Error('the mix worklet did not load');
	const clips = spec.clips.map((c) => c.clip);
	const first = spec.before ?? spec.mix;
	graph.update(first, clips, 0, spec.fps);
	const inputs = spec.clips.map((c) => graph.clipInput(c.clip));
	graph.update(first, clips, 0, spec.fps);
	await tick();
	// effect slots create their worklet nodes once the module is ready (a microtask later)
	await tick();
	graph.update(spec.mix, clips, 0, spec.fps);
	// slots added by this update create their worklet nodes a microtask later
	await tick();
	const leads: number[] = [];
	spec.clips.forEach((c, i) => {
		const buf = ctx.createBuffer(c.data.length, c.data[0]!.length, sr);
		for (const [k, ch] of c.data.entries()) buf.copyToChannel(Float32Array.from(ch), k);
		const src = ctx.createBufferSource();
		src.buffer = buf;
		const remotionGain = ctx.createGain();
		remotionGain.gain.value = c.volume;
		src.connect(remotionGain).connect(inputs[i]!);
		// AudioLayer: the source starts `clipLead` early (past start times trim the offset, as `compensate` does)
		const lead = graph.clipLead(c.clip);
		leads.push(lead);
		const when = c.s0 / sr - lead;
		if (when >= 0) src.start(when);
		else src.start(0, -when);
	});
	const out = await ctx.startRendering();
	return {
		channels: [Array.from(out.getChannelData(0)), Array.from(out.getChannelData(1))],
		latency: graph.latencyPlan.total,
		leads,
	};
}

(window as unknown as { __mix: unknown }).__mix = { render };

type TransportSpec = Omit<Spec, 'before'> & {
	/** Sample (a multiple of 128) where the transport event happens. */
	at: number;
	/** `flush`: the sources stop there and the graph flushes (a seek); `none`: they only stop; `live`: playing, the
	 * graph gets `next` there (an edit during playback). */
	action: 'flush' | 'none' | 'live';
	next?: RenderAudioMix;
};

/**
 * Sound design Phase 0 close-out: the graph at a transport event, rendered offline with the context suspended at
 * `at` (the event happens on a render-quantum boundary, like a main-thread change between two quanta).
 */
async function transport(spec: TransportSpec): Promise<{
	channels: number[][];
	readAhead: { before: number; after: number; paused: number };
	plan: { before: number; after: number };
}> {
	setMixWorkletUrl(spec.workletUrl);
	installAudioFxPreview();
	const sr = spec.mix.sampleRate;
	const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: spec.length, sampleRate: sr });
	const graph = new MixGraph(ctx as unknown as AudioContext, ctx.destination);
	if (!(await mixWorkletReady(ctx))) throw new Error('the mix worklet did not load');
	const clips = spec.clips.map((c) => c.clip);
	graph.update(spec.mix, clips, 0, spec.fps);
	const inputs = spec.clips.map((c) => graph.clipInput(c.clip));
	graph.update(spec.mix, clips, 0, spec.fps);
	await tick();
	await tick();
	if (spec.action === 'live') graph.setPlaying(true);
	const before = { readAhead: graph.latency * sr, plan: graph.latencyPlan.total };
	spec.clips.forEach((c, i) => {
		const buf = ctx.createBuffer(c.data.length, c.data[0]!.length, sr);
		for (const [k, ch] of c.data.entries()) buf.copyToChannel(Float32Array.from(ch), k);
		const src = ctx.createBufferSource();
		src.buffer = buf;
		const remotionGain = ctx.createGain();
		remotionGain.gain.value = c.volume;
		src.connect(remotionGain).connect(inputs[i]!);
		const when = c.s0 / sr - graph.clipLead(c.clip);
		if (when >= 0) src.start(when);
		else src.start(0, -when);
		if (spec.action !== 'live') src.stop(spec.at / sr);
	});
	const after = { readAhead: 0, plan: 0 };
	void ctx.suspend(spec.at / sr).then(async () => {
		if (spec.action === 'flush') graph.flush();
		if (spec.action === 'live' && spec.next) {
			const t = (spec.at / sr) * 705_600_000;
			graph.update(spec.next, clips, t, spec.fps);
			// slots added by the update create their worklet nodes a microtask later
			await tick();
		}
		after.readAhead = graph.latency * sr;
		after.plan = graph.latencyPlan.total;
		await ctx.resume();
	});
	const out = await ctx.startRendering();
	graph.setPlaying(false);
	return {
		channels: [Array.from(out.getChannelData(0)), Array.from(out.getChannelData(1))],
		readAhead: { before: before.readAhead, after: after.readAhead, paused: graph.latency * sr },
		plan: { before: before.plan, after: after.plan },
	};
}

(window as unknown as { __mix: Record<string, unknown> }).__mix.transport = transport;

type PlayedSpec = Spec & {
	/** Sequence frames per second as a number (frame boundaries of the simulated picture clock). */
	fpsValue: number;
	/** `graph.setPlaying(true)` before the start (the transport state while playing). */
	playing?: boolean;
};

/**
 * Sound design Phase 4 verification: the graph as it runs while PLAYING — the picture clock advances one frame at a
 * time and every frame does what the player does: `graph.update(mix, clips, frameTime)` (SequenceComposition's effect)
 * and Remotion's per-clip gain set to the clip's volume callback for that frame (AudioLayer: `gain.value = volume(f)`,
 * a step per frame, read `graphLatency` ahead). Rendered offline with the context suspended at each frame boundary
 * (rounded to the 128-sample render quantum, like a main-thread change between two quanta).
 */
async function played(spec: PlayedSpec): Promise<{ channels: number[][]; latency: number; leads: number[] }> {
	setMixWorkletUrl(spec.workletUrl);
	installAudioFxPreview();
	const sr = spec.mix.sampleRate;
	const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: spec.length, sampleRate: sr });
	const graph = new MixGraph(ctx as unknown as AudioContext, ctx.destination);
	if (!(await mixWorkletReady(ctx))) throw new Error('the mix worklet did not load');
	const clips = spec.clips.map((c) => c.clip);
	graph.update(spec.mix, clips, 0, spec.fps);
	const inputs = spec.clips.map((c) => graph.clipInput(c.clip));
	graph.update(spec.mix, clips, 0, spec.fps);
	await tick();
	await tick();
	if (spec.playing) graph.setPlaying(true);
	graph.update(spec.mix, clips, 0, spec.fps);
	await tick();
	const F = 705_600_000 / spec.fpsValue;
	const gains: GainNode[] = [];
	const leads: number[] = [];
	const levelAt = (i: number, frame: number) => {
		// Remotion's callback for picture frame `frame`: the clip's level `graphLatency` ahead (AudioLayer's leadFrames)
		const c = spec.clips[i]!.clip;
		if (clipHasEffects(c)) return 1;
		return clipLevelAt(c, frame - c.start + graph.latency * spec.fpsValue, spec.fps);
	};
	spec.clips.forEach((c, i) => {
		const buf = ctx.createBuffer(c.data.length, c.data[0]!.length, sr);
		for (const [k, ch] of c.data.entries()) buf.copyToChannel(Float32Array.from(ch), k);
		const src = ctx.createBufferSource();
		src.buffer = buf;
		const remotionGain = ctx.createGain();
		remotionGain.gain.value = levelAt(i, 0);
		gains.push(remotionGain);
		src.connect(remotionGain).connect(inputs[i]!);
		const lead = graph.clipLead(c.clip);
		leads.push(lead);
		const when = c.s0 / sr - lead;
		if (when >= 0) src.start(when);
		else src.start(0, -when);
	});
	const frames = Math.floor((spec.length / sr) * spec.fpsValue);
	for (let k = 1; k < frames; k++) {
		const at = Math.round((k * sr) / spec.fpsValue / 128) * 128;
		if (at <= 0 || at >= spec.length) continue;
		void ctx.suspend(at / sr).then(async () => {
			graph.update(spec.mix, clips, k * F, spec.fps);
			for (const [i, g] of gains.entries()) g.gain.value = levelAt(i, k);
			await ctx.resume();
		});
	}
	const out = await ctx.startRendering();
	if (spec.playing) graph.setPlaying(false);
	return {
		channels: [Array.from(out.getChannelData(0)), Array.from(out.getChannelData(1))],
		latency: graph.latencyPlan.total,
		leads,
	};
}

(window as unknown as { __mix: Record<string, unknown> }).__mix.played = played;
