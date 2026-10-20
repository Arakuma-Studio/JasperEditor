// spec 12 §2.11 (wp-note sound-design "Phase 6 → WP6.4"): the credits of what an export PLAYS (range, nested sequences,
// muted tracks and disabled clips), the sidecar text, the export dialog's default, the interchange cue markers (and
// reading them back), and pasting / importing a sequence with a room bus and cues twice.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	buildItemsPayload,
	buildRenderSnapshot,
	type ClipboardPayload,
	checkInvariants,
	cueMarkers,
	defaultCreditsSidecar,
	defaultRegistries,
	deriveCues,
	type LibraryProvenance,
	parseSfxRequest,
	playedLibraryClips,
	type RenderSnapshot,
	type SoundCue,
	soundCredits,
	soundCreditsFileText,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const lib = (over: Partial<LibraryProvenance>): LibraryProvenance => ({ ...LIB, ...over });

function snapshotOf(h: Harness, range?: { start: number; end: number }): RenderSnapshot {
	return buildRenderSnapshot(h.doc, h.seqId, {
		...(range ? { range } : {}),
		resolveMedia: (a) => ({
			url: a.id,
			proxyUrl: null,
			kind: a.kind,
			width: null,
			height: null,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: true,
			rotation: 0,
		}),
		resolveFont: () => null,
	});
}

/** A1: by 0–30 (CC BY), cc0 100–130, disabled 150–180 (CC BY); A2 muted: sa 100–130; A3: a nest 200–290 of two sounds. */
function project() {
	const h = new Harness();
	const add = (library: LibraryProvenance) => {
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library }]);
		return m;
	};
	const by = add(
		lib({ soundId: 'snd_by', title: 'Whoosh By', license: 'CC-BY-4.0', author: 'Ana', attribution: null }),
	);
	const cc0 = add(lib({ soundId: 'snd_cc0', title: 'Zap Zero' }));
	const dis = add(lib({ soundId: 'snd_dis', title: 'Disabled Hit', license: 'CC-BY-4.0', author: 'Bo' }));
	const sa = add(lib({ soundId: 'snd_sa', title: 'Muted Riser', license: 'CC-BY-SA-4.0', author: 'Cy' }));
	const inA = add(
		lib({
			soundId: 'snd_in_a',
			title: 'Nested Thump',
			license: 'CC-BY-3.0',
			author: 'Di',
			attribution: '"Nested Thump" by Di, CC BY 3.0',
		}),
	);
	const inB = add(lib({ soundId: 'snd_in_b', title: 'Nested Late', license: 'CC-BY-4.0', author: 'Ed' }));
	h.ok([{ type: 'track.add', kind: 'audio', count: 2 }]);
	const place = (m: string, at: number, track: string) => {
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at, tracks: { audio: track } }]);
		return Object.values(h.seq.clips).find(
			(c) => (c as { mediaId?: string }).mediaId === m && c.start === at,
		)!.id;
	};
	const cBy = place(by, 0, 'A1');
	const cCc0 = place(cc0, 100, 'A1');
	const cDis = place(dis, 150, 'A1');
	const cSa = place(sa, 100, 'A2');
	const cInA = place(inA, 200, 'A3');
	const cInB = place(inB, 260, 'A3');
	h.ok([
		{ type: 'clip.update', clipId: cDis, patch: { enabled: false } },
		{ type: 'track.update', trackId: 'A2', patch: { mute: true } },
	]);
	const r = h.ok([{ type: 'clip.nest', clipIds: [cInA, cInB], name: 'Inner' }]);
	const innerId = (r.results[0] as { sequenceId: string }).sequenceId;
	const nest = Object.values(h.seq.clips).find((c) => c.kind === 'nest-audio')!;
	const inner = h.doc.sequences[innerId]!;
	const innerA = Object.values(inner.clips).find((c) => (c as { mediaId?: string }).mediaId === inA)!;
	return { h, by, cc0, dis, sa, inA, inB, cBy, cCc0, cDis, cSa, nest, innerA, innerId };
}

describe('soundCredits of what an export plays (spec 12 §2.11)', () => {
	it('counts only the clips the mixer plays in the range: no muted track, no disabled clip, nests by their range', () => {
		const p = project();
		const snap = snapshotOf(p.h, { start: 90, end: 240 });
		const played = playedLibraryClips(snap);
		const c = soundCredits(p.h.doc, p.h.seqId, { played });
		expect(c.rows.map((r) => r.soundId)).toEqual(['snd_in_a', 'snd_cc0']);
		const nested = c.rows.find((r) => r.soundId === 'snd_in_a')!;
		expect(nested.usedIn).toEqual([`${p.nest.id}>${p.innerA.id}`]);
		expect(nested.sequenceIds).toEqual([p.h.seqId]);
		// the whole-sequence credits (File ▸ Export ▸ Sound Credits…) still list everything
		expect(soundCredits(p.h.doc, p.h.seqId).rows).toHaveLength(6);
		// the entire sequence: the first whoosh too, still not the muted or disabled ones
		const all = soundCredits(p.h.doc, p.h.seqId, { played: playedLibraryClips(snapshotOf(p.h)) });
		expect(all.rows.map((r) => r.soundId).sort()).toEqual(['snd_by', 'snd_cc0', 'snd_in_a', 'snd_in_b']);
		// unmuting the track and enabling the clip brings them in
		p.h.ok([
			{ type: 'track.update', trackId: 'A2', patch: { mute: false } },
			{ type: 'clip.update', clipId: p.cDis, patch: { enabled: true } },
		]);
		const more = soundCredits(p.h.doc, p.h.seqId, { played: playedLibraryClips(snapshotOf(p.h)) });
		expect(more.rows.map((r) => r.soundId).sort()).toEqual([
			'snd_by',
			'snd_cc0',
			'snd_dis',
			'snd_in_a',
			'snd_in_b',
			'snd_sa',
		]);
	});

	it('writes the sidecar as text, Markdown or CSV with the credit lines verbatim; nothing when nothing plays', () => {
		const p = project();
		const played = playedLibraryClips(snapshotOf(p.h, { start: 90, end: 240 }));
		const c = soundCredits(p.h.doc, p.h.seqId, { played });
		const txt = soundCreditsFileText(c, 'txt');
		expect(txt).toBe(`${c.text}\n`);
		expect(txt.split('\n')).toEqual([
			'Sound credits',
			'',
			'"Nested Thump" by Di, CC BY 3.0',
			'"Zap Zero" by Kenney, CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Source: https://kenney.nl/assets/impact-sounds',
			'',
		]);
		expect(soundCreditsFileText(c, 'md')).toBe(`${c.markdown}\n`);
		expect(soundCreditsFileText(c, 'md')).toContain('| Nested Thump | Di |');
		expect(soundCreditsFileText(c, 'csv')).toBe(c.csv);
		expect(soundCreditsFileText(c, 'csv').trimEnd().split('\r\n')).toHaveLength(3);
		const only = soundCredits(p.h.doc, p.h.seqId, { played, attributionOnly: true });
		expect(only.rows.map((r) => r.soundId)).toEqual(['snd_in_a']);
		const none = soundCredits(p.h.doc, p.h.seqId, {
			played: playedLibraryClips(snapshotOf(p.h, { start: 40, end: 90 })),
		});
		expect(none.rows).toEqual([]);
		for (const f of ['txt', 'md', 'csv'] as const) expect(soundCreditsFileText(none, f)).toBe('');
	});

	it('ignores synthetic sources and hostile played lists', () => {
		const p = project();
		expect(
			playedLibraryClips({ audioClips: [{ clipId: 'a', mediaId: 'syn:x' }, { clipId: 1 }, null] as never }),
		).toEqual([]);
		expect(playedLibraryClips({} as never)).toEqual([]);
		fc.assert(
			fc.property(fc.anything(), (played) => {
				const c = soundCredits(p.h.doc, p.h.seqId, {
					played: (Array.isArray(played) ? played : []) as never,
				});
				return Array.isArray(c.rows);
			}),
			{ numRuns: 300 },
		);
	});

	it('defaults the export dialog: the sequence setting, else Markdown when a used sound needs a credit', () => {
		const p = project();
		expect(defaultCreditsSidecar(p.h.doc, p.h.seqId)).toBe('md');
		p.h.ok([{ type: 'soundDesign.setSettings', credits: 'csv' }]);
		expect(defaultCreditsSidecar(p.h.doc, p.h.seqId)).toBe('csv');
		p.h.ok([{ type: 'soundDesign.setSettings', credits: null }]);
		expect(defaultCreditsSidecar(p.h.doc, p.h.seqId)).toBeNull();
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio' });
		h.ok([
			{ type: 'media.setLibraryInfo', mediaId: m, library: LIB },
			{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } },
		]);
		expect(defaultCreditsSidecar(h.doc, h.seqId)).toBeNull();
		expect(defaultCreditsSidecar(h.doc, 'seq_missing')).toBeNull();
	});
});

describe('cue markers for interchange (spec 12 §2.11)', () => {
	function cueProject() {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: lib({ types: ['boom', 'hit'] }) }]);
		const r = h.ok([
			{ type: 'marker.add', frame: 300, name: 'sfx: click' },
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 30,
						kind: 'move',
						weight: 'hero',
						types: ['whoosh', 'hit'],
						source: 'user',
						reason: 'Logo flies in',
						ref: '$a',
					},
					{ frame: 90, kind: 'land', weight: 'support', source: 'user', ref: '$b' },
					{
						frame: 150,
						kind: 'cut',
						weight: 'ambient',
						source: 'agent',
						muted: true,
						label: 'Room',
						ref: '$c',
					},
				],
			},
		]);
		h.ok([{ type: 'soundDesign.place', cueId: r.refs.$b!, layers: [{ mediaId: m, track: 'A1' }] }]);
		const markerId = h.seq.markers[0]!.id;
		h.ok([
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 300,
						kind: 'manual',
						weight: 'support',
						types: ['click'],
						source: 'marker',
						anchor: { type: 'marker', markerId },
					},
				],
			},
		]);
		return { h, refs: r.refs };
	}

	it('names one marker per cue SFX: <types> (<weight>) — the cue types, else the placed sound types, else the kind', () => {
		const { h, refs } = cueProject();
		const ms = cueMarkers(h.doc, h.seq);
		expect(ms.map((m) => [m.frame, m.name])).toEqual([
			[30, 'SFX: whoosh+hit (hero)'],
			[90, 'SFX: boom+hit (support)'],
			[150, 'SFX: cut (ambient)'],
		]);
		expect(ms[0]).toMatchObject({ cueId: refs.$a, comment: 'Logo flies in', duration: 0 });
		expect(ms[2]!.comment).toBe('Room · muted');
		// the marker-made cue is not written twice (its marker is exported already); without the marker it is
		const doc = JSON.parse(JSON.stringify(h.doc));
		doc.sequences[h.seqId].markers = [];
		expect(cueMarkers(doc, doc.sequences[h.seqId]).map((m) => m.name)).toContain('SFX: click (support)');
	});

	it('reads the markers back: types and weight (Convert Markers to Cues, derived marker cues)', () => {
		expect(parseSfxRequest('SFX: whoosh+hit (hero)')).toEqual({
			names: ['whoosh', 'hit'],
			types: ['whoosh', 'hit'],
			weight: 'hero',
		});
		expect(parseSfxRequest('sfx: swoosh + sub drop ( Ambient )')).toMatchObject({
			types: ['whoosh', 'boom'],
			weight: 'ambient',
		});
		expect(parseSfxRequest('sfx: hit')).toEqual({ names: ['hit'], types: ['hit'] });
		expect(parseSfxRequest('SFX: cut (support)')).toMatchObject({ types: [], weight: 'support' });
		const { h } = cueProject();
		const ms = cueMarkers(h.doc, h.seq);
		// a fresh sequence with the markers: derived marker cues carry the weight
		const g = new Harness();
		const bed = g.registerVideo({ kind: 'audio', seconds: 14 });
		g.ok([
			{ type: 'clip.place', source: { mediaId: bed }, at: 0, tracks: { audio: 'A1' } },
			...ms.map((m) => ({ type: 'marker.add', frame: m.frame, name: m.name, comment: m.comment })),
		]);
		const derived = deriveCues(g.doc, g.seqId, { sources: ['markers'], range: { start: 0, end: 400 } }).cues;
		expect(derived.map((c) => [c.frame, c.weight, (c.types ?? []).join('+')])).toEqual([
			[30, 'hero', 'whoosh+hit'],
			[90, 'support', 'boom+hit'],
			[150, 'ambient', ''],
		]);
	});

	it('never throws on hostile sound design data', () => {
		fc.assert(
			fc.property(fc.anything(), fc.anything(), (sd, markers) => {
				const out = cueMarkers({ media: {} }, { soundDesign: sd, markers: markers as never, clips: {} });
				return out.every((m) => typeof m.name === 'string' && m.name.startsWith('SFX: '));
			}),
			{ numRuns: 500 },
		);
		const cues = { c1: { id: 'cue_1', frame: 3, kind: 'x y', weight: 'odd', types: ['UPPER', 7, 'ok'] } };
		expect(cueMarkers({}, { soundDesign: { cues } }).map((m) => m.name)).toEqual(['SFX: ok (support)']);
		expect(cueMarkers({}, { soundDesign: { cues: { c: { id: 'cue_2', frame: -1 } } } })).toEqual([]);
		expect(
			cueMarkers({}, { soundDesign: { cues: { c: { id: 'cue_3', frame: 4 } } as never } })[0]!.name,
		).toBe('SFX: sound (support)');
	});
});

describe('pasting / importing a sequence with a room bus and cues (copySequence)', () => {
	it('gives the copy its own submix, sends and cues; twice in one project stays valid', () => {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: LIB }]);
		h.ok([{ type: 'track.add', kind: 'audio', count: 1 }]);
		const r = h.ok([
			{
				type: 'soundCue.add',
				cues: [{ frame: 60, kind: 'land', weight: 'hero', source: 'user', ref: '$c' }],
			},
		]);
		h.ok([
			{ type: 'soundDesign.place', cueId: r.refs.$c!, layers: [{ mediaId: m, track: 'A2', role: 'hero' }] },
		]);
		h.ok([{ type: 'soundDesign.ensureBus' }]);
		const src = h.seq;
		expect(src.submixTracks).toHaveLength(1);
		const seqItem = Object.values(h.doc.items).find(
			(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === src.id,
		)!;
		const payload = JSON.parse(JSON.stringify(buildItemsPayload(h.doc, [seqItem.id]))) as ClipboardPayload;
		const copies: string[] = [];
		for (let i = 0; i < 2; i++) {
			const res = h.ok([{ type: 'project.pasteItems', payload }]).results[0] as { sequenceIds: string[] };
			copies.push(res.sequenceIds[0]!);
		}
		expect(checkInvariants(h.doc, { effects: defaultRegistries().effects })).toEqual([]);
		const subIds = new Set<string>([src.submixTracks![0]!.id]);
		for (const id of copies) {
			const copy = h.doc.sequences[id]!;
			const sub = copy.submixTracks![0]!;
			expect(subIds.has(sub.id)).toBe(false);
			subIds.add(sub.id);
			const sends = copy.audioTracks.flatMap((t) => t.mixer?.sends ?? []);
			expect(sends.length).toBeGreaterThan(0);
			for (const s of sends) expect(s.target).toBe(sub.id);
			const cues = Object.values((copy.soundDesign as { cues: Record<string, SoundCue> }).cues);
			expect(cues).toHaveLength(1);
			const placed = cues[0]!.placedClipIds ?? [];
			expect(placed.length).toBe(1);
			expect(copy.clips[placed[0]!]).toBeDefined();
			expect((copy.clips[placed[0]!] as { sfx?: { cueId: string | null } }).sfx?.cueId).toBe(cues[0]!.id);
			expect((copy.soundDesign as { settings?: { roomBus?: string | null } }).settings?.roomBus).toBe(sub.id);
		}
	});
});
