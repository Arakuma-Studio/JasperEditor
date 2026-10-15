// Audio Track / Clip Mixer controls and the automation recorder (audio-mix; port of FilmCraft's engine mixer.rs).
//
// A control held on a mixer is heard immediately (an override in the preview mix graph). While playback runs, the
// strip's automation mode decides what is recorded (Premiere's modes):
//
// | mode | records | after release |
// |---|---|---|
// | Off / Read | nothing; a lane without keyframes keeps the new static value | the control returns to the automation |
// | Latch | from the first touch | keeps writing the last value until playback stops |
// | Touch | while touched | ramps back to the existing automation over the automatch time |
// | Write | every control from the start of playback | keeps writing the last value until playback stops |
//
// When playback stops the pass is written as ONE undoable transaction ("Write Automation"): `mixer.writeAutomation`
// per track lane, `clipMixer.write` per Audio Clip Mixer lane (clip keyframes in content time), and — with "Switch to
// Touch after Write" — Write strips change to Touch. Without playback a release commits the value once
// (`mixer.setLane` / `clipMixer.set`: the static value, or a keyframe at the playhead when the lane is automated).
import { activeMixGraph } from '@jasper/compositions';
import type { CommandInput } from '@jasper/project';
import {
	type AutomationMode,
	evaluate,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	laneAnimatable,
	laneInfo,
	laneValueAt,
	listStrips,
	type Rational,
	type Sequence,
	type StripView,
	writeLanes,
} from '@jasper/project';
import type { EditorSession, TransportState } from '@jasper/session';
import { audioPrefs } from './prefs.ts';

export const CLIP_LANE_VOLUME = 'clip.volume';
export const CLIP_LANE_PAN = 'clip.pan';
export const isClipLane = (lane: string) => lane === CLIP_LANE_VOLUME || lane === CLIP_LANE_PAN;
const writes = (m: AutomationMode) => m === 'latch' || m === 'touch' || m === 'write';

type Point = [number, number];

/** One recorded control gesture. */
class Gesture {
	points: Point[];
	touching = true;
	released: number | null = null;
	private last: Point;

	constructor(
		readonly strip: string,
		readonly lane: string,
		readonly mode: AutomationMode,
		t: number,
		v: number,
	) {
		this.points = [[t, v]];
		this.last = [t, v];
	}

	/** A new value at `t`. Repeats extend the hold instead of adding points (a held fader records a flat line). */
	push(t: number, v: number): void {
		if (t < this.last[0]) return;
		if (v === this.last[1]) {
			this.last = [t, v];
			return;
		}
		const p = this.points[this.points.length - 1];
		if (p && this.last[0] > p[0]) this.points.push([...this.last] as Point);
		this.points.push([t, v]);
		this.last = [t, v];
	}

	flush(): void {
		const p = this.points[this.points.length - 1];
		if (p && this.last[0] > p[0]) this.points.push([...this.last] as Point);
	}

	get value(): number {
		return this.last[1];
	}
	get lastTime(): number {
		return this.last[0];
	}
	/** Write / Latch held the last value until a new touch at `t`: the hold ends one sample before. */
	holdUntil(t: number, eps: number): void {
		if (t > this.last[0]) this.last = [Math.max(this.last[0], t - eps), this.last[1]];
	}
}

type Pass = { sequenceId: string; start: number; gestures: Gesture[] };

function stripOf(seq: Sequence, id: string): StripView | undefined {
	return listStrips(seq).find((s) => s.id === id);
}

function clipModeOf(seq: Sequence, trackId: string): AutomationMode {
	return (
		(seq.audioTracks.find((t) => t.id === trackId)?.mixer?.clipAutomation as AutomationMode | undefined) ??
		'read'
	);
}

/** The clip lane value under sequence time `t` on a track (the clip's volume / pan at its content time). */
export function clipLaneValue(seq: Sequence, trackId: string, lane: string, t: number): number | null {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	for (const c of Object.values(seq.clips)) {
		if (
			c.trackId !== trackId ||
			(c.kind !== 'audio' && c.kind !== 'nest-audio' && c.kind !== 'synthetic-audio')
		)
			continue;
		if (c.start * F > t || t >= (c.start + c.duration) * F) continue;
		const clip = c;
		const local = t / F - clip.start;
		const content = clip.speed.reverse
			? clip.sourceIn + (clip.duration - local) * F * clip.speed.rate
			: clip.sourceIn + local * F * clip.speed.rate;
		const a = lane === CLIP_LANE_VOLUME ? clip.volumeDb : clip.pan;
		return evaluate(a, content);
	}
	return null;
}

/** The value playback uses for a strip lane at `t` (automation unless Off). */
export function underlying(seq: Sequence, strip: string, lane: string, t: number): number {
	if (isClipLane(lane)) return clipLaneValue(seq, strip, lane, t) ?? 0;
	const s = stripOf(seq, strip);
	return s ? laneValueAt(s, lane, t) : 0;
}

/** Controller of one editor session (mixer panels, the recorder, transport hooks). */
export class MixerController {
	private pass: Pass | null = null;
	private lastFrame = { frame: 0, at: 0 };
	private readonly listeners = new Set<() => void>();
	private readonly off: () => void;
	/** Values held by the panels (for display): `${strip}|${lane}`. */
	private readonly held = new Map<string, number>();

	constructor(private readonly session: EditorSession) {
		const t = session.transport;
		let prev: TransportState = t.getState();
		this.lastFrame = { frame: prev.frame, at: performance.now() };
		this.off = t.subscribe((s: TransportState) => {
			if (s.frame !== prev.frame) this.lastFrame = { frame: s.frame, at: performance.now() };
			if (s.playing && !prev.playing) this.startPass();
			else if (!s.playing && prev.playing) this.stopPass();
			prev = s;
		});
	}

	dispose(): void {
		this.off();
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private emit(): void {
		for (const cb of [...this.listeners]) cb();
	}

	get recording(): boolean {
		return this.pass !== null && this.pass.gestures.length > 0;
	}

	private seq(): Sequence | null {
		const s = this.session.getState();
		const id = s.activeSequenceId;
		return id ? ((s.document.sequences[id] as Sequence | undefined) ?? null) : null;
	}

	/** Sequence time of the playhead in flicks (interpolated between frame reports while playing). */
	now(): number {
		const seq = this.seq();
		if (!seq) return 0;
		const rate = seq.settings.frameRate as Rational;
		const F = flicksPerFrame(rate);
		const st = this.session.transport.getState();
		if (!st.playing) return st.frame * F;
		const fps = rate.num / rate.den;
		const ahead = Math.min(
			1,
			((performance.now() - this.lastFrame.at) / 1000) * fps * Math.abs(st.rate || 1),
		);
		return Math.max(0, Math.round((this.lastFrame.frame + ahead) * F));
	}

	private eps(seq: Sequence): number {
		return Math.max(1, Math.round(FLICKS_PER_SECOND / ((seq.settings.audioSampleRate as number) || 48000)));
	}

	/** The value a panel shows for a lane: the held value, else what playback uses now. */
	displayValue(strip: string, lane: string, t: number): number {
		const h = this.held.get(`${strip}|${lane}`);
		if (h !== undefined) return h;
		const seq = this.seq();
		return seq ? underlying(seq, strip, lane, t) : 0;
	}

	isHeld(strip: string, lane: string): boolean {
		return this.held.has(`${strip}|${lane}`);
	}

	private startPass(): void {
		const seq = this.seq();
		if (!seq) return;
		const t = this.now();
		const gestures: Gesture[] = [];
		for (const s of listStrips(seq)) {
			if (s.automation === 'write')
				for (const lane of writeLanes(seq, s.id)) {
					const g = new Gesture(s.id, lane, 'write', t, laneValueAt(s, lane, t));
					g.touching = false;
					gestures.push(g);
				}
			if (s.kind === 'track' && clipModeOf(seq, s.id) === 'write')
				for (const lane of [CLIP_LANE_VOLUME, CLIP_LANE_PAN]) {
					const v = clipLaneValue(seq, s.id, lane, t);
					if (v === null) continue;
					const g = new Gesture(s.id, lane, 'write', t, v);
					g.touching = false;
					gestures.push(g);
				}
		}
		this.pass = { sequenceId: seq.id, start: t, gestures };
		const graph = activeMixGraph();
		for (const g of gestures) graph?.setOverride(g.strip, g.lane, g.value);
		this.emit();
	}

	private stopPass(): void {
		const pass = this.pass;
		this.pass = null;
		const graph = activeMixGraph();
		if (!pass || pass.gestures.length === 0) {
			this.emit();
			return;
		}
		const seq = this.session.getState().document.sequences[pass.sequenceId] as Sequence | undefined;
		if (!seq) {
			graph?.clearOverrides();
			this.held.clear();
			this.emit();
			return;
		}
		const prefs = audioPrefs.get();
		const tStop = this.now();
		const automatch = Math.round(prefs.automatchSeconds * FLICKS_PER_SECOND);
		const commands: CommandInput[] = [];
		for (const g of pass.gestures) {
			if (g.points.length === 0) continue;
			const clip = isClipLane(g.lane);
			const hold = !clip && !!laneInfo(g.lane)?.hold;
			const end =
				g.mode === 'touch' ? Math.min(g.released ?? tStop, Math.max(tStop, g.points[0]![0])) : tStop;
			g.push(Math.max(end, g.lastTime), g.value);
			g.flush();
			const pts = g.points.map((p) => [p[0], p[1]] as Point);
			if (g.mode === 'touch' && automatch > 0 && !hold) {
				const back = end + automatch;
				pts.push([back, underlying(seq, g.strip, g.lane, back)]);
			}
			const panLike = g.lane === 'pan' || g.lane === CLIP_LANE_PAN || g.lane.startsWith('pan51.');
			const thinning = {
				tolerance: hold || !prefs.linearThinning ? 0 : panLike ? 0.25 : 0.05,
				...(prefs.minIntervalThinning ? { minIntervalMs: prefs.minIntervalMs } : {}),
			};
			if (clip)
				commands.push({
					type: 'clipMixer.write',
					sequenceId: seq.id,
					trackId: g.strip,
					lane: g.lane === CLIP_LANE_VOLUME ? 'volume' : 'pan',
					points: pts,
					thinning,
				});
			else
				commands.push({
					type: 'mixer.writeAutomation',
					sequenceId: seq.id,
					stripId: g.strip === 'master' ? 'Mix' : g.strip,
					lane: g.lane,
					points: pts,
					thinning,
				});
		}
		if (prefs.switchToTouchAfterWrite) {
			for (const s of listStrips(seq)) {
				if (s.automation === 'write')
					commands.push({
						type: 'mixer.updateStrip',
						sequenceId: seq.id,
						stripId: s.id === 'master' ? 'Mix' : s.id,
						patch: { automation: 'touch' },
					});
				if (s.kind === 'track' && clipModeOf(seq, s.id) === 'write')
					commands.push({
						type: 'mixer.updateStrip',
						sequenceId: seq.id,
						stripId: s.id,
						patch: { clipAutomation: 'touch' },
					});
			}
		}
		if (commands.length) this.session.apply({ label: 'Write Automation', origin: 'user', commands });
		graph?.clearOverrides();
		this.held.clear();
		this.emit();
	}

	private modeOf(seq: Sequence, strip: string, lane: string): AutomationMode {
		if (isClipLane(lane)) return clipModeOf(seq, strip);
		return stripOf(seq, strip)?.automation ?? 'read';
	}

	/** A control moved to `value` (fader drag, knob turn, button). */
	touch(strip: string, lane: string, value: number): void {
		const seq = this.seq();
		if (!seq) return;
		const info = isClipLane(lane) ? null : laneInfo(lane);
		const v = info ? Math.min(info.max, Math.max(info.min, value)) : value;
		this.held.set(`${strip}|${lane}`, v);
		activeMixGraph()?.setOverride(strip, lane, v);
		const pass = this.pass;
		const mode = this.modeOf(seq, strip, lane);
		if (pass && writes(mode)) {
			const t = this.now();
			const g = pass.gestures.find((x) => x.strip === strip && x.lane === lane);
			if (g) {
				if (!g.touching) {
					if (g.mode === 'touch') g.released = null;
					else g.holdUntil(t, this.eps(seq));
				}
				g.touching = true;
				g.push(t, v);
			} else pass.gestures.push(new Gesture(strip, lane, mode, t, v));
		}
		this.emit();
	}

	/** A control let go. */
	release(strip: string, lane: string): void {
		const seq = this.seq();
		const key = `${strip}|${lane}`;
		const held = this.held.get(key);
		const graph = activeMixGraph();
		if (!seq || held === undefined) {
			this.held.delete(key);
			graph?.setOverride(strip, lane, null);
			this.emit();
			return;
		}
		const pass = this.pass;
		const g = pass?.gestures.find((x) => x.strip === strip && x.lane === lane);
		if (pass && g) {
			const t = this.now();
			g.touching = false;
			g.push(t, g.value);
			if (g.mode === 'touch') {
				g.released = t;
				this.held.delete(key);
				// the preview returns to the automation (the written ramp is heard on the next pass)
				graph?.setOverride(strip, lane, null);
			}
			// Latch / Write keep holding the last value until playback stops.
			this.emit();
			return;
		}
		this.held.delete(key);
		graph?.setOverride(strip, lane, null);
		// No pass (paused), or Off / Read during playback: commit once.
		const playing = this.session.transport.getState().playing;
		const t = this.now();
		if (isClipLane(lane)) {
			if (!playing)
				this.session.apply({
					label: 'Audio Clip Mixer',
					origin: 'user',
					commands: [
						{
							type: 'clipMixer.set',
							sequenceId: seq.id,
							trackId: strip,
							lane: lane === CLIP_LANE_VOLUME ? 'volume' : 'pan',
							value: held,
							time: t,
						},
					],
				});
			this.emit();
			return;
		}
		const s = stripOf(seq, strip);
		const automated = !!s && (laneAnimatable(s, lane)?.keyframes.length ?? 0) > 0;
		// Read during playback: an automated lane returns to its automation.
		if (playing && automated && s?.automation !== 'off') {
			this.emit();
			return;
		}
		this.session.apply({
			label: 'Audio Track Mixer',
			origin: 'user',
			commands: [
				{
					type: 'mixer.setLane',
					sequenceId: seq.id,
					stripId: strip === 'master' ? 'Mix' : strip,
					lane,
					value: held,
					...(automated && s?.automation !== 'off' ? { time: t } : {}),
				},
			],
		});
		this.emit();
	}
}

const controllers = new WeakMap<EditorSession, MixerController>();
export function mixerControllerFor(session: EditorSession): MixerController {
	let c = controllers.get(session);
	if (!c) {
		c = new MixerController(session);
		controllers.set(session, c);
	}
	return c;
}
