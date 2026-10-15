// Inserting a library sound (spec 12 §2.3 / §2.7, P1-R7): registered with the engine, then ONE transaction (one undo
// step) — "Sound Effects" bin, media with provenance, track if needed, the clip peak-aligned at the playhead, tagged
// SFX. Undo / redo, reuse of the project's media and bin, refusals, and that nothing changes when the engine fails.
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type Sequence,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { describe, expect, it } from 'vitest';
import { InsertSoundError, insertLibrarySound } from '../src/sound/insert.ts';
import { registered, registeredPadded, soundEntry } from './sound-helpers.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

function setup() {
	const { session, seqId } = makeSession();
	session.transport.seek(45);
	const register = async (id: string) => {
		const e = entries.find((x) => x.id === id)!;
		return registered(e);
	};
	const entries = [
		soundEntry({ title: 'Crunch', peakSec: 0.2325, durationSec: 1.3 }),
		soundEntry({ title: 'Whoosh', types: ['whoosh'], peakSec: 0.6, durationSec: 1.2 }),
	];
	return { session, seqId, engine: { registerSound: register }, entries };
}

const seqOf = (s: ReturnType<typeof setup>) => s.session.getCommitted().sequences[s.seqId] as Sequence;

describe('insertLibrarySound', () => {
	it('adds bin, media (with provenance), clip peak-aligned at the playhead and the SFX type in one undo step', async () => {
		const s = setup();
		const before = s.session.getCommitted();
		const historyBefore = s.session.getState().history.entries.length;
		const r = await insertLibrarySound(s.session, s.engine, s.entries[0]!);
		const doc = s.session.getCommitted();
		const seq = seqOf(s);
		const clip = seq.clips[r.clipId]!;
		const F = flicksPerFrame(seq.settings.frameRate);
		// the peak lands on frame 45: start + (peak − In) in [45, 46) frames
		const peakAt = clip.start * F + (0.2325 * FLICKS_PER_SECOND - (clip as { sourceIn: number }).sourceIn);
		expect(peakAt).toBeGreaterThanOrEqual(45 * F - 2);
		expect(peakAt).toBeLessThan(46 * F);
		// no SFX track yet: a new "SFX 1" (A4), in the same undo step
		expect(r.message).toBe('Added Crunch to A4 · peak at 00:00:01:15');
		expect(r.trackLabel).toBe('A4');
		expect(seq.audioTracks.at(-1)!.name).toBe('SFX 1');
		const media = doc.media[r.mediaId]!;
		expect((media as { library?: { soundId: string } }).library?.soundId).toBe(s.entries[0]!.id);
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin' && i.name === 'Sound Effects');
		expect(bin && 'children' in bin && bin.children.length).toBe(1);
		expect((clip as { essentialSound?: { audioType?: string } }).essentialSound ?? clip).toBeTruthy();
		expect(JSON.stringify(clip)).toContain('"sfx"');
		// committed through soundDesign.place (spec 12 §2.9): the clip records what placed it
		expect((clip as { sfx?: unknown }).sfx).toMatchObject({
			cueId: null,
			soundId: s.entries[0]!.id,
			layer: 0,
			placement: { align: 'peak', errorFlicks: r.errorFlicks },
		});
		expect(s.session.getState().history.entries.length).toBe(historyBefore + 1);
		expect(s.session.getState().selection.timeline.clips).toEqual([r.clipId]);
		// undo removes all of it, redo brings back the same document
		s.session.undo();
		expect(s.session.getCommitted()).toEqual(before);
		s.session.redo();
		expect(s.session.getCommitted()).toEqual(doc);
	});

	it('reuses the bin and the project media, and never overwrites audio (next free track, then a new SFX 1)', async () => {
		const s = setup();
		const a = await insertLibrarySound(s.session, s.engine, s.entries[0]!);
		const b = await insertLibrarySound(s.session, s.engine, s.entries[0]!);
		const doc = s.session.getCommitted();
		expect(b.mediaId).toBe(a.mediaId);
		expect(Object.values(doc.items).filter((i) => i.kind === 'bin')).toHaveLength(1);
		// SFX 1 is busy over the span: a new SFX 2, never the free non-SFX tracks A1–A3
		expect(a.trackLabel).toBe('A4');
		expect(b.trackLabel).toBe('A5');
		const later = await insertLibrarySound(s.session, s.engine, s.entries[0]!, { at: 300 });
		expect(later.trackLabel).toBe('A4');
		const seq = seqOf(s);
		expect(seq.audioTracks.map((t) => t.name).slice(3)).toEqual(['SFX 1', 'SFX 2']);
		// every clip keeps its own track span: no overlaps on any track
		const clips = Object.values(seq.clips);
		for (const x of clips)
			for (const y of clips)
				if (x.id !== y.id && x.trackId === y.trackId)
					expect(x.start + x.duration <= y.start || y.start + y.duration <= x.start).toBe(true);
	});

	it('fills a missing provenance on media the project already has (same file)', async () => {
		const s = setup();
		const e = s.entries[1]!;
		const reg = registered(e);
		const r0 = s.session.apply({
			label: 'import',
			origin: 'user',
			commands: [
				{
					type: 'media.register',
					asset: { ...videoAsset(1.2, true), kind: 'audio', fingerprint: e.fingerprint },
				},
			] as never,
		});
		expect(r0.ok).toBe(true);
		const r = await insertLibrarySound(s.session, { registerSound: async () => reg }, e, {
			align: 'start',
			at: 40,
		});
		const m = s.session.getCommitted().media[r.mediaId] as { library?: { soundId: string } };
		expect(m.library?.soundId).toBe(e.id);
		expect(Object.keys(s.session.getCommitted().media)).toHaveLength(1);
		// `start` aligns the onset (as MCP insert_sound does)
		const clip = seqOf(s).clips[r.clipId]! as { start: number; sourceIn: number };
		const F = flicksPerFrame(seqOf(s).settings.frameRate);
		const onsetAt = clip.start * F + e.descriptors.onsetSec * FLICKS_PER_SECOND - clip.sourceIn;
		expect(Math.abs(onsetAt - 40 * F - r.errorFlicks)).toBeLessThanOrEqual(2);
		expect(r.message).toContain('start at');
	});

	it('aligns by the sound type when not told (risers by their end, UI by their start), like MCP insert_sound', async () => {
		const s = setup();
		const riser = soundEntry({ title: 'Riser', types: ['riser'], peakSec: 2.9, durationSec: 3 });
		const r = await insertLibrarySound(s.session, { registerSound: async () => registered(riser) }, riser, {
			at: 150,
		});
		expect(r.align).toBe('end');
		const clip = seqOf(s).clips[r.clipId]! as { start: number; duration: number; sourceIn: number };
		const F = flicksPerFrame(seqOf(s).settings.frameRate);
		// the last sample plays at frame 150 (+ the reported error)
		const endAt = clip.start * F + 3 * FLICKS_PER_SECOND - clip.sourceIn;
		expect(Math.abs(endAt - 150 * F - r.errorFlicks)).toBeLessThanOrEqual(2);
		expect(r.message).toContain('end at');
		const ui = soundEntry({ title: 'Blip', types: ['ui'], peakSec: 0.05, durationSec: 0.3 });
		const u = await insertLibrarySound(s.session, { registerSound: async () => registered(ui) }, ui, {
			at: 60,
		});
		expect(u.align).toBe('start');
		// an explicit point wins
		const p = await insertLibrarySound(s.session, { registerSound: async () => registered(riser) }, riser, {
			at: 400,
			align: 'peak',
		});
		expect(p.align).toBe('peak');
	});

	it('places a sound the engine padded with lead silence exactly on the frame (errorFlicks 0), from its provenance', async () => {
		const s = setup();
		// a hit whose head is not quiet at all: unpadded, the peak plays up to a frame late
		const hit = soundEntry({ title: 'Hard hit', peakSec: 0.0245, durationSec: 0.6 });
		hit.descriptors.headQuietSec = 0;
		hit.descriptors.onsetSec = 0.009;
		const F = flicksPerFrame(seqOf(s).settings.frameRate);
		const plain = await insertLibrarySound(s.session, { registerSound: async () => registered(hit) }, hit, {
			at: 45,
		});
		expect(plain.errorFlicks).toBeGreaterThan(0);
		expect(plain.errorFlicks).toBeLessThan(F);
		for (const at of [45, 46, 47, 100, 101, 2]) {
			const r = await insertLibrarySound(
				s.session,
				{ registerSound: async () => registeredPadded(hit) },
				hit,
				{
					at,
				},
			);
			expect(r.errorFlicks, `at ${at}`).toBe(0);
			const clip = seqOf(s).clips[r.clipId]! as { start: number; sourceIn: number; mediaId: string };
			// the peak of the PADDED file (0.0245 + 0.05 s) plays exactly at the frame
			const peakAt = clip.start * F + (0.0245 + 0.05) * FLICKS_PER_SECOND - clip.sourceIn;
			expect(Math.abs(peakAt - at * F), `at ${at}`).toBeLessThanOrEqual(1);
			// the In point never cuts into the sound itself (only the lead silence)
			expect(clip.sourceIn).toBeLessThanOrEqual(0.05 * FLICKS_PER_SECOND + 1);
			const m = s.session.getCommitted().media[clip.mediaId] as { library?: { leadSilenceSec?: number } };
			expect(m.library?.leadSilenceSec).toBe(0.05);
		}
	});

	it('refuses without a sequence or in a read-only project, and leaves the project alone when the engine fails', async () => {
		const s = setup();
		const before = s.session.getCommitted();
		await expect(
			insertLibrarySound(
				s.session,
				{ registerSound: async () => Promise.reject(new Error('offline')) },
				s.entries[0]!,
			),
		).rejects.toThrow(/offline/);
		expect(s.session.getCommitted()).toBe(before);
		await expect(
			insertLibrarySound(s.session, s.engine, s.entries[0]!, { sequenceId: 'seq_missing' }),
		).rejects.toBeInstanceOf(InsertSoundError);
		await expect(
			insertLibrarySound(s.session, s.engine, {
				...s.entries[0]!,
				format: { ...s.entries[0]!.format, durationSec: 0 },
				descriptors: { ...s.entries[0]!.descriptors, durationSec: 0 },
			}),
		).rejects.toThrow(/no length/);
		const ids = createCounterIdSource(3);
		const doc = createEmptyProject({ ids, name: 'RO', preset: 'hd-1080p-30' });
		const ro = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			readOnly: true,
			ctx: { ids, now: () => '2026-10-15T00:00:00.000Z', registries: defaultRegistries() },
		});
		await expect(insertLibrarySound(ro, s.engine, s.entries[0]!)).rejects.toThrow(/read-only/);
	});
});
