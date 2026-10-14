// Audio scrubbing (audio-mix; Premiere "Play Audio While Scrubbing", Shift+S): while the playhead moves without
// native playback — dragging in the timeline or a monitor, stepping frames, reverse / fast shuttle — each new frame
// plays a short snippet of the full mix (clip levels, pan, buses, automation, normalisation) rendered by the offline
// mixer from audio decoded in the browser. Reverse shuttle plays the snippet backwards.
import { installAudioFxProcessors } from '@jasper/audio-fx';
import {
	buildRenderSnapshot,
	frameToSample,
	type MediaAsset,
	OfflineMixer,
	type ProjectDocument,
	type Rational,
	type RenderSnapshot,
} from '@jasper/project';
import type { EditorSession, TransportState } from '@jasper/session';
import { resolveMediaHandle } from '../panels/program/render-doc.ts';
import { browserOpenClip } from './browser-decode.ts';
import { audioPrefs } from './prefs.ts';

// audio-fx: the audio effect processors (clip effects and track / submix / Mix inserts) for the offline mixer.
installAudioFxProcessors();

const MIN_SNIPPET_S = 0.04;
const MAX_SNIPPET_S = 0.12;
const FADE_S = 0.004;

/**
 * The sample span a scrub snippet plays: forwards from the playhead, or (reverse) the snippet that ends at the playhead
 * — never content after it, so near the start of the sequence a reverse snippet is shorter (none at frame 0).
 */
export function scrubWindow(
	frame: number,
	fps: Rational,
	sr: number,
	seconds: number,
	reverse: boolean,
): { start: number; length: number } | null {
	const at = frameToSample(frame, fps, sr);
	const n = Math.round(seconds * sr);
	if (!Number.isFinite(at) || at < 0 || !Number.isFinite(n) || n < 1) return null;
	if (!reverse) return { start: at, length: n };
	const length = Math.min(n, at);
	return length > 0 ? { start: at - length, length } : null;
}

export class AudioScrubber {
	private ctx: AudioContext | null = null;
	private busy = false;
	private queued: { frame: number; reverse: boolean; seconds: number } | null = null;
	private snap: { doc: ProjectDocument; seqId: string; snap: RenderSnapshot } | null = null;
	private lastAt = 0;
	private readonly off: () => void;

	constructor(private readonly session: EditorSession) {
		let prev = session.transport.getState();
		this.off = session.transport.subscribe((s: TransportState) => {
			const moved = s.frame !== prev.frame;
			const nativePlayback = s.playing && s.rate === 1;
			const stepping = s.playing && s.rate !== 1;
			if (moved && !nativePlayback && audioPrefs.get().scrub && (stepping || !s.playing)) {
				const now = performance.now();
				const gap = (now - this.lastAt) / 1000;
				this.lastAt = now;
				const seconds = Math.min(MAX_SNIPPET_S, Math.max(MIN_SNIPPET_S, gap || MIN_SNIPPET_S));
				this.request({ frame: s.frame, reverse: s.frame < prev.frame, seconds });
			}
			prev = s;
		});
	}

	dispose(): void {
		this.off();
		void this.ctx?.close().catch(() => undefined);
		this.ctx = null;
	}

	private request(r: { frame: number; reverse: boolean; seconds: number }): void {
		if (this.busy) {
			this.queued = r;
			return;
		}
		this.busy = true;
		void this.play(r)
			.catch(() => undefined)
			.finally(() => {
				this.busy = false;
				const q = this.queued;
				this.queued = null;
				if (q) this.request(q);
			});
	}

	private snapshotFor(doc: ProjectDocument, seqId: string): RenderSnapshot {
		if (this.snap && this.snap.doc === doc && this.snap.seqId === seqId) return this.snap.snap;
		const media = this.session.getState().media;
		const snap = buildRenderSnapshot(doc, seqId, {
			resolveMedia: (asset: MediaAsset) => resolveMediaHandle(asset, media[asset.id]),
			resolveFont: () => null,
		});
		this.snap = { doc, seqId, snap };
		return snap;
	}

	private async play(r: { frame: number; reverse: boolean; seconds: number }): Promise<void> {
		const st = this.session.getState();
		const seqId = st.activeSequenceId;
		if (!seqId) return;
		const doc = this.session.getDrawn();
		const seq = doc.sequences[seqId];
		if (!seq) return;
		const snap = this.snapshotFor(doc, seqId);
		if (!snap.audioMix || snap.audioClips.length === 0) return;
		const fps = seq.settings.frameRate as Rational;
		const sr = snap.audioMix.sampleRate;
		const span = scrubWindow(r.frame, fps, sr, r.seconds, r.reverse);
		if (!span) return;
		const n = span.length;
		const mixer = new OfflineMixer({
			snapshot: snap,
			openClip: browserOpenClip((id) => snap.media[id] ?? null, fps),
			startSample: span.start,
			outputLayout: 'stereo',
			mixdown: audioPrefs.get().mixdown,
		});
		const out = [new Float32Array(n), new Float32Array(n)];
		try {
			await mixer.render(out, n);
		} finally {
			mixer.close();
		}
		if (r.reverse) for (const c of out) c.reverse();
		const fade = Math.min(n >> 1, Math.round(FADE_S * sr));
		for (const c of out)
			for (let i = 0; i < fade; i++) {
				const g = i / fade;
				c[i]! *= g;
				c[n - 1 - i]! *= g;
			}
		this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
		if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
		const buf = this.ctx.createBuffer(2, n, sr);
		buf.copyToChannel(out[0]!, 0);
		buf.copyToChannel(out[1]!, 1);
		const src = this.ctx.createBufferSource();
		src.buffer = buf;
		src.connect(this.ctx.destination);
		src.start();
	}
}

const scrubbers = new WeakMap<EditorSession, AudioScrubber>();
export function audioScrubberFor(session: EditorSession): AudioScrubber {
	let s = scrubbers.get(session);
	if (!s) {
		s = new AudioScrubber(session);
		scrubbers.set(session, s);
	}
	return s;
}
