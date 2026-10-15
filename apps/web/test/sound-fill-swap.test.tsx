// WP2.4b flows (spec 12 §2.7, P2-R7): Fill a cue (one undo step, role / alternatives / variation from the cue), Add
// Layer (next free track, linked, "Layer 2 of 2"), Fill Unfilled Cues (one transaction, rotation, deterministic), variation
// cycling coalesced into ONE history entry ("Swap Sound ×3") and closed by another edit, Replace mode swap, the In
// Context audition (transient only: no document or history change, the replaced clip muted, back to the anchor), Align
// Peak / Set Peak / Role / Palette / Detect Peak commands.
import type { SoundEntry } from '@jasper/api';
import { type AudioClip, type ClipSfx, FLICKS_PER_SECOND, type Sequence } from '@jasper/project';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import {
	cancelLibraryMode,
	clipSoundTarget,
	cueFillTarget,
	requestCueFill,
} from '../src/sound/controller.ts';
import { cuesOf } from '../src/sound/cues/model.ts';
import { alignedFrameOf, clipSoundLabel, layersOf, sfxOf } from '../src/sound/design-model.ts';
import { detectClipPeak } from '../src/sound/detect-peak.ts';
import { fillCueWithSound, fillUnfilledCues } from '../src/sound/fill.ts';
import { auditionInContext, inContextStore, stopInContext } from '../src/sound/in-context.ts';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { cycleVariation, resetVariationRun, swapClipSound } from '../src/sound/swap.ts';
import { fakeSoundEngine, soundEntry } from './sound-helpers.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	stopInContext({ returnToAnchor: false });
	cancelLibraryMode();
	requestCueFill(null);
	resetVariationRun();
	soundLibraryPrefs.set({ auditionOnSwap: true, inContext: false });
});

type SfxClip = AudioClip & { sfx?: ClipSfx };

function harness(entries: SoundEntry[] = defaultEntries(), preset?: string) {
	const { session, seqId } = makeSession(preset ? { preset } : {});
	const fake = fakeSoundEngine(entries);
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine: fake.client as never,
		session,
		focus: { panel: 'timeline', instanceId: 'x' },
		capabilities: ['engine'],
		toast: (r) => toasts.push(r),
	});
	const run = async (id: string, args?: unknown) => {
		const r = await runCommand(id, ctx, args);
		expect(r.ran, `${id}: ${r.reason}`).toBe(true);
		return r;
	};
	const apply = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const clip = (id: string) => seq().clips[id] as SfxClip;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	const addCue = (frame: number, weight = 'hero', types = ['hit']) =>
		(
			apply([{ type: 'soundCue.add', cues: [{ frame, kind: 'land', weight, types, source: 'user' }] }])
				.results[0] as { cueIds: string[] }
		).cueIds[0]!;
	return {
		session,
		seqId,
		fake,
		engine: fake.client as never,
		ctx,
		run,
		apply,
		seq,
		clip,
		labels,
		toasts,
		addCue,
	};
}

function defaultEntries(): SoundEntry[] {
	return [
		soundEntry({ title: 'Crunch', peakSec: 0.25, durationSec: 1 }),
		soundEntry({ title: 'Thud', peakSec: 0.2, durationSec: 0.8 }),
		soundEntry({ title: 'Smack', peakSec: 0.3, durationSec: 1.1 }),
		soundEntry({ title: 'Clap', peakSec: 0.15, durationSec: 0.6 }),
		soundEntry({ title: 'Knock', peakSec: 0.1, durationSec: 0.5 }),
	];
}

/** Sequence frame (fractional) of a clip's aligned point. */
const pointAt = (h: ReturnType<typeof harness>, id: string) => {
	const s = h.seq();
	return alignedFrameOf(h.session.getCommitted(), s, s.clips[id]!)!;
};

describe('Fill', () => {
	it('fills a cue in ONE undo step: peak on the cue, role from the cue, alternatives, seeded variation; undo', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		const before = h.session.getCommitted();
		const n = h.labels().length;
		const entry = (await h.fake.client.searchSounds({ q: 'crunch' })).results[0]!.sound;
		const r = await fillCueWithSound(h.session, h.engine, entry, {
			sequenceId: h.seqId,
			cueId,
			alternatives: [
				entry.id,
				'snd_0000000000000aaa',
				'snd_0000000000000bbb',
				'snd_0000000000000ccc',
				'snd_0000000000000ddd',
			],
		});
		expect(h.labels()).toHaveLength(n + 1);
		expect(h.labels().at(-1)).toBe('Fill Cue Crunch');
		const c = h.clip(r.clipId);
		expect(c.sfx).toMatchObject({ cueId, role: 'hero', soundId: entry.id, layer: 0 });
		// the chosen sound is not its own alternative; at most 3
		expect(c.sfx!.alternatives).toEqual([
			'snd_0000000000000aaa',
			'snd_0000000000000bbb',
			'snd_0000000000000ccc',
		]);
		expect(Math.abs(c.speed.rate - 1)).toBeLessThanOrEqual(0.02);
		expect(Math.abs(c.gainDb)).toBeLessThanOrEqual(1);
		// the peak plays on the cue frame (to less than a frame, sub-frame exact for this unpadded file)
		expect(pointAt(h, r.clipId)).toBeGreaterThanOrEqual(90 - 1e-6);
		expect(pointAt(h, r.clipId)).toBeLessThan(91);
		expect(cuesOf(h.seq())[0]!.placedClipIds).toEqual([r.clipId]);
		expect(r.message).toContain('Crunch');
		h.session.undo();
		expect(h.session.getCommitted()).toEqual(before);
	});

	it('Add Layer: next free track, aligned to the same peak, linked; "Layer 2 of 2"; Unlink / Link Layers', async () => {
		const h = harness();
		const cueId = h.addCue(120);
		const [a, b] = (await h.fake.client.searchSounds({})).results.map((x) => x.sound);
		const first = await fillCueWithSound(h.session, h.engine, a!, { sequenceId: h.seqId, cueId });
		const second = await fillCueWithSound(h.session, h.engine, b!, {
			sequenceId: h.seqId,
			cueId,
			layer: true,
		});
		expect(h.labels().at(-1)).toBe(`Add Layer ${b!.title}`);
		const c1 = h.clip(first.clipId);
		const c2 = h.clip(second.clipId);
		expect(c2.trackId).not.toBe(c1.trackId);
		expect(c2.sfx).toMatchObject({ role: 'layer', layer: 1, cueId });
		expect(c1.linkId).toBeTruthy();
		expect(c2.linkId).toBe(c1.linkId);
		expect(Math.floor(pointAt(h, first.clipId))).toBe(Math.floor(pointAt(h, second.clipId)));
		expect(layersOf(h.seq(), c2)).toEqual({ clipIds: [first.clipId, second.clipId], index: 1 });
		// moving one moves the other (Premiere link)
		h.session.select('timeline', [first.clipId], 'replace');
		expect(h.session.getState().selection.timeline.clips.sort()).toEqual(
			[first.clipId, second.clipId].sort(),
		);
		// Unlink / Link Layers
		await h.run('sound.toggleLinkLayers', { clipId: first.clipId });
		expect(h.labels().at(-1)).toBe('Unlink Layers');
		expect(h.clip(first.clipId).linkId).toBeNull();
		await h.run('sound.toggleLinkLayers', { clipId: first.clipId });
		expect(h.labels().at(-1)).toBe('Link Layers');
		expect(h.clip(second.clipId).linkId).toBe(h.clip(first.clipId).linkId);
	});

	it('Fill Unfilled Cues: one transaction, a different sound on neighbouring cues, deterministic', async () => {
		const run = async () => {
			const h = harness();
			for (const f of [30, 60, 90, 120]) h.addCue(f, 'support');
			const n = h.labels().length;
			const r = await fillUnfilledCues(h.session, h.engine, h.seqId);
			expect(h.labels()).toHaveLength(n + 1);
			expect(h.labels().at(-1)).toBe('Fill Unfilled Cues (4)');
			expect(r.filled).toHaveLength(4);
			expect(r.skipped).toEqual([]);
			for (const c of cuesOf(h.seq())) expect(c.placedClipIds?.length).toBe(1);
			for (let i = 1; i < r.filled.length; i++)
				expect(r.filled[i]!.soundId).not.toBe(r.filled[i - 1]!.soundId);
			for (const f of r.filled) expect(h.clip(f.clipId).sfx!.alternatives?.length).toBe(3);
			// nothing left: the command is disabled
			const again = await runCommand('sound.fillUnfilledCues', h.ctx);
			expect(again.ran).toBe(false);
			// entries get new ids per harness: compare by title
			const doc = h.session.getCommitted();
			return r.filled.map((f) => {
				const c = h.clip(f.clipId);
				return (doc.media[c.mediaId] as { library?: { title: string } }).library?.title;
			});
		};
		expect(await run()).toEqual(await run());
	});

	it('Fill Unfilled Cues leaves muted cues out', async () => {
		const h = harness();
		h.addCue(60, 'support');
		const lockedCue = h.addCue(150, 'support');
		h.apply([{ type: 'soundCue.update', cueId: lockedCue, muted: true }]);
		const r = await fillUnfilledCues(h.session, h.engine, h.seqId);
		expect(r.filled.map((f) => f.cueId)).not.toContain(lockedCue);
		expect(r.filled).toHaveLength(1);
	});
});

describe('Variation cycling', () => {
	it('three presses = ONE history entry "Swap Sound ×3"; peak frame kept; undo restores the original sound', async () => {
		const h = harness();
		soundLibraryPrefs.set({ auditionOnSwap: false });
		const cueId = h.addCue(90);
		const entries = (await h.fake.client.searchSounds({})).results.map((x) => x.sound);
		const r = await fillCueWithSound(h.session, h.engine, entries[0]!, {
			sequenceId: h.seqId,
			cueId,
			alternatives: entries.slice(1).map((e) => e.id),
		});
		const original = h.clip(r.clipId).sfx!.soundId;
		const before = h.session.getCommitted();
		const n = h.labels().length;
		h.session.select('timeline', [r.clipId], 'replace');
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			await cycleVariation(h.session, h.engine, 1, (s) => expect(s.ok, JSON.stringify(s)).toBe(true));
			seen.push(h.clip(r.clipId).sfx!.soundId!);
			expect(Math.floor(pointAt(h, r.clipId))).toBe(90);
		}
		expect(h.labels()).toHaveLength(n + 1);
		expect(h.labels().at(-1)).toBe('Swap Sound ×3');
		// the alternatives first, in order
		expect(seen).toEqual(entries.slice(1, 4).map((e) => e.id));
		// previous goes back one
		await cycleVariation(h.session, h.engine, -1, () => undefined);
		expect(h.clip(r.clipId).sfx!.soundId).toBe(entries[2]!.id);
		expect(h.labels().at(-1)).toBe('Swap Sound ×4');
		expect(h.labels()).toHaveLength(n + 1);
		// one undo restores the original
		h.session.undo();
		expect(h.clip(r.clipId).sfx!.soundId).toBe(original);
		expect(h.session.getCommitted().sequences[h.seqId]).toEqual(before.sequences[h.seqId]);
	});

	it('another edit closes the run: the next press is a new entry', async () => {
		const h = harness();
		soundLibraryPrefs.set({ auditionOnSwap: false });
		const cueId = h.addCue(90);
		const entries = (await h.fake.client.searchSounds({})).results.map((x) => x.sound);
		const r = await fillCueWithSound(h.session, h.engine, entries[0]!, { sequenceId: h.seqId, cueId });
		h.session.select('timeline', [r.clipId], 'replace');
		await h.run('sound.nextVariation');
		await h.run('sound.nextVariation');
		const n = h.labels().length;
		h.apply([{ type: 'clip.update', clipId: r.clipId, patch: { gainDb: -3 } }]);
		await h.run('sound.nextVariation');
		expect(h.labels()).toHaveLength(n + 2);
		expect(h.labels().at(-1)).toBe('Swap Sound');
		expect(h.clip(r.clipId).gainDb).toBe(-3);
	});

	it('Audition on swap plays the 2 s around the sound and never adds history', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		const entries = (await h.fake.client.searchSounds({})).results.map((x) => x.sound);
		const r = await fillCueWithSound(h.session, h.engine, entries[0]!, { sequenceId: h.seqId, cueId });
		h.session.select('timeline', [r.clipId], 'replace');
		h.session.transport.seek(10);
		const n = h.labels().length;
		await cycleVariation(h.session, h.engine, 1, () => undefined);
		expect(inContextStore.getState().active).toBe(true);
		expect(h.session.transport.getState().playing).toBe(true);
		expect(h.session.transport.getState().frame).toBe(60);
		expect(h.labels()).toHaveLength(n + 1);
		stopInContext();
		expect(h.session.transport.getState().frame).toBe(10);
		expect(h.session.transport.getState().playing).toBe(false);
	});
});

describe('Swap (Replace mode)', () => {
	it('Swap Sound… enters Replace mode for the clip; the swap keeps peak frame, track, role, gain and cue', async () => {
		const h = harness();
		soundLibraryPrefs.set({ auditionOnSwap: false });
		const cueId = h.addCue(75);
		const entries = (await h.fake.client.searchSounds({})).results.map((x) => x.sound);
		const r = await fillCueWithSound(h.session, h.engine, entries[0]!, { sequenceId: h.seqId, cueId });
		h.apply([{ type: 'clip.update', clipId: r.clipId, patch: { gainDb: -6 } }]);
		h.session.select('timeline', [r.clipId], 'replace');
		await h.run('sound.swap');
		const target = clipSoundTarget();
		expect(target).toMatchObject({ kind: 'replace', clipId: r.clipId, soundId: entries[0]!.id });
		expect(target!.label).toBe(`${entries[0]!.title} on A4 at 00:00:02:15`);
		const before = h.clip(r.clipId);
		await swapClipSound(h.session, h.engine, h.seqId, r.clipId, entries[3]!);
		const after = h.clip(r.clipId);
		expect(h.labels().at(-1)).toBe(`Swap Sound ${entries[3]!.title}`);
		expect(after.sfx).toMatchObject({ soundId: entries[3]!.id, cueId, role: before.sfx!.role });
		expect(after.trackId).toBe(before.trackId);
		expect(after.gainDb).toBe(-6);
		expect(Math.floor(pointAt(h, r.clipId))).toBe(75);
	});
});

describe('In Context audition', () => {
	it('plays the timeline with the candidate on the selected cue: transient only, no history; returns to the anchor', async () => {
		const h = harness();
		soundLibraryPrefs.set({ preRollSec: 2 });
		const cueId = h.addCue(150);
		h.session.select('cues', [cueId], 'replace');
		h.session.transport.seek(5);
		const doc = h.session.getCommitted();
		const n = h.labels().length;
		const entry = (await h.fake.client.searchSounds({})).results[0]!.sound;
		const r = await auditionInContext(h.session, h.engine, entry);
		expect(r.ok).toBe(true);
		const st = h.session.getState();
		expect(st.document).toBe(doc);
		expect(st.transient).not.toBeNull();
		const drawn = st.transient!.sequences[h.seqId]!;
		const placed = Object.values(drawn.clips).find((c) => (c as SfxClip).sfx?.soundId === entry.id)!;
		expect(placed).toBeTruthy();
		expect(Math.floor(alignedFrameOf(st.transient!, drawn, placed)!)).toBe(150);
		// pre-roll: 2 s before the cue
		expect(h.session.transport.getState().frame).toBe(90);
		expect(h.session.transport.getState().playing).toBe(true);
		expect(inContextStore.getState()).toMatchObject({ active: true, title: entry.title });
		// the window ends 1 s after the candidate: the transport stops there and returns to the cue
		const end = placed.start + placed.duration + 30;
		h.session.transport.reportFrame(end);
		expect(inContextStore.getState().active).toBe(false);
		expect(h.session.getState().transient).toBeNull();
		expect(h.session.getCommitted()).toBe(doc);
		expect(h.labels()).toHaveLength(n);
		expect(h.session.transport.getState().frame).toBe(150);
		expect(h.session.transport.getState().playing).toBe(false);
	});

	it('Replace mode: the replaced clip is muted in the transient document only', async () => {
		const h = harness();
		const cueId = h.addCue(90);
		const entries = (await h.fake.client.searchSounds({})).results.map((x) => x.sound);
		const r = await fillCueWithSound(h.session, h.engine, entries[0]!, { sequenceId: h.seqId, cueId });
		h.session.select('cues', [], 'replace');
		h.session.select('timeline', [r.clipId], 'replace');
		await h.run('sound.swap');
		const ok = await auditionInContext(h.session, h.engine, entries[1]!);
		expect(ok.ok).toBe(true);
		const t = h.session.getState().transient!.sequences[h.seqId]!;
		expect(t.clips[r.clipId]!.enabled).toBe(false);
		expect(h.clip(r.clipId).enabled).toBe(true);
		// any other action (a key press) ends it
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
		await new Promise((res) => setTimeout(res, 5));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
		expect(inContextStore.getState().active).toBe(false);
		expect(h.session.getState().transient).toBeNull();
	});
});

describe('clip commands', () => {
	async function placedClip(h: ReturnType<typeof harness>, frame: number) {
		const cueId = h.addCue(frame);
		const entry = (await h.fake.client.searchSounds({})).results[0]!.sound;
		const r = await fillCueWithSound(h.session, h.engine, entry, { sequenceId: h.seqId, cueId });
		h.session.select('timeline', [r.clipId], 'replace');
		return r.clipId;
	}

	it('Align Peak to Playhead / Nearest Cue, Set Peak at Playhead, Role, Palette: one undo step each', async () => {
		const h = harness();
		const id = await placedClip(h, 60);
		h.session.transport.seek(100);
		await h.run('sound.alignPeakToPlayhead');
		expect(h.labels().at(-1)).toBe('Align Peak to Playhead');
		expect(Math.floor(pointAt(h, id))).toBe(100);
		await h.run('sound.alignPeakToNearestCue');
		expect(Math.floor(pointAt(h, id))).toBe(60);
		const c = h.clip(id);
		h.session.transport.seek(c.start + 3);
		await h.run('sound.setPeakAtPlayhead');
		expect(h.labels().at(-1)).toBe('Set Peak');
		expect(Math.floor(pointAt(h, id))).toBe(c.start + 3);
		expect(h.clip(id).start).toBe(c.start);
		await h.run('sound.setRole.layer');
		expect(sfxOf(h.clip(id))!.role).toBe('layer');
		expect(h.labels().at(-1)).toBe('Sound Role');
		await h.run('sound.addToPalette');
		const pal = (h.seq().soundDesign as { settings?: { palette?: string[] } }).settings?.palette;
		expect(pal).toEqual([sfxOf(h.clip(id))!.soundId]);
		await h.run('sound.addToPalette');
		expect((h.seq().soundDesign as { settings?: { palette?: string[] } }).settings?.palette).toEqual([]);
		expect(h.labels().at(-1)).toBe('Remove from Palette');
	});

	it('at 29.97 fps a point placed on a frame is that frame (not 74.9999…): labels, Align Peak, layers agree', async () => {
		const h = harness(defaultEntries(), 'dv-ntsc');
		const cueId = h.addCue(75);
		const entry = (await h.fake.client.searchSounds({})).results[0]!.sound;
		const r = await fillCueWithSound(h.session, h.engine, entry, { sequenceId: h.seqId, cueId });
		expect(pointAt(h, r.clipId)).toBe(75);
		expect(clipSoundLabel(h.session.getCommitted(), h.seq(), h.clip(r.clipId))).toBe(
			`${entry.title} on A4 at 00;00;02;15`,
		);
		h.session.select('timeline', [r.clipId], 'replace');
		h.session.transport.seek(100);
		await h.run('sound.alignPeakToPlayhead');
		expect(pointAt(h, r.clipId)).toBe(100);
		// already there: nothing to do, no history entry
		const n = h.labels().length;
		await h.run('sound.alignPeakToPlayhead');
		expect(h.labels()).toHaveLength(n);
	});

	it('Add Layer… on a clip opens Fill mode with layer intent for its cue', async () => {
		const h = harness();
		const id = await placedClip(h, 60);
		await h.run('sound.addLayer');
		expect(cueFillTarget()).toMatchObject({ layer: true, cueId: sfxOf(h.clip(id))!.cueId });
	});

	it('Detect Peak measures project audio (decoded samples → analyzeSound) and sets the peak', async () => {
		const h = harness();
		h.apply([{ type: 'media.register', asset: { ...videoAsset(4), id: 'med_0000000000000ABC' } }]);
		h.apply([
			{
				type: 'clip.place',
				source: { mediaId: 'med_0000000000000ABC' },
				at: 30,
				tracks: { video: 'V1', audio: 'A1' },
			},
		]);
		const a = Object.values(h.seq().clips).find((c) => c.kind === 'audio') as AudioClip;
		const sr = 48000;
		const samples = new Float32Array(sr * 2);
		samples[Math.round(0.75 * sr)] = 1; // a click 0.75 s into the media
		const r = await detectClipPeak(h.session, a, h.seq().settings.frameRate, {
			decode: async (_url, _s, c0, c1) => {
				const from = Math.round((c0 / FLICKS_PER_SECOND) * sr);
				const to = Math.round((c1 / FLICKS_PER_SECOND) * sr);
				return { rate: sr, data: [samples.slice(from, Math.min(to, samples.length))] };
			},
			analyze: async (ch, rate) => (await import('@jasper/audio-fx')).analyzeSound(ch, rate),
		});
		expect(Math.abs(r.peakFlicks / FLICKS_PER_SECOND - 0.75)).toBeLessThan(0.003);
		expect(r.truncated).toBe(false);
	});
});
