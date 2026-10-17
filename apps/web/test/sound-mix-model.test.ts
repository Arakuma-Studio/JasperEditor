// WP4.2b mix model (pure): level views (default / solver / manual with translated reasons and track names), the review
// row's gain text, the room seen from a clip's track (sends, interface-only and bed tracks), a cue's stop-before / build
// written vs stored (and why), the field validation, the delivery labels; fuzzed inputs never throw.
import type { AudioClip, ClipSfx, Sequence } from '@jasper/project';
import { DELIVERY_PRESETS } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cuesOf } from '../src/sound/cues/model.ts';
import { planNotes, rebalanceNotes } from '../src/sound/mix-jobs.ts';
import {
	conflictNote,
	cueMixState,
	cueSelectionOf,
	deliveryOptionLabel,
	fmtDb,
	levelSelectionOf,
	limitPhrase,
	parseNumber,
	reviewGainText,
	roomLevelCommands,
	roomSelectionOf,
	roomToggleEdit,
	roomViewOf,
	sfxLevelView,
	solverReason,
	soundNotes,
	validateBuild,
	validateStopBefore,
	warningNote,
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
		// a lift over silence is not quoted (a sound after the music ends: "+86.7 dB" in the Phase 4 real run)
		expect(solverReason({ limitedBy: [], targetLiftDb: 3.5, achievedLiftDb: 86.7 })).toBe(
			'nothing plays under it in the bed: default level kept',
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
		// the record is kept suspended (writes: []): not written
		expect(
			(f.seq().soundDesign?.mix?.cues?.[f.cueId]?.stopBefore as { suspended?: boolean } | undefined)
				?.suspended,
		).toBe(true);
		expect(st.stopBefore.written).toBeNull();
		expect(st.stopBefore.why).toBe('The cue is muted');
		expect(st.build.written).toBeNull();
		// unmuted: written again where it was
		f.ok([{ type: 'soundCue.update', cueId: f.cueId, muted: false }]);
		st = cueMixState(f.seq(), cuesOf(f.seq())[0]!);
		expect(st.stopBefore.written).toEqual({ start: 135, end: 150, places: ['A1 track volume'] });
		expect(st.build.written?.places).toEqual(['A1 track filter']);
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

/** Music on A1, a hero cue at 150 filled on A2, a support cue at 240 filled on A3. */
function twoTrackFixture() {
	const f = mixFixture();
	f.ok([{ type: 'soundCue.add', cues: [{ frame: 240, kind: 'cut', weight: 'support', source: 'user' }] }]);
	const [c1, c2] = cuesOf(f.seq()).map((c) => c.id) as [string, string];
	f.ok([
		{ type: 'soundDesign.place', cueId: c1, layers: [{ mediaId: f.hit, track: 'A2', align: 'start' }] },
		{ type: 'soundDesign.place', cueId: c2, layers: [{ mediaId: f.hit, track: 'A3', align: 'start' }] },
	]);
	const on = (i: number) =>
		Object.values(f.seq().clips).find((c) => c.trackId === f.seq().audioTracks[i]!.id)! as AudioClip;
	const doc = () => f.session.getCommitted();
	const run = (edit: { label: string; commands: unknown[] } | null) => {
		if (!edit) throw new Error('no edit');
		f.ok(edit.commands);
	};
	return { ...f, c1, c2, on, doc, run };
}

describe('Room for a multi-selection (sends are per track)', () => {
	it('names every track, is mixed while the sends differ, acts on every track that can send; bed tracks are skipped', () => {
		const f = twoTrackFixture();
		const music = f.on(0);
		const pick = () => [f.on(1), f.on(2), music];
		let sel = roomSelectionOf(f.doc(), f.seq(), pick())!;
		expect(sel.tracks.map((v) => v.trackLabel)).toEqual(['A1', 'A2', 'A3']);
		expect(sel.targets.map((v) => v.trackLabel)).toEqual(['A2', 'A3']);
		expect(sel.blocked.map((v) => v.blocked)).toEqual([
			'A1 also plays dialogue, music or other bed audio: a send would put them in the room too',
		]);
		expect(sel.label).toBe('A2, A3');
		expect(sel.state).toBe(false);
		// on without a room: the glue (it sends from both)
		const create = roomToggleEdit(f.seq(), sel, true)!;
		expect(create.label).toBe('SFX Room Glue');
		expect(create.commands.map((c) => c.type)).toEqual(['soundDesign.ensureBus']);
		f.run(create);
		sel = roomSelectionOf(f.doc(), f.seq(), pick())!;
		expect(sel.state).toBe(true);
		expect(sel.levelDb).toBe(-16);
		expect(sel.blocked).toHaveLength(1);
		// one muted send: mixed; on unmutes only that one
		const a3 = sel.on[1]!;
		f.ok([
			{
				type: 'mixer.updateSend',
				sequenceId: f.seqId,
				stripId: a3.trackId,
				sendId: a3.send!.id,
				patch: { mute: true },
			},
		]);
		sel = roomSelectionOf(f.doc(), f.seq(), pick())!;
		expect(sel.state).toBe('mixed');
		const unmute = roomToggleEdit(f.seq(), sel, true)!;
		expect(unmute.label).toBe('Room Send On');
		expect(unmute.commands).toEqual([
			expect.objectContaining({ type: 'mixer.updateSend', stripId: a3.trackId, patch: { mute: false } }),
		]);
		f.run(unmute);
		// different levels: mixed level; the slider sets both (one transaction)
		f.ok([
			{
				type: 'mixer.updateSend',
				sequenceId: f.seqId,
				stripId: a3.trackId,
				sendId: a3.send!.id,
				patch: { levelDb: -10 },
			},
		]);
		sel = roomSelectionOf(f.doc(), f.seq(), pick())!;
		expect(sel.state).toBe(true);
		expect(sel.levels).toEqual([-16, -10]);
		expect(sel.levelDb).toBeNull();
		const level = roomLevelCommands(f.seq(), sel, -12);
		expect(level.map((c) => (c as { stripId: string }).stripId)).toEqual(sel.on.map((v) => v.trackId));
		f.ok(level);
		sel = roomSelectionOf(f.doc(), f.seq(), pick())!;
		expect(sel.levelDb).toBe(-12);
		// off mutes both, never the bed track
		const off = roomToggleEdit(f.seq(), sel, false)!;
		expect(off.label).toBe('Room Send Off');
		expect(off.commands.map((c) => (c as { stripId: string }).stripId)).toEqual([
			sel.targets[0]!.trackId,
			sel.targets[1]!.trackId,
		]);
		f.run(off);
		sel = roomSelectionOf(f.doc(), f.seq(), pick())!;
		expect(sel.state).toBe(false);
		expect(roomToggleEdit(f.seq(), sel, false)).toBeNull();
		expect(roomLevelCommands(f.seq(), sel, -3)).toEqual([]);
		// only the bed track: nothing to act on, the label names it
		const bed = roomSelectionOf(f.doc(), f.seq(), [music])!;
		expect(bed.targets).toEqual([]);
		expect(bed.label).toBe('A1');
		expect(roomToggleEdit(f.seq(), bed, true)).toBeNull();
	});

	it('with a room bus, a target without a send gets one at the glue level', () => {
		const f = twoTrackFixture();
		f.ok([{ type: 'soundDesign.ensureBus', roomGlue: { sendDb: -14 } }]);
		const a3 = f.seq().audioTracks[2]!;
		f.ok([
			{ type: 'mixer.removeSend', sequenceId: f.seqId, stripId: a3.id, sendId: a3.mixer!.sends![0]!.id },
		]);
		const sel = roomSelectionOf(f.doc(), f.seq(), [f.on(1), f.on(2)])!;
		expect(sel.state).toBe('mixed');
		const edit = roomToggleEdit(f.seq(), sel, true)!;
		expect(edit.label).toBe('Room Send On');
		expect(edit.commands).toEqual([
			expect.objectContaining({ type: 'mixer.addSend', stripId: a3.id, target: sel.bus!.id, levelDb: -14 }),
		]);
		f.run(edit);
		expect(roomSelectionOf(f.doc(), f.seq(), [f.on(1), f.on(2)])!.state).toBe(true);
	});
});

describe('Stop / Build for a multi-selection (the cue the sounds fill)', () => {
	it('one cue → it; different cues → mixed with the reason and the state over the cues; no cue → none', () => {
		const f = twoTrackFixture();
		expect(cueSelectionOf(f.seq(), [f.on(1)])).toEqual({ kind: 'one', cue: cuesOf(f.seq())[0] });
		f.ok([{ type: 'soundCue.update', cueId: f.c1, stopBefore: { seconds: 0.25, depthDb: -24 } }]);
		const mixed = cueSelectionOf(f.seq(), [f.on(1), f.on(2)]);
		expect(mixed.kind).toBe('mixed');
		if (mixed.kind !== 'mixed') return;
		expect(mixed.cues.map((c) => c.id)).toEqual([f.c1, f.c2]);
		expect(mixed.reason).toBe(
			'The selected sounds fill 2 different cues (00:00:05:00, 00:00:08:00): select the sounds of one cue to edit its stop-before and build',
		);
		expect(mixed.state).toEqual({ stopBefore: 'mixed', build: false });
		// a sound of the cue plus a sound of no cue
		f.ok([
			{ type: 'soundDesign.place', frame: 400, layers: [{ mediaId: f.hit, track: 'A4', align: 'start' }] },
		]);
		const loose = Object.values(f.seq().clips).find((c) => c.start >= 390) as AudioClip;
		const part = cueSelectionOf(f.seq(), [f.on(1), loose]);
		expect(part.kind === 'mixed' && part.reason).toBe(
			'1 of the selected sounds fill no cue: select only the sounds of the cue at 00:00:05:00 to edit its stop-before and build',
		);
		expect(part.kind === 'mixed' && part.state.stopBefore).toBe(true);
		expect(cueSelectionOf(f.seq(), [loose])).toEqual({ kind: 'none' });
		expect(cueSelectionOf(f.seq(), [])).toEqual({ kind: 'none' });
	});

	it('two layers of one cue on two tracks act on that cue', () => {
		const f = mixFixture();
		f.ok([
			{
				type: 'soundDesign.place',
				cueId: f.cueId,
				layers: [
					{ mediaId: f.hit, track: 'A2', align: 'start' },
					{ mediaId: f.hit, track: 'A3', align: 'start' },
				],
			},
		]);
		const layers = Object.values(f.seq().clips).filter((c) => c.start >= 140) as AudioClip[];
		expect(layers).toHaveLength(2);
		const sel = cueSelectionOf(f.seq(), layers);
		expect(sel.kind).toBe('one');
	});
});

describe('Auto gain level line for a multi-selection', () => {
	it('the common text, else the range of gains; the badge is Mixed when owners differ', () => {
		const solver = (g: number) =>
			clip(g, { by: 'solver', gainDb: g, targetLiftDb: 5, achievedLiftDb: 5, limitedBy: [] });
		expect(levelSelectionOf([solver(-6), solver(-6)])).toMatchObject({
			badge: 'Solver',
			owner: 'solver',
			text: '−6.0 dB · target lift +5.0 dB reached',
			lift: { achievedDb: 5, targetDb: 5 },
		});
		const two = levelSelectionOf([solver(-6), clip(-3)])!;
		expect(two.badge).toBe('Mixed');
		expect(two.owner).toBe('mixed');
		expect(two.text).toBe('−6.0 to −3.0 dB across 2 sounds');
		expect(two.lift).toBeNull();
		expect(levelSelectionOf([])).toBeNull();
	});
});

describe('solver notes in words', () => {
	const where = (id: string | undefined) => (id === 'clp_1' ? 'Click at 00:00:04:10' : null);

	it('conflicts say which rule won over which, named by the sound', () => {
		expect(
			conflictNote({ clipId: 'clp_1', kept: 'consistency', lost: 'dialogue' }, 'Click at 00:00:04:10').text,
		).toBe('Click at 00:00:04:10: its repeats (±2 dB) kept over dialogue');
		expect(conflictNote({ clipId: 'x', kept: 'headroom', lost: 'consistency' }, null).text).toBe(
			'A sound: headroom kept over its repeats (±2 dB)',
		);
	});

	it('warnings: translated advice, W_UNRESOLVED first, unknown codes keep the English, garbage ignored', () => {
		const notes = soundNotes(
			{
				conflicts: [
					{ clipId: 'clp_1', kept: 'consistency', lost: 'dialogue', message: 'x' },
					{ clipId: 5, kept: 'a' },
				],
				warnings: [
					{
						code: 'W_DIALOGUE_BAND',
						clipId: 'clp_1',
						message:
							'clp_1: during speech its dominant band (2000 Hz) is in 1–4 kHz; prefer a type whose dominant band is outside 1–4 kHz (here: boom, rumble)',
					},
					{ code: 'W_CONFLICT', clipId: 'clp_1', message: 'clp_1: dialogue could not hold' },
					{ code: 'W_SANITISED', clipId: 'clp_1', message: 'clp_1: gain was NaN' },
					{
						code: 'W_UNRESOLVED',
						clipId: 'clp_2',
						message: 'clp_2: headroom does not hold after the last step',
					},
					null,
					'nope',
				],
			},
			where,
		);
		expect(notes.map((n) => n.text)).toEqual([
			'A sound: headroom does not hold after the solve and no conflict explains it; check its level by ear and report it',
			'Click at 00:00:04:10: its energy is in the speech band (1–4 kHz) while someone speaks; move it or pick a sound whose energy is outside 1–4 kHz, e.g. boom, rumble',
			'Click at 00:00:04:10: its repeats (±2 dB) kept over dialogue',
			'Click at 00:00:04:10: gain was NaN',
		]);
		expect(notes.map((n) => n.severity)).toEqual(['warning', 'warning', 'info', 'info']);
		// without the "(here: …)" list the advice names boom
		expect(
			warningNote(
				{ code: 'W_DIALOGUE_BAND', message: 'x: during speech its dominant band is in 1–4 kHz' },
				null,
			).text,
		).toContain('e.g. boom');
		expect(
			warningNote(
				{
					code: 'W_MUSIC_OVER_VOICE',
					message:
						// the engine's format (levels.ts fmtDb: a sign, a real minus)
						'The music is +5.2 LU under the voice during speech (target ≥ 8 LU): turn Ducking on for it or lower it',
				},
				null,
			).text,
		).toBe(
			'The music is only 5.2 LU under the voice during speech (target at least 8 LU): turn Ducking on for it or lower it',
		);
		expect(
			warningNote(
				{ code: 'W_AMBIENCE_OVER_VOICE', message: 'The ambience is −1 LU under the voice during speech' },
				null,
			).text,
		).toContain('only −1.0 LU under');
	});

	it('reports name the sounds: rebalance by its events, plans by their items', () => {
		const rb = rebalanceNotes({
			report: {
				events: [{ clipId: 'clp_9', title: 'Click', timecode: '00:00:04:10' }],
				conflicts: [{ clipId: 'clp_9', kept: 'consistency', lost: 'dialogue', message: '' }],
				warnings: [],
			},
		} as never);
		expect(rb.map((n) => n.text)).toEqual(['Click at 00:00:04:10: its repeats (±2 dB) kept over dialogue']);
		const plan = planNotes({
			events: [{ itemId: 'place:001', timecode: '00:00:08:10', sound: { title: 'Boom' } }],
			conflicts: [{ clipId: 'sim', itemId: 'place:001', kept: 'headroom', lost: 'bed-cap', message: '' }],
			warnings: [{ code: 'W_LIBRARY_EMPTY', message: 'No sound…' }],
		} as never);
		expect(plan.map((n) => n.text)).toEqual([
			'No sound of the allowed sources is indexed: install the starter kit or rescan the sound library',
			'Boom at 00:00:08:10: headroom kept over the bed level',
		]);
		// a plan's solver warning names its item at the start of its message ("sfx:004: …"): the note names the sound
		const named = planNotes({
			events: [{ itemId: 'sfx:004', timecode: '00:00:06:00', sound: { title: 'Pneumatic whoosh' } }],
			conflicts: [],
			warnings: [
				{
					code: 'W_DIALOGUE_BAND',
					message:
						'sfx:004: during speech its dominant band (4000 Hz) is in 1–4 kHz; prefer a type whose dominant band is outside 1–4 kHz (here: boom)',
				},
			],
		} as never);
		expect(named[0]!.text).toMatch(/^Pneumatic whoosh at 00:00:06:00: /);
	});

	it('never throws on hostile reports', () => {
		fc.assert(
			fc.property(fc.anything(), (report) => {
				const notes = soundNotes(report, () => {
					throw new Error('boom');
				});
				expect(Array.isArray(notes)).toBe(true);
			}),
			{ numRuns: 300 },
		);
		const big = soundNotes(
			{ warnings: Array.from({ length: 5000 }, (_, i) => ({ code: 'W_X', message: `m${i}` })) },
			() => null,
		);
		expect(big.length).toBe(200);
	});
});
