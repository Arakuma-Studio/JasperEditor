// Browser side of audio-preview-oracle.test.ts: renders the preview mix graph (MixGraph with the real AudioWorklet
// effect slots, meters and limiter) in an OfflineAudioContext, with each clip's source scheduled the way AudioLayer
// schedules it (early by `graph.clipLead(clip)`), and returns the Mix samples.
import type { Rational, RenderAudioClip, RenderAudioMix } from '@jasper/project';
import { installAudioFxPreview } from '../../src/audio/fx-inserts.ts';
import { MixGraph, mixWorkletReady, setMixWorkletUrl } from '../../src/audio/graph.ts';

type Spec = {
	workletUrl: string;
	mix: RenderAudioMix;
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
	graph.update(spec.mix, clips, 0, spec.fps);
	const inputs = spec.clips.map((c) => graph.clipInput(c.clip));
	graph.update(spec.mix, clips, 0, spec.fps);
	// effect slots create their worklet nodes once the module is ready (a microtask later)
	await tick();
	graph.update(spec.mix, clips, 0, spec.fps);
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
