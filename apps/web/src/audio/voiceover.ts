// Voice-over recording (audio-mix; port of FilmCraft's voiceover.rs to the browser; Premiere's Voice-over Record):
// records the microphone into an audio track at the playhead.
//
// * Record point R: the playhead, or the sequence In point when In and Out are set (punch-in / punch-out at Out).
// * Playback starts a pre-roll before R (capture start C = max(0, R − pre-roll)); countdown cues beep once a second
//   during the pre-roll and at R; recording ends when the user stops playback or `post-roll` after the Out point.
// * Input: `getUserMedia` (the device chosen in Preferences ▸ Audio; echo cancellation, noise suppression and AGC off)
//   → an AudioWorklet capture tap at the sequence sample rate. Electron grants the `media` permission to the app.
// * Timing: every transport frame report is paired with the capture position; the capture sample of a frame comes
//   from the lower envelope of the pairs around it plus one capture-clock step (`captureSampleAt`: the player's
//   start-up buffering and late frame reports do not shift the take). The take is then shifted by the round-trip latency (`voiceoverLatencySeconds`): the talent hears the
//   timeline late by the Program monitor's output latency, and their voice reaches the capture tap late by the input
//   device latency (`MediaTrackSettings.latency`), plus the user's Latency Offset preference.
// * Save: the take from R to the stop / punch-out point is written as a mono 32-bit float WAV (`<Name> <n>.wav`),
//   uploaded to the engine as media and placed on the record track at R — ONE undoable "Record Voice-over".
import { encodeWav } from '@jasper/audio-dsp';
import { activeMixGraph } from '@jasper/compositions';
import type { EngineClient } from '@jasper/engine-client';
import type { Rational, Sequence } from '@jasper/project';
import type { EditorSession, TransportState } from '@jasper/session';
import { buildMediaAsset } from '../import/assets.ts';
import { audioPrefs } from './prefs.ts';
import { MIX_WORKLET_URL } from './worklet-url.ts';

export type VoiceoverPhase = 'idle' | 'starting' | 'recording' | 'saving';

export type VoiceoverStatus = {
	phase: VoiceoverPhase;
	trackId: string | null;
	/** Record point and capture start (sequence frames). */
	recordFrame: number;
	captureFrame: number;
	punchOut: number | null;
	/** Seconds until the record point (countdown), 0 while recording. */
	countdown: number;
	/** Input peak per channel (linear), for the record meter. */
	inputPeaks: number[];
	error: string | null;
};

/** Countdown cue times (frames): one per whole second of pre-roll before the record point, and the record point. */
export function cueFrames(captureFrame: number, recordFrame: number, fps: Rational): number[] {
	const sec = fps.num / fps.den;
	const out: number[] = [];
	for (let k = 1; recordFrame - k * sec >= captureFrame - 1e-9; k++)
		out.push(Math.round(recordFrame - k * sec));
	out.reverse();
	out.push(recordFrame);
	return out;
}

/** `<base> <n>.wav` with the first `n` not used by a project item or media file name. */
export function nextTakeName(base: string, used: Iterable<string>): string {
	const taken = new Set([...used].map((s) => s.toLowerCase()));
	for (let n = 1; ; n++) {
		const name = `${base} ${n}.wav`;
		if (!taken.has(name.toLowerCase()) && !taken.has(`${base} ${n}`.toLowerCase())) return name;
	}
}

/** The track a recording goes to: `trackId`, else the record-armed audio track, else A1. */
export function recordTrackOf(seq: Sequence, trackId?: string | null): string | null {
	if (trackId) return seq.audioTracks.some((t) => t.id === trackId) ? trackId : null;
	return seq.audioTracks.find((t) => t.mixer?.recordArm)?.id ?? seq.audioTracks[0]?.id ?? null;
}

/** A transport frame report paired with the capture position (samples since the first captured sample). */
export type FramePair = { frame: number; sample: number };

/** Seconds of frame reports around a frame used to locate it in the capture. */
const PAIR_WINDOW_S = 1;

/** Greatest common divisor of non-negative integers (0 when all are 0). */
function gcd(a: number, b: number): number {
	while (b > 0) [a, b] = [b, a % b];
	return a;
}

/**
 * Capture sample of sequence frame `f` from the frame / capture pairs around it (±1 s; all pairs when none is that
 * close). Each pair is read when the transport reports a new frame: the report comes after the frame started (by up
 * to a display refresh) and the capture clock read then lags the true position by less than one of its steps (it
 * advances a callback buffer at a time). So `sample − frame·sr/fps` over the pairs is bounded below by
 * `true − step`, and its lower envelope plus one clock step (the gcd of the readings' differences) recovers the true
 * offset: late reports and stalls cannot pull it. Null without usable pairs.
 */
export function captureSampleAt(
	pairs: readonly FramePair[],
	f: number,
	fps: Rational,
	sr: number,
): number | null {
	const fpsN = fps.num / fps.den;
	if (!(fpsN > 0) || !(sr > 0) || !Number.isFinite(f)) return null;
	const ok = pairs.filter((p) => Number.isFinite(p.frame) && Number.isFinite(p.sample));
	if (ok.length === 0) return null;
	const near = ok.filter((p) => Math.abs(p.frame - f) <= PAIR_WINDOW_S * fpsN);
	const use = near.length > 0 ? near : ok;
	const offsets = use.map((p) => p.sample - (p.frame / fpsN) * sr).sort((a, b) => a - b);
	const low = offsets[0]!;
	// The capture clock's step: every reading is a whole number of steps after the first. It cannot exceed the spread
	// of the offsets (readings that all lag alike carry no quantisation to undo); the 90th percentile ignores stalls.
	const spread = offsets[Math.floor((offsets.length - 1) * 0.9)]! - low;
	let step = 0;
	const s0 = Math.round(use[0]!.sample);
	for (const p of use) step = gcd(step, Math.abs(Math.round(p.sample) - s0));
	step = Math.min(step, Math.round(spread), Math.round(sr * 0.1));
	return Math.round(low + step + (f / fpsN) * sr);
}

const secs = (v: unknown, max = 1): number =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(max, v) : 0;

/**
 * Round-trip latency of a voice-over take (seconds): the playback output latency (the Program monitor's AudioContext
 * `baseLatency + outputLatency`, else the capture context's), the input device latency (`MediaTrackSettings.latency`,
 * where the browser reports it) and the user's offset (Preferences ▸ Audio ▸ Latency Offset, ms, may be negative).
 * Unreported or hostile values count as 0.
 */
export function voiceoverLatencySeconds(o: {
	playback?: { baseLatency?: number; outputLatency?: number } | null;
	capture?: { baseLatency?: number; outputLatency?: number } | null;
	inputLatency?: unknown;
	offsetMs?: number;
}): number {
	const out = o.playback ?? o.capture ?? null;
	const output = out ? secs(out.baseLatency) + secs(out.outputLatency) : 0;
	const offset =
		typeof o.offsetMs === 'number' && Number.isFinite(o.offsetMs)
			? Math.max(-1000, Math.min(1000, o.offsetMs)) / 1000
			: 0;
	return output + secs(o.inputLatency) + offset;
}

/**
 * Capture sample range of the take from record frame `r` to frame `end`, shifted by the round-trip latency. Null when
 * the capture cannot be located (no frame reports).
 */
export function takeRange(
	pairs: readonly FramePair[],
	r: number,
	end: number,
	fps: Rational,
	sr: number,
	latencySec: number,
): { start: number; length: number } | null {
	const a = captureSampleAt(pairs, r, fps, sr);
	const b = captureSampleAt(pairs, end, fps, sr);
	if (a === null || b === null) return null;
	const lat = Number.isFinite(latencySec) ? Math.round(latencySec * sr) : 0;
	return { start: a + lat, length: Math.max(0, b - a) };
}

/** Assembles `length` samples of input channel `channel` from capture sample `start` (silence where nothing was captured). */
export function assembleTake(
	chunks: readonly { start: number; channels: Float32Array[] }[],
	firstSample: number,
	start: number,
	length: number,
	channel: number,
): Float32Array {
	const out = new Float32Array(Math.max(0, Math.min(length, 2 ** 31 - 1)));
	const n = out.length;
	for (const c of chunks) {
		if (c.channels.length === 0) continue;
		const src = c.channels[Math.max(0, Math.min(channel, c.channels.length - 1))]!;
		const off = c.start - firstSample - start;
		const from = Math.max(0, -off);
		const to = Math.min(src.length, n - off);
		if (to > from) out.set(src.subarray(from, to), off + from);
	}
	return out;
}

export class VoiceoverRecorder {
	private status: VoiceoverStatus = {
		phase: 'idle',
		trackId: null,
		recordFrame: 0,
		captureFrame: 0,
		punchOut: null,
		countdown: 0,
		inputPeaks: [],
		error: null,
	};
	private readonly listeners = new Set<() => void>();
	private ctx: AudioContext | null = null;
	private stream: MediaStream | null = null;
	private node: AudioWorkletNode | null = null;
	private chunks: { start: number; channels: Float32Array[] }[] = [];
	private pairs: FramePair[] = [];
	/** Input device latency (s) the browser reports for the microphone track, if any. */
	private inputLatency: unknown = undefined;
	private firstSample: number | null = null;
	private offTransport: (() => void) | null = null;
	private stopFrame = 0;
	private sequenceId = '';

	constructor(
		private readonly session: EditorSession,
		private readonly engine: EngineClient,
	) {}

	get state(): VoiceoverStatus {
		return this.status;
	}
	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private set(patch: Partial<VoiceoverStatus>): void {
		this.status = { ...this.status, ...patch };
		for (const cb of [...this.listeners]) cb();
	}

	get busy(): boolean {
		return this.status.phase !== 'idle';
	}

	/** Arms and starts: requests the microphone, seeks to the pre-roll and plays. Resolves when capture runs. */
	async start(opts: { trackId?: string | null } = {}): Promise<void> {
		if (this.busy) throw new Error('A voice-over is already recording');
		const s = this.session.getState();
		if (s.readOnly) throw new Error('The project is read-only');
		const seqId = s.activeSequenceId;
		const seq = seqId ? (s.document.sequences[seqId] as Sequence | undefined) : undefined;
		if (!seq) throw new Error('Open a sequence to record a voice-over');
		const trackId = recordTrackOf(seq, opts.trackId);
		if (!trackId) throw new Error('The sequence has no audio track to record into');
		if (seq.audioTracks.find((t) => t.id === trackId)?.locked) throw new Error('The record track is locked');
		if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
			throw new Error('This browser cannot record audio (no microphone access)');
		const prefs = audioPrefs.get().voiceOver;
		const fps = seq.settings.frameRate as Rational;
		const fpsN = fps.num / fps.den;
		const punch = seq.inPoint !== null && seq.outPoint !== null && seq.outPoint > seq.inPoint;
		const recordFrame = punch ? seq.inPoint! : this.session.transport.getState().frame;
		const captureFrame = Math.max(0, recordFrame - Math.round(prefs.prerollSeconds * fpsN));
		const punchOut = punch ? seq.outPoint : null;
		this.sequenceId = seq.id;
		this.set({
			phase: 'starting',
			trackId,
			recordFrame,
			captureFrame,
			punchOut,
			countdown: (recordFrame - captureFrame) / fpsN,
			inputPeaks: [],
			error: null,
		});
		const sampleRate = (seq.settings.audioSampleRate as number) || 48000;
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					...(prefs.deviceId ? { deviceId: { exact: prefs.deviceId } } : {}),
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false,
				},
			});
		} catch (e) {
			this.cleanup();
			const name = (e as { name?: string }).name;
			const message =
				name === 'NotAllowedError'
					? 'Microphone access was denied'
					: name === 'NotFoundError' || name === 'OverconstrainedError'
						? 'The selected input device is not available'
						: `Cannot open the microphone: ${(e as Error).message}`;
			this.set({ phase: 'idle', error: message });
			throw new Error(message);
		}
		try {
			// `latency` (Chrome): the input device's latency in seconds; not in every browser's typings
			const settings = this.stream.getAudioTracks()[0]?.getSettings?.() as { latency?: unknown } | undefined;
			this.inputLatency = settings?.latency;
		} catch {
			this.inputLatency = undefined;
		}
		try {
			this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
			await this.ctx.audioWorklet.addModule(MIX_WORKLET_URL);
			const src = this.ctx.createMediaStreamSource(this.stream);
			const channels = Math.max(1, src.channelCount);
			this.node = new AudioWorkletNode(this.ctx, 'jasper-capture', {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: channels,
				channelCountMode: 'explicit',
				channelInterpretation: 'discrete',
			});
			this.node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data as never);
			src.connect(this.node);
			if (this.ctx.state === 'suspended') await this.ctx.resume();
		} catch (e) {
			this.cleanup();
			const message = `Cannot start the recording: ${(e as Error).message}`;
			this.set({ phase: 'idle', error: message });
			throw new Error(message);
		}
		this.chunks = [];
		this.pairs = [];
		this.firstSample = null;
		// countdown cues on the capture context (heard on the default output)
		if (prefs.countdownCues) {
			const t0 = this.ctx.currentTime + 0.05;
			for (const f of cueFrames(captureFrame, recordFrame, fps))
				this.beep(t0 + (f - captureFrame) / fpsN, f === recordFrame);
		}
		this.node.port.postMessage({ type: 'start' });
		const transport = this.session.transport;
		if (transport.getState().playing) transport.pause();
		transport.seek(captureFrame);
		this.offTransport = transport.subscribe((st: TransportState, prev: TransportState) =>
			this.onTransport(st, prev),
		);
		transport.play(1);
		this.set({ phase: 'recording' });
	}

	private beep(at: number, last: boolean): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const osc = ctx.createOscillator();
		osc.frequency.value = last ? 1500 : 1000;
		const g = ctx.createGain();
		g.gain.setValueAtTime(0, at);
		g.gain.linearRampToValueAtTime(0.25, at + 0.005);
		g.gain.setValueAtTime(0.25, at + 0.095);
		g.gain.linearRampToValueAtTime(0, at + 0.1);
		osc.connect(g).connect(ctx.destination);
		osc.start(at);
		osc.stop(at + 0.11);
	}

	private onWorklet(m: { type: string; start?: number; channels?: Float32Array[]; peaks?: number[] }): void {
		if (m.type === 'data' && m.channels && m.start !== undefined) {
			if (this.firstSample === null) this.firstSample = m.start;
			this.chunks.push({ start: m.start, channels: m.channels });
		} else if (m.type === 'peaks' && m.peaks) this.set({ inputPeaks: m.peaks });
	}

	/** Capture position (samples since the first captured sample) now. */
	private capturePos(): number {
		const ctx = this.ctx;
		if (!ctx || this.firstSample === null) return 0;
		return Math.round(ctx.currentTime * ctx.sampleRate) - this.firstSample;
	}

	private onTransport(st: TransportState, prev: TransportState): void {
		const seq = this.session.getState().document.sequences[this.sequenceId] as Sequence | undefined;
		if (!seq) return;
		const fps = seq.settings.frameRate as Rational;
		if (st.playing && st.frame !== prev.frame && this.firstSample !== null)
			this.pairs.push({ frame: st.frame, sample: this.capturePos() });
		const fpsN = fps.num / fps.den;
		if (this.status.phase === 'recording') {
			const left = Math.max(0, (this.status.recordFrame - st.frame) / fpsN);
			if (Math.abs(left - this.status.countdown) > 0.05) this.set({ countdown: left });
		}
		const postroll = Math.round(audioPrefs.get().voiceOver.postrollSeconds * fpsN);
		if (this.status.punchOut !== null && st.playing && st.frame >= this.status.punchOut + postroll) {
			this.session.transport.pause();
			return;
		}
		if (!st.playing && prev.playing && this.status.phase === 'recording') {
			this.stopFrame = st.frame;
			void this.finish();
		}
	}

	/** Stops playback (the take is saved). */
	stop(): void {
		if (this.status.phase !== 'recording') return;
		if (this.session.transport.getState().playing) this.session.transport.pause();
		else {
			this.stopFrame = this.session.transport.getState().frame;
			void this.finish();
		}
	}

	/** Stops without saving. */
	cancel(): void {
		this.offTransport?.();
		this.offTransport = null;
		if (this.session.transport.getState().playing) this.session.transport.pause();
		this.cleanup();
		this.set({ phase: 'idle', countdown: 0 });
	}

	private async finish(): Promise<void> {
		this.offTransport?.();
		this.offTransport = null;
		this.set({ phase: 'saving', countdown: 0 });
		await new Promise<void>((resolve) => {
			const node = this.node;
			if (!node) return resolve();
			const done = (e: MessageEvent) => {
				if ((e.data as { type?: string }).type === 'stopped') resolve();
				else this.onWorklet(e.data as never);
			};
			node.port.onmessage = done;
			node.port.postMessage({ type: 'stop' });
			setTimeout(resolve, 500);
		});
		try {
			await this.save();
			this.set({ phase: 'idle', error: null });
		} catch (e) {
			this.set({ phase: 'idle', error: (e as Error).message });
		} finally {
			this.cleanup();
		}
	}

	private async save(): Promise<void> {
		const ctx = this.ctx;
		const s = this.session.getState();
		const seq = s.document.sequences[this.sequenceId] as Sequence | undefined;
		if (!ctx || !seq || this.firstSample === null || this.chunks.length === 0)
			throw new Error('Nothing was recorded');
		const sr = ctx.sampleRate;
		const fps = seq.settings.frameRate as Rational;
		const prefs = audioPrefs.get().voiceOver;
		const end =
			this.status.punchOut !== null ? Math.min(this.stopFrame, this.status.punchOut) : this.stopFrame;
		if (end <= this.status.recordFrame) throw new Error('The recording stopped before the record point');
		const playback = activeMixGraph()?.ctx ?? null;
		const latency = voiceoverLatencySeconds({
			playback,
			capture: ctx,
			inputLatency: this.inputLatency,
			offsetMs: prefs.latencyOffsetMs,
		});
		const range = takeRange(this.pairs, this.status.recordFrame, end, fps, sr, latency);
		if (!range || range.length === 0) throw new Error('Nothing was recorded');
		const mono = assembleTake(this.chunks, this.firstSample, range.start, range.length, prefs.inputChannel);
		const used = [
			...Object.values(s.document.items).map((i) => i.name),
			...Object.values(s.document.media).map((m) => m.originalName),
		];
		const fileName = nextTakeName(prefs.name, used);
		const wav = encodeWav([mono], sr, 'f32');
		const projectId = s.document.projectId;
		const reg = await this.engine.uploadFile(
			new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
			{
				projectId,
				fileName,
				mimeType: 'audio/wav',
			},
		);
		const asset = buildMediaAsset(reg, {
			id: this.session.ctx.ids.next('med'),
			now: new Date().toISOString(),
		});
		const r = this.session.apply({
			label: 'Record Voice-over',
			origin: 'user',
			commands: [
				{ type: 'media.register', asset, name: fileName.replace(/\.wav$/, ''), ref: '$vo' },
				{
					type: 'clip.place',
					sequenceId: seq.id,
					source: { mediaId: '$vo' },
					at: this.status.recordFrame,
					tracks: { audio: this.status.trackId! },
					mode: 'overwrite',
					video: false,
					ref: '$voc',
				},
			] as never,
		});
		if (!r.ok) throw new Error(r.errors[0]?.message ?? 'The recording could not be placed');
	}

	private cleanup(): void {
		this.node?.disconnect();
		this.node = null;
		for (const t of this.stream?.getTracks() ?? []) t.stop();
		this.stream = null;
		void this.ctx?.close().catch(() => undefined);
		this.ctx = null;
	}
}

const recorders = new WeakMap<EditorSession, VoiceoverRecorder>();
export function voiceoverFor(session: EditorSession, engine: EngineClient): VoiceoverRecorder {
	let r = recorders.get(session);
	if (!r) {
		r = new VoiceoverRecorder(session, engine);
		recorders.set(session, r);
	}
	return r;
}
