// Actual Source/Program preview fixture: observes PCM at the Web Audio destination and uses public Player controls.
import type { MediaHandle } from '@jasper/project';
import { Player, type PlayerRef } from '@remotion/player';
import { createRef, useContext, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Internals, useCurrentFrame } from 'remotion';
import { setMixWorkletUrl } from '../../src/audio/graph.ts';
import {
	AssetComposition,
	DEFAULT_RENDER_OPTIONS,
	type RenderDoc,
	SequenceComposition,
} from '../../src/index.ts';
import { monitorFrame, observeBuffering, settlePlayer } from '../player-receipt.ts';

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
let mounted!: (player: PlayerRef) => void;
const ready = new Promise<PlayerRef>((resolve) => {
	mounted = resolve;
});
const common = {
	ref: (player: PlayerRef | null) => {
		ref.current = player;
		if (player) mounted(player);
	},
	compositionWidth: 64,
	compositionHeight: 36,
	durationInFrames: 30,
	fps: 30,
	style: { width: 64, height: 36 },
	controls: false,
	moveToBeginningWhenEnded: false,
	acknowledgeRemotionLicense: true,
};
const container = document.getElementById('player')!;
let buffering: { readonly current: boolean };
let committedFrame = -1;
const waiting = new Set<{ frame: number; resolve: () => void }>();
function committed(frame: number): Promise<void> {
	if (committedFrame === frame) return Promise.resolve();
	return new Promise((resolve) => waiting.add({ frame, resolve }));
}
function ObservedComposition() {
	const frame = useCurrentFrame();
	const buffer = useContext(Internals.BufferingContextReact);
	if (!buffer) throw new Error('Playback fixture has no buffering context');
	observeBuffering(buffer);
	useEffect(() => {
		buffering = buffer.buffering;
		committedFrame = frame;
		for (const waiter of waiting)
			if (waiter.frame === frame) {
				waiting.delete(waiter);
				waiter.resolve();
			}
	}, [frame, buffer]);
	return config.mode === 'source' ? (
		<AssetComposition asset={config.media} fps={30} />
	) : (
		<SequenceComposition doc={config.doc} options={DEFAULT_RENDER_OPTIONS} />
	);
}
createRoot(container).render(<Player {...common} component={ObservedComposition} />);
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
	monitorFrame(meterFrame);
}
monitorFrame(meterFrame);
(window as unknown as { __playback: unknown }).__playback = {
	ready: ready.then(async (player) => {
		await committed(0);
		await settlePlayer(player, container, buffering);
	}),
	seek: async (frame: number) => {
		const player = await ready;
		const done = committed(frame);
		player.seekTo(frame);
		await done;
		await settlePlayer(player, container, buffering);
	},
	play: () => {
		const player = ref.current;
		if (!player) throw new Error('Playback fixture has no mounted Player');
		return new Promise<void>((resolve) => {
			const ended = () => {
				player.removeEventListener('ended', ended);
				resolve();
			};
			player.addEventListener('ended', ended);
			player.play();
		});
	},
	signal: () => ({ rms, hz }),
};
