// spec 12 §2.11 (wp-note sound-design "Phase 6 → WP6.4"): every interchange exporter writes the sound cues as
// `SFX: <type>[+<type>] (<weight>)` sequence markers (or says why it cannot), its report names what of the sound design
// is not carried, the mixer data sound design produces (SFX Room submix and sends, track volume automation, clip audio
// effects, loudness normalisation) is carried (OTIO) or reported by name, and importing the markers back turns them
// into cues again (the Convert Markers to Cues / marker cue source path).
import {
	checkInvariants,
	defaultRegistries,
	deriveCues,
	type LibraryProvenance,
	type Sequence,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { videoAsset } from '../../project/test/helpers.ts';
import { LIB } from '../../project/test/sound-fixtures.ts';
import { exportTimeline, type Format, importTimeline } from '../src/index.ts';
import { Harness, withPath } from './support/rich.ts';

const lib = (over: Partial<LibraryProvenance>): LibraryProvenance => ({ ...LIB, ...over });

/** V1 picture 0–300; A1 music with stop-before automation; cues at 30 (hero whoosh+hit) and 90 (filled: hit, pitched); the SFX Room; −16 LUFS. */
function soundProject() {
	const h = new Harness({ preset: 'hd-1080p-30' });
	const reg = (asset: ReturnType<typeof videoAsset>, path: string) =>
		(h.ok([{ type: 'media.register', asset: withPath(asset, path) }]).results[0] as { mediaId: string })
			.mediaId;
	const pic = reg(videoAsset({ seconds: 10, audio: false }), '/footage/pic.mov');
	const music = reg(videoAsset({ kind: 'audio', seconds: 10 }), '/audio/music.wav');
	const hit = reg(videoAsset({ kind: 'audio', seconds: 1 }), '/sfx/hit.wav');
	h.ok([
		{ type: 'media.setLibraryInfo', mediaId: hit, library: lib({ types: ['hit'], title: 'Hit' }) },
		{ type: 'clip.place', source: { mediaId: pic }, at: 0, tracks: { video: 'V1' } },
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'track.add', kind: 'audio', count: 1 },
	]);
	const r = h.ok([
		{
			type: 'soundCue.add',
			cues: [
				{
					frame: 30,
					kind: 'move',
					weight: 'hero',
					types: ['whoosh', 'hit'],
					source: 'user',
					reason: 'Logo in',
					ref: '$a',
				},
				{
					frame: 90,
					kind: 'land',
					weight: 'support',
					source: 'user',
					stopBefore: { seconds: 0.25, depthDb: -18 },
					ref: '$b',
				},
			],
		},
	]);
	h.ok([
		{ type: 'soundDesign.place', cueId: r.refs.$b!, layers: [{ mediaId: hit, track: 'A2', pitchSt: 5 }] },
	]);
	h.ok([
		{ type: 'soundDesign.applyStopBefore', cueId: r.refs.$b! },
		{ type: 'soundDesign.ensureBus' },
		{ type: 'mixer.setLoudness', enabled: true, targetLufs: -16, truePeakDb: -1 },
	]);
	const seq = h.seq;
	expect(seq.submixTracks).toHaveLength(1);
	expect((seq.audioTracks[0]!.volumeDb?.keyframes ?? []).length).toBeGreaterThan(0);
	const sfx = Object.values(seq.clips).find((c) => (c as { sfx?: unknown }).sfx)!;
	expect((sfx as { effects: { effectId: string }[] }).effects.map((e) => e.effectId)).toContain(
		'jasper.audio.pitch-shifter',
	);
	return h;
}

const MARKER_FORMATS: Format[] = ['fcp7', 'fcpxml', 'otio', 'edl', 'aaf'];
const ALL: Format[] = [...MARKER_FORMATS, 'omf', 'ale'];

function reimport(bytes: Uint8Array, format: Format) {
	const imp = importTimeline(bytes, { format, now: '2026-10-17T00:00:00.000Z', rate: { num: 30, den: 1 } });
	const target = new Harness({ preset: 'hd-1080p-30', seed: 4242 });
	const r = target.ok([{ type: 'project.importTimeline', fragment: imp }]);
	const seqId = (r.results[0] as { topSequenceIds: string[] }).topSequenceIds[0]!;
	expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
	return { target, seq: target.doc.sequences[seqId]! as Sequence, imp };
}

describe('sound design in interchange exports (spec 12 §2.11)', () => {
	it.each(ALL)('%s: reports cue loss or preserves SFX markers at their cue frames', (format) => {
		const h = soundProject();
		const out = exportTimeline(h.doc, h.seqId, format);
		const entry = out.report.entries.find((e) => e.message.includes('sound design cue'));
		expect(entry, out.report.toString()).toBeDefined();
		expect(entry!.level).toBe('info');
		expect(entry!.subject).toMatchObject({ kind: 'sequence', id: h.seqId });
		expect(entry!.message).toMatch(/proposals.*not carried/);
		if (format === 'omf' || format === 'ale')
			expect(entry!.message).toMatch(/the 2 sound design cue\(s\) of ".*" are not carried/);
		else {
			expect(entry!.message).toMatch(
				/the 2 sound design cue\(s\) of ".*" are exported as "SFX: <type> \(<weight>\)" markers/,
			);
			const { seq } = reimport(out.files[0]!.bytes, format);
			const sfx = seq.markers.filter((m) => m.name.startsWith('SFX:')).map((m) => [m.frame, m.name]);
			expect(sfx).toEqual([
				[30, 'SFX: whoosh+hit (hero)'],
				[90, 'SFX: hit (support)'],
			]);
		}
	});

	it('the re-imported markers become cues again with their types and weight (marker cue source)', () => {
		const h = soundProject();
		const { target, seq } = reimport(exportTimeline(h.doc, h.seqId, 'fcpxml').files[0]!.bytes, 'fcpxml');
		const cues = deriveCues(target.doc, seq.id, { sources: ['markers'] }).cues;
		expect(cues.map((c) => [c.frame, c.kind, c.weight, (c.types ?? []).join('+')])).toEqual([
			[30, 'manual', 'hero', 'whoosh+hit'],
			[90, 'manual', 'support', 'hit'],
		]);
		const r = target.ok([
			{
				type: 'soundCue.add',
				sequenceId: seq.id,
				cues: cues.map((c) => ({
					frame: c.frame,
					kind: c.kind,
					weight: c.weight,
					types: c.types,
					source: 'marker',
				})),
			},
		]);
		expect((r.results[0] as { cueIds: string[] }).cueIds).toHaveLength(2);
	});

	it('names the sound design mixer data each format cannot carry (never silently dropped)', () => {
		const h = soundProject();
		const msgs = (f: Format) => exportTimeline(h.doc, h.seqId, f).report.entries.map((e) => e.message);
		for (const f of ['fcp7', 'fcpxml', 'edl', 'aaf', 'omf'] as const) {
			const m = msgs(f);
			expect(
				m.some((x) => /submix track\(s\) of ".*" are not carried/.test(x)),
				`${f}: ${m.join(' | ')}`,
			).toBe(true);
			expect(
				m.some((x) => /the sends.* of track A2 are not carried/.test(x)),
				`${f}`,
			).toBe(true);
			expect(
				m.some((x) => /loudness normalisation of ".*" \(-16 LUFS, -1 dBTP ceiling\) is not carried/.test(x)),
				f,
			).toBe(true);
			expect(
				m.some((x) => /volume and pan of track A1/.test(x)),
				`${f}: ${m.join(' | ')}`,
			).toBe(true);
		}
		for (const f of ['aaf', 'omf'] as const)
			expect(
				msgs(f).some((x) =>
					/audio effects \(jasper\.audio\.pitch-shifter\) of .* are not carried by (AAF|OMF)/.test(x),
				),
			).toBe(true);
		// OTIO carries all of it in its metadata
		const otio = msgs('otio');
		expect(
			otio.some((x) => /submix|sends|loudness normalisation|volume and pan/.test(x)),
			otio.join(' | '),
		).toBe(false);
	});

	it('OTIO restores the SFX Room (submix, sends, output), the automation and the loudness; twice in a project', () => {
		const h = soundProject();
		const bytes = exportTimeline(h.doc, h.seqId, 'otio').files[0]!.bytes;
		const { target, seq, imp } = reimport(bytes, 'otio');
		expect(imp.warnings.filter((w) => w.level === 'warning')).toEqual([]);
		const src = h.seq;
		expect(seq.submixTracks).toHaveLength(1);
		expect((seq.submixTracks![0]!.effects ?? []).map((e) => e.effectId)).toEqual(
			(src.submixTracks![0]!.effects ?? []).map((e) => e.effectId),
		);
		const sends = seq.audioTracks.flatMap((t) => t.mixer?.sends ?? []);
		expect(sends.length).toBe(src.audioTracks.flatMap((t) => t.mixer?.sends ?? []).length);
		for (const s of sends) expect(s.target).toBe(seq.submixTracks![0]!.id);
		expect(seq.audioTracks[0]!.volumeDb!.keyframes.map((k) => k.value)).toEqual(
			src.audioTracks[0]!.volumeDb!.keyframes.map((k) => k.value),
		);
		expect(seq.master.loudness).toMatchObject({ enabled: true, targetLufs: -16, truePeakDb: -1 });
		// a second import of the same file into the same project gets its own ids
		const imp2 = importTimeline(bytes, { format: 'otio', now: '2026-10-17T00:00:00.000Z' });
		target.ok([{ type: 'project.importTimeline', fragment: imp2 }]);
		expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
	});

	it('OTIO: a hostile submix / routing in the metadata is dropped and reported, the import goes on', () => {
		const h = soundProject();
		const j = JSON.parse(new TextDecoder().decode(exportTimeline(h.doc, h.seqId, 'otio').files[0]!.bytes));
		// make the submix unreadable and point every send at a submix the file does not carry
		let subs = 0;
		let sends = 0;
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v === 'object')
				for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
					if (k === 'submixTracks' && Array.isArray(x)) {
						x.push({ ...(x[0] as object), kind: 7 });
						subs++;
					} else if (k === 'sends' && Array.isArray(x))
						for (const snd of x as { target: string }[]) {
							snd.target = 'trk_NOPE000000000000';
							sends++;
						}
					else walk(x);
				}
		};
		walk(j);
		expect(subs).toBe(1);
		expect(sends).toBeGreaterThan(0);
		const text = JSON.stringify(j);
		const { seq, imp } = reimport(new TextEncoder().encode(text), 'otio');
		expect(seq.audioTracks.flatMap((t) => t.mixer?.sends ?? [])).toEqual([]);
		const warns = imp.warnings.map((w) => w.message);
		expect(
			warns.some((m) => /submix track of .* is unreadable/.test(m)),
			warns.join(' | '),
		).toBe(true);
		expect(
			warns.some((m) => /mixer setting\(s\) of .* name a submix the document does not carry/.test(m)),
		).toBe(true);
	});

	it('OTIO: arbitrary submix / mixer metadata never breaks the import (property)', () => {
		const h = soundProject();
		const base = JSON.parse(new TextDecoder().decode(exportTimeline(h.doc, h.seqId, 'otio').files[0]!.bytes));
		const mixerish = fc.oneof(
			fc.anything(),
			fc.record({
				output: fc.oneof(fc.string(), fc.constant(null)),
				sends: fc.array(
					fc.record({
						id: fc.string(),
						target: fc.string(),
						levelDb: fc.record({ value: fc.double(), keyframes: fc.constant([]) }),
						pan: fc.double(),
					}),
					{ maxLength: 3 },
				),
				lanes: fc.dictionary(fc.string(), fc.anything()),
			}),
		);
		fc.assert(
			fc.property(fc.array(fc.anything(), { maxLength: 3 }), mixerish, (subs, mixer) => {
				const j = JSON.parse(JSON.stringify(base));
				const walk = (v: unknown): void => {
					if (Array.isArray(v)) v.forEach(walk);
					else if (v && typeof v === 'object')
						for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
							if (k === 'submixTracks') (v as Record<string, unknown>)[k] = [...(x as unknown[]), ...subs];
							else if (k === 'mixer') (v as Record<string, unknown>)[k] = mixer;
							else walk(x);
						}
				};
				walk(j);
				const imp = importTimeline(new TextEncoder().encode(JSON.stringify(j)), {
					format: 'otio',
					now: '2026-10-17T00:00:00.000Z',
				});
				const target = new Harness({ preset: 'hd-1080p-30', seed: 7 });
				target.ok([{ type: 'project.importTimeline', fragment: imp }]);
				return checkInvariants(target.doc, { effects: defaultRegistries().effects }).length === 0;
			}),
			{ numRuns: Number(process.env.FC_RUNS ?? 150) },
		);
	});
});
