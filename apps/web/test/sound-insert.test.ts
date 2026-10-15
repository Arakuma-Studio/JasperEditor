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
import { registered, soundEntry } from './sound-helpers.ts';
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
		expect(r.message).toBe('Added Crunch to A1 · peak at 00:00:01:15');
		expect(r.trackLabel).toBe('A1');
		const media = doc.media[r.mediaId]!;
		expect((media as { library?: { soundId: string } }).library?.soundId).toBe(s.entries[0]!.id);
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin' && i.name === 'Sound Effects');
		expect(bin && 'children' in bin && bin.children.length).toBe(1);
		expect((clip as { essentialSound?: { audioType?: string } }).essentialSound ?? clip).toBeTruthy();
		expect(JSON.stringify(clip)).toContain('"sfx"');
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
		expect(b.trackLabel).toBe('A2');
		await insertLibrarySound(s.session, s.engine, s.entries[0]!);
		const d = await insertLibrarySound(s.session, s.engine, s.entries[0]!);
		const seq = seqOf(s);
		expect(d.trackLabel).toBe('A4');
		expect(seq.audioTracks.at(-1)!.name).toBe('SFX 1');
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
			at: 10,
		});
		const m = s.session.getCommitted().media[r.mediaId] as { library?: { soundId: string } };
		expect(m.library?.soundId).toBe(e.id);
		expect(Object.keys(s.session.getCommitted().media)).toHaveLength(1);
		expect(seqOf(s).clips[r.clipId]!.start).toBe(10);
		expect(r.message).toContain('start at');
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
