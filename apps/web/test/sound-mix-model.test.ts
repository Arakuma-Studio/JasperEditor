// WP4.2b mix model (pure): level views (default / solver / manual with translated reasons and track names), the review
// row's gain text, the room seen from a clip's track (sends, interface-only and bed tracks), a cue's stop-before / build
// written vs stored (and why), the field validation, the delivery labels; fuzzed inputs never throw.
import type { AudioClip, ClipSfx, Sequence } from '@jasper/project';
import { DELIVERY_PRESETS } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cuesOf } from '../src/sound/cues/model.ts';
import {
	cueMixState,
	deliveryOptionLabel,
	fmtDb,
	limitPhrase,
	parseNumber,
	reviewGainText,
	roomViewOf,
	sfxLevelView,
	solverReason,
	validateBuild,
	validateStopBefore,
} from '../src/sound/mix-model.ts';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const sfx = (level?: unknown): ClipSfx =>
	({
		cueId: null,
		soundId: null,
		layer: 0,
		role: 'support',
		placement: { align: 'peak', peakFlicks: 0, errorFlicks: 0 },
		...(level ? { level } : {}),
	}) as ClipSfx;
const clip = (gainDb: number, level?: unknown) =>
	({ id: 'clp_1', kind: 'audio', gainDb, trackId: 'trk_a', sfx: sfx(level) }) as unknown as AudioClip;

describe('levels', () => {
	it('formats dB with a real minus and one decimal', () => {
		expect(fmtDb(-3)).toBe('−3.0');
		expect(fmtDb(1.54)).toBe('+1.5');
		expect(fmtDb(-0.01)).toBe('0.0');
		expect(fmtDb(Number.NaN)).toBe('–');
	});

	it('solver: badge, translated limits with the track names, lifts', () => {
		const v = sfxLevelView(
			clip(-3, {
				by: 'solver',
				gainDb: -3,
				targetLiftDb: 3.5,
				achievedLiftDb: 1.2,
				limitedBy: ['dialogue', 'headroom'],
				reason: '−3 dB, limited by dialogue A1, A2, headroom (−1 dBTP)',
			}),
		)!;
		expect(v).toMatchObject({ owner: 'solver', auto: true, manual: false, badge: 'Solver' });
		expect(v.text).toBe('−3.0 dB · limited by dialogue A1, A2, headroom');
		expect(v.targetLiftDb).toBe(3.5);
		expect(v.achievedLiftDb).toBe(1.2);
		expect(limitPhrase('bed-cap', '−2 dB, limited by the bed level (A1)')).toBe('the bed level (A1)');
		expect(limitPhrase('conflict:bed-cap/consistency')).toBe(
			'conflict: the bed level kept over its repeats (±2 dB)',
		);
		expect(solverReason({ limitedBy: [], targetLiftDb: 5, achievedLiftDb: 5 })).toBe(
			'target lift +5.0 dB reached',
		);
		expect(solverReason({ limitedBy: [], targetLiftDb: 3.5, achievedLiftDb: 9 })).toBe(
			'clears the bed by +9.0 dB',
		);
	});

	it('default, manual (auto off) and a gain set by hand', () => {
		const d = sfxLevelView(clip(-11, { by: 'default', gainDb: -11, targetLufs: -22, limitedBy: 'peak' }))!;
		expect(d).toMatchObject({ owner: 'default', auto: true, badge: 'Default' });
		expect(d.text).toBe('−11.0 dB · default level: its true-peak ceiling');
		const m = sfxLevelView(
			clip(-6, { by: 'solver', gainDb: -6, limitedBy: ['dialogue'], reason: 'x', manual: true }),
		)!;
		expect(m).toMatchObject({ owner: 'user', auto: false, manual: true, badge: 'Manual' });
		expect(m.text).toBe('−6.0 dB · Auto gain off (last solve: −6.0 dB)');
		const u = sfxLevelView(clip(2, { by: 'default', gainDb: -11, targetLufs: -22, limitedBy: 'peak' }))!;
		expect(u).toMatchObject({ owner: 'user', auto: false, manual: false, text: '+2.0 dB · set by you' });
		expect(sfxLevelView({ kind: 'video' } as never)).toBeNull();
	});

	it('review rows: the gain and what limited it (not for an alternative)', () => {
		const meta = {
			level: { gainDb: -16.2, limitedBy: ['dialogue'], reason: '−16.2 dB, limited by dialogue A2' },
		};
		expect(reviewGainText(-16.2, meta)).toBe('−16.2 dB · limited by dialogue A2');
		expect(reviewGainText(-16.2, meta, true)).toBe('−16.2 dB');
		expect(reviewGainText(-4, { limitedBy: ['hero-shadow'] })).toBe(
			'−4.0 dB · limited by a hero within 0.15 s',
		);
		// the item's own solved gain wins over the drawn ghost's (a delivery setup item changes the music in the preview)
		expect(reviewGainText(14.6, { level: { gainDb: -15.6, limitedBy: ['consistency'] } })).toBe(
			'−15.6 dB · limited by its repeats (±2 dB)',
		);
		expect(reviewGainText(14.6, { level: { gainDb: -15.6, limitedBy: ['consistency'] } }, true)).toBe(
			'+14.6 dB',
		);
		expect(reviewGainText(null, { gainDb: -3, limitedBy: [] })).toBe('−3.0 dB');
		expect(reviewGainText(null, {})).toBe('');
		expect(reviewGainText(1, null)).toBe('+1.0 dB');
	});

	it('never throws on hostile levels and metas', () => {
		fc.assert(
			fc.property(fc.anything(), fc.anything(), fc.double(), (level, meta, g) => {
				const v = sfxLevelView(clip(g, level));
				expect(typeof v?.text).toBe('string');
				expect(typeof reviewGainText(g, meta)).toBe('string');
			}),
			{ numRuns: 300 },
		);
	});
});

/** Music on A1 (0–10 s), a hero cue at 150 filled by a sound on A2. */
function mixFixture() {
	const { session, seqId } = makeSession();
	const ok = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	ok([
		{ type: 'media.register', asset: audioAsset(10), ref: '$music' },
		{ type: 'media.register', asset: audioAsset(1), ref: '$hit' },
		{ type: 'track.add', kind: 'audio', name: 'SFX 1' },
		{ type: 'clip.place', source: { mediaId: '$music' }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'soundCue.add', cues: [{ frame: 150, kind: 'land', weight: 'hero', source: 'user' }] },
	]);
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const cueId = cuesOf(seq())[0]!.id;
	const hit = Object.keys(session.getCommitted().media).find(
		(id) => (session.getCommitted().media[id]!.probe.durationFlicks ?? 0) < 705_600_000 * 2,
	)!;
	return { session, seqId, ok, seq, cueId, hit };
}

describe('cue stop-before / build: written vs stored', () => {
	it('unfilled = stored only (why), filled = written on the music track; removal', () => {
		const f = mixFixture();
		f.ok([
			{
				type: 'soundCue.update',
				cueId: f.cueId,
				stopBefore: { seconds: 0.5, depthDb: -24 },
				build: { seconds: 2, fromHz: 150, toHz: 2000 },
			},
		]);
		let st = cueMixState(f.seq(), cuesOf(f.seq())[0]!);
		expect(st.stopBefore.written).toBeNull();
		expect(st.stopBefore.stored).toEqual({ start: 135, end: 150 });
		expect(st.stopBefore.why).toBe('Written into the mix when the cue is filled');
		expect(st.build.why).toBe('Written into the mix when the cue is filled');
		f.ok([
			{
				type: 'soundDesign.place',
				cueId: f.cueId,
				layers: [{ mediaId: f.hit, track: 'A2', align: 'start' }],
			},
		]);
		st = cueMixState(f.seq(), cuesOf(f.seq())[0]!);
		expect(st.stopBefore.written).toEqual({ start: 135, end: 150, places: ['A1 track volume'] });
		expect(st.stopBefore.why).toBeNull();
		expect(st.build.written?.places).toEqual(['A1 track filter']);
		expect(st.build.written?.start).toBe(90);
		f.ok([{ type: 'soundCue.update', cueId: f.cueId, muted: true }]);
		st = cueMixState(f.seq(), cuesOf(f.seq())[0]!);
		expect(st.stopBefore.written).toBeNull();
		expect(st.stopBefore.why).toBe('The cue is muted');
	});

	it('a filled cue with no music under it says so', () => {
		const f = mixFixture();
		f.ok([{ type: 'clip.move', clipIds: [Object.values(f.seq().clips)[0]!.id], deltaFrames: 600 }]);
		f.ok([
			{
				type: 'soundDesign.place',
				cueId: f.cueId,
				layers: [{ mediaId: f.hit, track: 'A2', align: 'start' }],
			},
			{ type: 'soundCue.update', cueId: f.cueId, stopBefore: { seconds: 0.25, depthDb: -24 } },
		]);
		const st = cueMixState(f.seq(), cuesOf(f.seq())[0]!);
		expect(st.stopBefore.written).toBeNull();
		expect(st.stopBefore.why).toBe('No music plays under it');
		expect(st.build).toEqual({ stored: null, written: null, why: null });
	});
});

describe('room view of a clip’s track', () => {
	it('no room → can send; with the glue → its send; a bed track is blocked with why', () => {
		const f = mixFixture();
		f.ok([
			{
				type: 'soundDesign.place',
				cueId: f.cueId,
				layers: [{ mediaId: f.hit, track: 'A2', align: 'start' }],
			},
		]);
		const sfxClip = () => Object.values(f.seq().clips).find((c) => c.trackId === f.seq().audioTracks[1]!.id)!;
		let v = roomViewOf(f.session.getCommitted(), f.seq(), sfxClip())!;
		expect(v).toMatchObject({ glue: null, bus: null, trackLabel: 'A2', send: null, blocked: null });
		f.ok([{ type: 'soundDesign.ensureBus', roomGlue: { sendDb: -12 } }]);
		v = roomViewOf(f.session.getCommitted(), f.seq(), sfxClip())!;
		expect(v.bus?.name).toBe('SFX Room');
		expect(v.send).not.toBeNull();
		expect(v.levelDb).toBe(-12);
		expect(v.blocked).toBeNull();
		// the music clip's track also plays bed audio: no send, and why
		const music = Object.values(f.seq().clips).find((c) => c.trackId === f.seq().audioTracks[0]!.id)!;
		f.ok([{ type: 'essentialSound.setType', clipIds: [music.id], audioType: 'sfx' }]);
		f.ok([
			{ type: 'clip.place', source: { mediaId: f.hit }, at: 400, tracks: { audio: 'A1' }, ref: '$d' },
			{ type: 'essentialSound.setType', clipIds: ['$d'], audioType: 'dialogue' },
		]);
		const onA1 = Object.values(f.seq().clips).find((c) => c.id === music.id)!;
		v = roomViewOf(f.session.getCommitted(), f.seq(), onA1)!;
		expect(v.send).toBeNull();
		expect(v.blocked).toBe(
			'A1 also plays dialogue, music or other bed audio: a send would put them in the room too',
		);
	});
});

describe('validation and numbers', () => {
	it('stop-before and build fields', () => {
		expect(validateStopBefore({ seconds: 0.25, depthDb: -24 })).toEqual([]);
		expect(validateStopBefore({ seconds: 0, depthDb: 0 }).map((e) => e.field)).toEqual([
			'seconds',
			'depthDb',
		]);
		expect(validateStopBefore({ seconds: 11, depthDb: -61 }).map((e) => e.field)).toEqual([
			'seconds',
			'depthDb',
		]);
		expect(validateBuild({ seconds: 2, fromHz: 150, toHz: 2000 })).toEqual([]);
		expect(validateBuild({ seconds: 2, fromHz: 2000, toHz: 150 })).toEqual([
			{ field: 'toHz', message: 'A build rises: To must be above From' },
		]);
		expect(validateBuild({ seconds: Number.NaN, fromHz: 10, toHz: 30_000 }).map((e) => e.field)).toEqual([
			'seconds',
			'fromHz',
			'toHz',
		]);
		expect(parseNumber('0,25')).toBe(0.25);
		expect(parseNumber('−24')).toBe(-24);
		expect(parseNumber('abc')).toBeNull();
		expect(parseNumber(' ')).toBeNull();
	});

	it('delivery labels carry the numbers', () => {
		expect(deliveryOptionLabel(DELIVERY_PRESETS.web)).toBe('Web / streaming · −14 LUFS · −1 dBTP');
		expect(deliveryOptionLabel(DELIVERY_PRESETS['atsc-a85'])).toBe(
			'Broadcast ATSC A/85 · −24 LUFS · −2 dBTP',
		);
	});
});
