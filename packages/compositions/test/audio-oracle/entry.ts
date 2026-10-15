// Browser side of audio-preview-oracle.test.ts: renders the preview mix graph (MixGraph with the real AudioWorklet
// effect slots, meters and limiter) in an OfflineAudioContext, with each clip's source scheduled the way AudioLayer
// schedules it (early by `graph.clipLead(clip)`), and returns the Mix samples.
import type { Rational, RenderAudioClip, RenderAudioMix } from '@jasper/project';
import { installAudioFxPreview } from '../../src/audio/fx-inserts.ts';
import { MixGraph, mixWorkletReady, setMixWorkletUrl } from '../../src/audio/graph.ts';

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
