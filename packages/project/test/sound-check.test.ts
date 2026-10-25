// Sound Check model (spec 12 §2.6, P5-R1; wp-note "Phase 5 → WP5.1"): `soundDesign.setCheck` (store / clear the summary,
// immutability, refusals), the credits setting, staleness (`soundCheckStatus`: the mix, the cues / loudness settings,
// the preset), the verdict and counts, load and repair.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	createCounterIdSource,
	type LibraryProvenance,
	loadProject,
	makeEnvelope,
	mixFingerprint,
	readSoundCheckAudio,
	readSoundDesign,
	repairDocument,
	soundCheckAudioKey,
	soundCheckCounts,
	soundCheckInputsHash,
	soundCheckStatus,
	soundCheckVerdict,
	soundDesignSettingsOf,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function fixture() {
	const h = new Harness();
	const library: LibraryProvenance = {
		...LIB,
		soundId: 'snd_000000000000c0de',
		title: 'Hit',
		types: ['hit'],
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.5 }), library } },
	]);
	const m = (r.results[0] as { mediaId: string }).mediaId;
	const music = h.registerVideo({ seconds: 10 });
	h.ok([{ type: 'clip.place', source: { mediaId: music }, at: 0 }]);
	const cue = h.ok([
		{ type: 'soundCue.add', cues: [{ frame: 40, kind: 'cut', weight: 'hero', source: 'user', ref: '$c' }] },
		{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m, ref: '$x' }] },
	]);
	return { h, cueId: cue.refs.$c!, clipId: cue.refs.$x!, musicMedia: music };
}

const summary = (h: Harness, over: Record<string, unknown> = {}) => ({
	mixHash: mixFingerprint(h.doc, h.seqId),
	verdict: 'warn',
	counts: { MASKED: 1, warning: 1 },
	at: '2026-10-16T12:00:00.000Z',
	preset: 'web',
	inputsHash: soundCheckInputsHash(h.doc, h.seqId, 'web'),
	jobId: 'job_0123456789',
	...over,
});

describe('soundDesign.setCheck', () => {
	it('stores the summary (current), clears it with null; immutability', () => {
		const { h } = fixture();
		expect(soundCheckStatus(h.doc, h.seqId)).toMatchObject({ state: 'none', summary: null });
		const before = h.doc;
		const snapshot = clone(before);
		const cmd = { type: 'soundDesign.setCheck', summary: summary(h) };
		const r = h.ok([cmd], { label: 'Sound Check Result' });
		expect(r.results[0]).toEqual({ sequenceId: h.seqId, lastCheck: summary(h) });
		expect(checkInvariants(h.doc)).toEqual([]);
		const st = soundCheckStatus(h.doc, h.seqId);
		expect(st).toMatchObject({
			state: 'current',
			reasons: [],
			summary: { verdict: 'warn', jobId: 'job_0123456789' },
		});
		// The previous document stays unchanged.
		expect(before).toEqual(snapshot);
		// a partial range is kept
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h, { range: { start: 0, end: 90 } }) }]);
		expect(soundCheckStatus(h.doc, h.seqId).summary!.range).toEqual({ start: 0, end: 90 });
		// clear
		const c = h.ok([{ type: 'soundDesign.setCheck', summary: null }]);
		expect(c.results[0]).toEqual({ sequenceId: h.seqId, lastCheck: null });
		expect(soundCheckStatus(h.doc, h.seqId).state).toBe('none');
	});

	it('staleness: the mix, the cues and loudness settings, the delivery preset', () => {
		const { h, cueId, clipId } = fixture();
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h) }]);
		const stored = h.doc;
		// a gain change: the mix
		h.ok([{ type: 'audio.setGain', clipIds: [clipId], mode: 'adjust', db: 1 }]);
		expect(soundCheckStatus(h.doc, h.seqId)).toMatchObject({ state: 'stale', reasons: ['mix'] });
		// a cue edit that leaves the mix as it is: the inputs
		h.doc = stored;
		h.ok([{ type: 'soundCue.update', cueId, label: 'boom', moveClips: false }]);
		expect(mixFingerprint(h.doc, h.seqId)).toBe(mixFingerprint(stored, h.seqId));
		expect(soundCheckStatus(h.doc, h.seqId)).toMatchObject({ state: 'stale', reasons: ['inputs'] });
		// the Mix's normalisation target
		h.doc = stored;
		h.ok([{ type: 'mixer.setLoudness', enabled: true, targetLufs: -16 }]);
		expect(soundCheckStatus(h.doc, h.seqId).reasons).toEqual(['inputs']);
		// the sequence's delivery preset
		h.doc = stored;
		h.ok([{ type: 'soundDesign.setSettings', delivery: 'podcast' }]);
		expect(soundCheckStatus(h.doc, h.seqId)).toMatchObject({ state: 'stale', reasons: ['preset'] });
		// the credits setting
		h.doc = stored;
		h.ok([{ type: 'soundDesign.setSettings', credits: 'md' }]);
		expect(soundCheckStatus(h.doc, h.seqId).reasons).toEqual(['inputs']);
		// a summary without an inputs hash is judged by the mix alone
		h.doc = stored;
		const { inputsHash: _i, ...old } = summary(h);
		h.ok([{ type: 'soundDesign.setCheck', summary: old }]);
		h.ok([{ type: 'soundCue.update', cueId, label: 'x', moveClips: false }]);
		expect(soundCheckStatus(h.doc, h.seqId).state).toBe('current');
		// an unknown sequence
		expect(soundCheckStatus(h.doc, 'seq_nope')).toEqual({
			state: 'none',
			summary: null,
			reasons: [],
			mixHash: '',
		});
	});

	it('staleness: the cue density judges DENSITY (stale); markers, verdict markers, agents and seed do not', () => {
		const { h } = fixture();
		h.ok([{ type: 'soundDesign.setSettings', density: 'rich' }]);
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h) }]);
		const stored = h.doc;
		expect(soundCheckStatus(h.doc, h.seqId).state).toBe('current');
		// DENSITY's hero spacing and rate budget come from the density: another density is another check
		for (const density of ['sparse', 'balanced'] as const) {
			h.doc = stored;
			h.ok([{ type: 'soundDesign.setSettings', density }]);
			expect(soundCheckStatus(h.doc, h.seqId), density).toMatchObject({
				state: 'stale',
				reasons: ['inputs'],
			});
		}
		// what no finding depends on keeps the summary current
		h.doc = stored;
		h.ok([
			{ type: 'marker.add', frame: 40, name: 'Sound Check: sounds right', comment: 'ok' },
			{ type: 'marker.add', frame: 80, name: 'Sound Check: flagged', comment: 'too loud' },
			{ type: 'soundDesign.setSettings', agentsMayApply: true, seed: 77 },
		]);
		expect(soundCheckStatus(h.doc, h.seqId)).toMatchObject({ state: 'current', reasons: [] });
		// summaries stored at the default density before the density was hashed stay current
		h.doc = stored;
		h.ok([{ type: 'soundDesign.setSettings', density: 'balanced' }]);
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h) }]);
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web')).toBe(summary(h).inputsHash);
	});

	it('the export encoding checked for: recorded, hashed (absent = the PCM master, old hashes valid), stale against another Check for; immutability', () => {
		const { h } = fixture();
		const aac = { codec: 'aac', bitrateKbps: 256 } as const;
		// absent / the PCM master: the same hash as before the field existed
		const plain = soundCheckInputsHash(h.doc, h.seqId, 'web');
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web', null, undefined, null)).toBe(plain);
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web', null, undefined, { codec: 'pcm' })).toBe(plain);
		const withAac = soundCheckInputsHash(h.doc, h.seqId, 'web', null, undefined, aac);
		expect(withAac).not.toBe(plain);
		expect(
			soundCheckInputsHash(h.doc, h.seqId, 'web', null, undefined, { codec: 'aac', bitrateKbps: 128 }),
		).not.toBe(withAac);
		const before = h.doc;
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h, { inputsHash: withAac, exportAudio: aac }) }]);
		// The previous document stays unchanged.
		expect(
			readSoundDesign((Object.values(before.sequences)[0] as { soundDesign?: unknown }).soundDesign)
				?.lastCheck,
		).toBeUndefined();
		const st = soundCheckStatus(h.doc, h.seqId);
		expect(st.state).toBe('current');
		expect(st.summary!.exportAudio).toEqual(aac);
		// "Check for" the same encoding: current; another one, or the master: stale with reason codec
		expect(soundCheckStatus(h.doc, h.seqId, { checkFor: aac }).state).toBe('current');
		expect(
			soundCheckStatus(h.doc, h.seqId, { checkFor: { codec: 'opus', bitrateKbps: 160 } }).reasons,
		).toEqual(['codec']);
		expect(soundCheckStatus(h.doc, h.seqId, { checkFor: null }).reasons).toEqual(['codec']);
		// a summary without an encoding (older ones, the master) is current for the master and stale for a codec
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h) }]);
		expect(soundCheckStatus(h.doc, h.seqId, { checkFor: null }).state).toBe('current');
		expect(soundCheckStatus(h.doc, h.seqId, { checkFor: aac }).reasons).toEqual(['codec']);
		expect(soundCheckStatus(h.doc, h.seqId).state).toBe('current');
		// it survives a save and load
		const loaded = loadProject(
			clone(makeEnvelope(h.doc, { revision: 3, savedAt: '2026-10-16T12:00:00.000Z', platform: 'test' })),
			{ ids: createCounterIdSource(900) },
		);
		expect(loaded.repairs).toEqual([]);
	});

	it('readSoundCheckAudio and soundCheckAudioKey read untrusted encodings', () => {
		expect(readSoundCheckAudio({ codec: 'aac', bitrateKbps: 256 })).toEqual({
			codec: 'aac',
			bitrateKbps: 256,
		});
		expect(readSoundCheckAudio({ codec: 'opus', bitrateKbps: 160, sampleRate: 44100 })).toEqual({
			codec: 'opus',
			bitrateKbps: 160,
		});
		expect(readSoundCheckAudio({ codec: 'pcm' })).toBeNull();
		expect(readSoundCheckAudio({ codec: 'pcm', sampleRate: 44100 })).toEqual({
			codec: 'pcm',
			sampleRate: 44100,
		});
		for (const bad of [null, 1, 'aac', {}, { codec: 'mp3' }]) expect(soundCheckAudioKey(bad)).toBe('');
		expect(soundCheckAudioKey({ codec: 'aac', bitrateKbps: 99999 })).toBe('aac/default');
		// never throws on anything
		fc.assert(
			fc.property(fc.anything(), (v) => {
				readSoundCheckAudio(v);
				soundCheckAudioKey(v);
			}),
			{ numRuns: 300 },
		);
	});

	it('refusals', () => {
		const { h } = fixture();
		const code = (cmd: Record<string, unknown>) => {
			const r = h.tx([cmd]);
			return r.ok ? 'ok' : r.errors[0]!.code;
		};
		const base = summary(h);
		expect(code({ type: 'soundDesign.setCheck', sequenceId: 'seq_nope', summary: base })).toBe('E_NOT_FOUND');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, verdict: 'great' } })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, at: 'yesterday' } })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, preset: 'loud' } })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, mixHash: '' } })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, extra: 1 } })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, counts: { x: -1 } } })).toBe('E_SCHEMA');
		const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]));
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, counts: many } })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, range: { start: 5, end: 5 } } })).toBe(
			'E_SCHEMA',
		);
		expect(code({ type: 'soundDesign.setCheck' })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: { ...base, exportAudio: { codec: 'mp3' } } })).toBe(
			'E_SCHEMA',
		);
		expect(
			code({
				type: 'soundDesign.setCheck',
				summary: { ...base, exportAudio: { codec: 'aac', bitrateKbps: 8 } },
			}),
		).toBe('E_SCHEMA');
		expect(
			code({
				type: 'soundDesign.setCheck',
				summary: { ...base, exportAudio: { codec: 'aac', sampleRate: 22050 } },
			}),
		).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setSettings', credits: 'pdf' })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.setCheck', summary: base })).toBe('ok');
	});

	it('the credits setting: set, cleared with null, read-time default absent', () => {
		const { h } = fixture();
		expect(soundDesignSettingsOf(h.seq).credits).toBeUndefined();
		h.ok([{ type: 'soundDesign.setSettings', credits: 'txt' }]);
		expect(soundDesignSettingsOf(h.seq).credits).toBe('txt');
		h.ok([{ type: 'soundDesign.setSettings', credits: null }]);
		expect(soundDesignSettingsOf(h.seq).credits).toBeNull();
	});

	it('the summary and credits survive load; damaged ones are dropped by repair (idempotent)', () => {
		const { h } = fixture();
		h.ok([{ type: 'soundDesign.setSettings', credits: 'md' }]);
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h, { range: { start: 0, end: 30 } }) }]);
		const env = makeEnvelope(h.doc, { revision: 1, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' });
		const loaded = loadProject(JSON.parse(JSON.stringify(env))).document;
		const seq = loaded.sequences[h.seqId]!;
		expect(soundCheckStatus(loaded, h.seqId).state).toBe('current');
		expect(soundDesignSettingsOf(seq).credits).toBe('md');
		// damaged: a summary whose preset is unknown, credits of another format
		const bad = clone(h.doc);
		const sd = (bad.sequences[h.seqId] as { soundDesign: Record<string, Record<string, unknown>> })
			.soundDesign;
		sd.lastCheck!.preset = 'loud';
		sd.settings!.credits = 'pdf';
		expect(readSoundDesign(sd)!.lastCheck).toBeUndefined();
		expect(readSoundDesign(sd)!.settings!.credits).toBeUndefined();
		const once = repairDocument(bad, createCounterIdSource(77)).document;
		const twice = repairDocument(once, createCounterIdSource(78)).document;
		expect(twice).toEqual(once);
		expect(soundCheckStatus(once, h.seqId).state).toBe('none');
		expect(checkInvariants(once)).toEqual([]);
	});
});

describe('Sound Check verdict and counts', () => {
	it('verdict: fail with an error, warn with a warning, info never fails', () => {
		expect(soundCheckVerdict([])).toBe('pass');
		expect(soundCheckVerdict([{ severity: 'info' }])).toBe('pass');
		expect(soundCheckVerdict([{ severity: 'info' }, { severity: 'warning' }])).toBe('warn');
		expect(soundCheckVerdict([{ severity: 'warning' }, { severity: 'error' }])).toBe('fail');
		expect(
			soundCheckCounts([
				{ code: 'MASKED', severity: 'warning' },
				{ code: 'MASKED', severity: 'warning' },
				{ code: 'TRUE_PEAK', severity: 'error' },
			]),
		).toEqual({ MASKED: 2, warning: 2, TRUE_PEAK: 1, error: 1 });
	});
});
