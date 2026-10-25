// Actual Source/Program preview fixture: observes PCM at the Web Audio destination and uses public Player controls.
import type { MediaHandle } from '@jasper/project';
import { Player, type PlayerRef } from '@remotion/player';
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { setMixWorkletUrl } from '../../src/audio/graph.ts';
import {
	AssetComposition,
	DEFAULT_RENDER_OPTIONS,
	type RenderDoc,
	SequenceComposition,
} from '../../src/index.ts';

type Config = { mode: 'source'; media: MediaHandle } | { mode: 'program'; doc: RenderDoc };
const config = (window as unknown as { __config: Config }).__config;
const outputs: AnalyserNode[] = [];
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
	if (args[0] instanceof AudioDestinationNode) {
		const meter = this.context.createAnalyser();
		meter.fftSize = 2048;
		outputs.push(meter);
		Reflect.apply(connect, this, [meter, ...args.slice(1)]);
		Reflect.apply(connect, meter, [args[0]]);
		return args[0];
	}
	return Reflect.apply(connect, this, args);
} as typeof AudioNode.prototype.connect;
setMixWorkletUrl('/worklet.js');
const ref = createRef<PlayerRef>();
const common = {
	ref,
	compositionWidth: 64,
	compositionHeight: 36,
	durationInFrames: 30,
	fps: 30,
	style: { width: 64, height: 36 },
	controls: false,
	moveToBeginningWhenEnded: false,
	acknowledgeRemotionLicense: true,
};
createRoot(document.getElementById('player')!).render(
	config.mode === 'source' ? (
		<Player {...common} component={AssetComposition} inputProps={{ asset: config.media, fps: 30 }} />
	) : (
		<Player
			{...common}
			component={SequenceComposition}
			inputProps={{ doc: config.doc, options: DEFAULT_RENDER_OPTIONS }}
		/>
	),
);
let rms = 0;
let hz = 0;
function meterFrame() {
	for (const meter of outputs) {
		const samples = new Float32Array(meter.fftSize);
		meter.getFloatTimeDomainData(samples);
		const level = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
		if (level > rms) {
			rms = level;
			const bins = new Float32Array(meter.frequencyBinCount);
			meter.getFloatFrequencyData(bins);
			let peak = 0;
			for (let i = 1; i < bins.length; i++) if (bins[i]! > bins[peak]!) peak = i;
			hz = (peak * meter.context.sampleRate) / meter.fftSize;
		}
	}
	requestAnimationFrame(meterFrame);
}
requestAnimationFrame(meterFrame);
let ended = false;
(window as unknown as { __playback: unknown }).__playback = {
	frame: () => ref.current?.getCurrentFrame() ?? null,
	seek: (frame: number) => ref.current?.seekTo(frame),
	play: () => {
		const player = ref.current;
		if (!player) throw new Error('Playback fixture has no mounted Player');
		player.addEventListener('ended', () => {
			ended = true;
		});
		player.play();
	},
	ended: () => ended,
	signal: () => ({ rms, hz }),
};
