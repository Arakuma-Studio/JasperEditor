// Reference sound profiles (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): the aggregate (median, p10–p90, min–max, n),
// the judged window (the references' min–max widened by the tolerance, one-sided rows, the density floor), the rows'
// statuses and weights, leave-one-out by identity and by measurements, the advice with timecodes, the file schema
// (round trip; hostile files refused with a reason; a tampered aggregate recomputed), and the sequence's selection
// (`soundDesign.setSettings {referenceProfile}`: undo / redo, refusals, lenient read and repair).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	aggregateReferences,
	buildReferenceProfile,
	checkInvariants,
	compareWithProfile,
	createCounterIdSource,
	metricStats,
	metricValuesOf,
	REFERENCE_CHANCE_KEYS,
	REFERENCE_METRIC_KEYS,
	REFERENCE_METRICS,
	REFERENCE_MODEL_STRINGS,
	REFERENCE_PROFILE_LIMITS,
	type ReferenceEntry,
	type ReferenceMeasurement,
	type ReferenceMetricValues,
	readReferenceProfile,
	readSoundDesignSettings,
	referenceAdvice,
	referenceEntryOf,
	referenceProfileIdOf,
	referenceRowMessage,
	referenceSeverity,
	referenceWindow,
	repairDocument,
	SOUND_CHECK_CATEGORY,
	SOUND_MODEL_STRINGS,
	soundCheckInputsHash,
	soundDesignSettingsOf,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A "film" measurement with the given metric values (the rest of a plausible mix). */
function film(over: Partial<ReferenceMetricValues> = {}, durationSec = 30): ReferenceMeasurement {
	const base: Partial<ReferenceMetricValues> = {
		lufs_i: -16,
		true_peak: -1.2,
		lra: 5,
		crest_lu: 3,
		intro_lu: -1,
		end_lu: 0,
		peak_pos: 0.7,
		first_sound_s: 0,
		max_gap_s: 0,
		end_silence_s: 0.1,
		fade_s: 0.4,
		final_lu: 1,
		tail_s: 1.2,
		onset_rate: 2,
		hit_rate: 0.5,
		stopdowns_min: 1,
		cut_rate: 0.5,
		cuts_with_sound: 0.8,
		cut_frame_sync: 0.4,
		band_sub: -12,
		band_low: -5,
		band_lowmid: -6,
		band_mid: -8,
		band_presence: -14,
		band_air: -20,
		brightness_hz: 2500,
		side_to_mid_db: -9,
		correlation: 0.6,
		speech_frac: 0,
	};
	return {
		durationSec,
		hasPicture: true,
		fps: 30,
		mono: false,
		metrics: metricValuesOf({ ...base, ...over }),
		chance: { cuts_with_sound: 0.3, cut_frame_sync: 0.1 },
		arc: Array.from({ length: 11 }, (_, i) => (i === 7 ? 2 : -0.5)),
	};
}

function profileOf(films: ReferenceMeasurement[], kinds?: ('media' | 'sequence')[]) {
	const refs = films.map((m, i) =>
		referenceEntryOf(i, m, {
			title: `Film ${i + 1}`,
			kind: kinds?.[i] ?? 'media',
			fingerprint: kinds?.[i] === 'sequence' ? `prj_a/seq_${i}@abc` : `fp${i}`,
		}),
	);
	return buildReferenceProfile({
		id: referenceProfileIdOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
		name: 'My channel',
		createdAt: '2026-10-18T10:00:00.000Z',
		references: refs,
	});
}

const three = () =>
	profileOf([
		film({ band_air: -20, onset_rate: 1.5, lra: 4 }, 30),
		film({ band_air: -19, onset_rate: 2, lra: 5 }, 40),
		film({ band_air: -21, onset_rate: 2.5, lra: 6 }, 50),
	]);

describe('aggregate and window', () => {
	it('stats are NumPy-style percentiles of the non-null values', () => {
		expect(metricStats([1, 2, 3, 4, null, Number.NaN])).toEqual({
			n: 4,
			median: 2.5,
			p10: 1.3,
			p90: 3.7,
			min: 1,
			max: 4,
		});
		expect(metricStats([])).toMatchObject({ n: 0, median: null });
		const p = three();
		expect(p.n).toBe(3);
		expect(p.metrics.band_air).toMatchObject({ n: 3, median: -20, min: -21, max: -19 });
		expect(p.metrics.onset_rate).toMatchObject({ median: 2, p10: 1.6, p90: 2.4 });
		expect(p.arc!.median[7]).toBe(2);
		expect(p.chance.cuts_with_sound).toMatchObject({ n: 3, median: 0.3 });
	});

	it('the window is min–max widened by the tolerance; one-sided rows; the density floor; no data', () => {
		const p = three();
		expect(referenceWindow('band_air', p.metrics.band_air)).toEqual({
			lo: -22.5,
			hi: -17.5,
			basis: 'references',
		});
		// lower-only (cuts with sound), upper-only (first sound, gaps, dead air)
		expect(referenceWindow('cuts_with_sound', p.metrics.cuts_with_sound)).toEqual({
			lo: 0.75,
			hi: null,
			basis: 'references',
		});
		expect(referenceWindow('first_sound_s', p.metrics.first_sound_s).lo).toBeNull();
		expect(referenceWindow('end_silence_s', p.metrics.end_silence_s).hi).toBe(0.35);
		// a density whose window would reach 0 keeps half the sparsest reference
		const sparse = metricStats([0.2, 0.3]);
		expect(referenceWindow('onset_rate', sparse).lo).toBe(0.1);
		expect(referenceWindow('onset_rate', metricStats([])).basis).toBe('no reference data');
		// loudness is the delivery preset's
		expect(referenceWindow('lufs_i', p.metrics.lufs_i).basis).toBe('delivery');
	});
});

describe('comparison', () => {
	it('a matching piece passes every scored row; a seeded mismatch is flagged by the right rows', () => {
		const p = three();
		const ok = compareWithProfile(film({}, 35), p);
		expect(ok.rows).toHaveLength(REFERENCE_METRIC_KEYS.length);
		expect(ok.counts.low + ok.counts.high).toBe(0);
		expect(ok.rows.filter((r) => r.status !== 'ok' && r.status !== 'n.a.')).toEqual([]);
		expect(ok.leaveOneOut).toBeNull();
		// air −6 dB, 2 s of dead air, sound on 1 of 6 cuts
		const bad = compareWithProfile(film({ band_air: -26, end_silence_s: 2, cuts_with_sound: 1 / 6 }, 35), p);
		const flagged = bad.rows.filter((r) => r.status === 'low' || r.status === 'high');
		expect(flagged.map((r) => [r.metric, r.status])).toEqual([
			['end_silence_s', 'high'],
			['cuts_with_sound', 'low'],
			['band_air', 'low'],
		]);
		const sev = Object.fromEntries(flagged.map((r) => [r.metric, referenceSeverity(r)]));
		expect(sev).toEqual({ end_silence_s: 'warning', cuts_with_sound: 'warning', band_air: 'info' });
		const air = flagged.find((r) => r.metric === 'band_air')!;
		expect(referenceRowMessage(air).text).toBe(
			'Air 8–16 kHz share is low: −26.0 dB, the references −22.5 dB … −17.5 dB (median −20.0 dB)',
		);
		const cuts = flagged.find((r) => r.metric === 'cuts_with_sound')!;
		expect(cuts.chance).toBe(0.3);
		expect(cuts.refChance).toBe(0.3);
		expect(referenceRowMessage(cuts).text).toBe(
			'Picture events with an onset within 100 ms is low: 17 %, the references at least 75 % (median 80 %)',
		);
		// advice with timecodes
		const adv = referenceAdvice(cuts, {
			pictureEvents: 6,
			withoutOnset: 5,
			silentCuts: ['00:00:02:00', '00:00:04:00', '00:00:06:00', '00:00:08:00', '00:00:10:00'],
		});
		expect(adv[0]!.text).toBe(
			'5 of 6 picture events have no onset within 100 ms (chance 30 %); no sound at all at 00:00:02:00, 00:00:04:00, 00:00:06:00, 00:00:08:00, 00:00:10:00: add a whoosh into the cut, a hit or a click there.',
		);
		const dead = flagged.find((r) => r.metric === 'end_silence_s')!;
		expect(referenceAdvice(dead, { soundEndsAt: '00:00:33:00' })[0]!.text).toMatch(
			/^2\.0 s of dead air after the sound ends at 00:00:33:00/,
		);
		expect(referenceAdvice(air, {})[0]!.text).toMatch(/^No air/);
		// info rows never become findings, ok rows have no advice
		const info = bad.rows.find((r) => r.metric === 'brightness_hz')!;
		expect(info.weight).toBe('info');
		expect(referenceSeverity({ ...info, status: 'high' })).toBeNull();
		expect(referenceAdvice(ok.rows[0]!, {})).toEqual([]);
	});

	it('a reference checked against its own profile is scored leave-one-out (by measurements, by identity)', () => {
		const a = film({ band_air: -14 }, 30);
		const films = [a, film({ band_air: -20 }, 40), film({ band_air: -21 }, 50), film({ band_air: -19 }, 60)];
		const p = profileOf(films);
		// against all four, its own −14 sets the top of the window: in range
		const all = compareWithProfile(film({ band_air: -14 }, 31), p);
		expect(all.rows.find((r) => r.metric === 'band_air')!.status).toBe('ok');
		const loo = compareWithProfile(a, p);
		expect(loo.leaveOneOut).toEqual({ referenceId: 'ref_1', title: 'Film 1', by: 'measurements' });
		expect(loo.scoredAgainst).toBe(3);
		expect(loo.rows.find((r) => r.metric === 'band_air')).toMatchObject({
			status: 'high',
			range: [-22.5, -17.5],
		});
		// a sequence reference of this very sequence, by identity (even after an edit changed its numbers)
		const q = profileOf(films, ['sequence', 'media', 'media', 'media']);
		const byId = compareWithProfile(film({ band_air: -15, lufs_i: -10 }, 33), q, { identity: 'prj_a/seq_0' });
		expect(byId.leaveOneOut).toMatchObject({ referenceId: 'ref_1', by: 'identity' });
		// fewer than two others: judged against all, no leave-one-out
		const two = profileOf([a, film({}, 40)]);
		expect(compareWithProfile(a, two).leaveOneOut).toBeNull();
	});

	it('n.a. without a value or without reference data; short pieces leave the shape rows out', () => {
		const p = three();
		const m = film({}, 35);
		m.metrics.cuts_with_sound = null;
		const r = compareWithProfile(m, p);
		expect(r.rows.find((x) => x.metric === 'cuts_with_sound')!.status).toBe('n.a.');
		const noPic = profileOf([film({ cut_rate: null, cuts_with_sound: null, cut_frame_sync: null })]);
		expect(compareWithProfile(film(), noPic).rows.find((x) => x.metric === 'cut_rate')).toMatchObject({
			status: 'n.a.',
			basis: 'no reference data',
		});
	});
});

describe('profile files', () => {
	it('round-trips through JSON; the aggregate is recomputed from the references', () => {
		const p = three();
		const back = readReferenceProfile(JSON.parse(JSON.stringify(p)));
		expect(back).toEqual({ ok: true, profile: p });
		const tampered = clone(p) as unknown as { metrics: { band_air: { min: number } } };
		tampered.metrics.band_air.min = -99;
		const t = readReferenceProfile(tampered);
		expect(t.ok && t.profile.metrics.band_air.min).toBe(-21);
		// only the references are needed
		const { n: _n, metrics: _m, chance: _c, arc: _a, ...bare } = clone(p);
		expect(readReferenceProfile(bare)).toEqual({ ok: true, profile: p });
	});

	it('hostile files are refused with a reason (never thrown)', () => {
		const p = clone(three()) as unknown as Record<string, unknown>;
		const bad = (mut: (x: Record<string, unknown>) => void) => {
			const x = clone(p);
			mut(x);
			const r = readReferenceProfile(x);
			return r.ok ? 'ok' : r.error;
		};
		expect(readReferenceProfile(null)).toMatchObject({ ok: false });
		expect(readReferenceProfile('{"format":1}')).toMatchObject({ ok: false });
		expect(bad((x) => (x.format = 'earshot'))).toMatch(/^format/);
		expect(bad((x) => (x.version = 2))).toMatch(/^version/);
		expect(bad((x) => (x.metricsVersion = 9))).toMatch(/^metricsVersion/);
		expect(bad((x) => (x.id = '../../etc/passwd'))).toMatch(/^id/);
		expect(bad((x) => (x.name = ''))).toMatch(/^name/);
		expect(bad((x) => (x.name = 'x'.repeat(500)))).toMatch(/^name/);
		expect(bad((x) => (x.references = []))).toMatch(/^references/);
		expect(
			bad((x) => (x.references = Array.from({ length: 21 }, () => (x.references as unknown[])[0]))),
		).toMatch(/^references/);
		expect(bad((x) => ((x.references as Record<string, unknown>[])[1]!.id = 'ref_1'))).toMatch(
			/duplicate id/,
		);
		expect(bad((x) => ((x.references as Record<string, unknown>[])[0]!.audio = 'UklGRg=='))).toMatch(
			/^references\.0/,
		);
		expect(
			bad(
				(x) =>
					(((x.references as Record<string, unknown>[])[0]!.metrics as Record<string, unknown>).band_air =
						'loud'),
			),
		).toMatch(/band_air/);
		expect(
			bad(
				(x) =>
					(((x.references as Record<string, unknown>[])[0]!.metrics as Record<string, unknown>).evil = 1),
			),
		).toMatch(/metrics/);
		expect(
			bad(
				(x) =>
					(((x.references as Record<string, unknown>[])[0]!.metrics as Record<string, unknown>).lra = 1e300),
			),
		).toMatch(/lra/);
		expect(bad((x) => ((x.references as Record<string, unknown>[])[0]!.arc = [1, 2]))).toMatch(/arc/);
		expect(bad((x) => (x.extra = { path: '/home/me/film.mp4' }))).toMatch(/Unrecognized key/);
		const proto = JSON.parse(JSON.stringify(p).replace('"format"', '"__proto__":{"polluted":1},"format"'));
		expect(readReferenceProfile(proto).ok).toBe(false);
		expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
	});

	it('fuzz: never throws; whatever it accepts is a valid profile', () => {
		const p = three();
		fc.assert(
			fc.property(
				fc.jsonValue(),
				fc.jsonValue(),
				fc.constantFrom(...REFERENCE_METRIC_KEYS),
				(junk, v, key) => {
					expect(() => readReferenceProfile(junk)).not.toThrow();
					const x = clone(p) as unknown as { references: { metrics: Record<string, unknown> }[] };
					x.references[0]!.metrics[key] = v;
					const r = readReferenceProfile(x);
					if (r.ok)
						for (const k of REFERENCE_METRIC_KEYS) {
							const s = r.profile.metrics[k];
							expect(s.n).toBeLessThanOrEqual(3);
							if (s.median !== null) expect(Number.isFinite(s.median)).toBe(true);
						}
					return true;
				},
			),
			{ numRuns: 300 },
		);
	});

	it('every label, why text and template is a model string; REFERENCE is the reference category', () => {
		for (const k of REFERENCE_METRIC_KEYS) {
			expect(SOUND_MODEL_STRINGS).toContain(REFERENCE_METRICS[k].label);
			expect(SOUND_MODEL_STRINGS).toContain(REFERENCE_METRICS[k].why);
		}
		for (const s of REFERENCE_MODEL_STRINGS) expect(SOUND_MODEL_STRINGS).toContain(s);
		expect(SOUND_CHECK_CATEGORY.REFERENCE).toBe('reference');
		expect(REFERENCE_CHANCE_KEYS.every((k) => REFERENCE_METRIC_KEYS.includes(k))).toBe(true);
		expect(REFERENCE_PROFILE_LIMITS.references).toBe(20);
		expect(aggregateReferences([]).n).toBe(0);
	});
});

describe('soundDesign.setSettings {referenceProfile}', () => {
	const ID = 'sprf_0102030405060708';
	it('selects and clears the profile; undo / redo; the inputs hash follows it', () => {
		const h = new Harness();
		const before = h.doc;
		const hash0 = soundCheckInputsHash(h.doc, h.seqId, 'web');
		h.ok([{ type: 'soundDesign.setSettings', referenceProfile: ID }]);
		expect(soundDesignSettingsOf(h.seq).referenceProfile).toBe(ID);
		expect(checkInvariants(h.doc)).toEqual([]);
		const hash1 = soundCheckInputsHash(h.doc, h.seqId, 'web');
		expect(hash1).not.toBe(hash0);
		// the profile a check used (explicit) against the sequence's
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web', null, null)).toBe(hash0);
		expect(soundCheckInputsHash(before, h.seqId, 'web', null, ID)).toBe(hash1);
		const selected = h.doc;
		// undo = the document before; redo = the same
		h.doc = before;
		expect(soundDesignSettingsOf(h.seq).referenceProfile).toBeUndefined();
		h.ok([{ type: 'soundDesign.setSettings', referenceProfile: ID }]);
		expect(clone(h.doc.sequences)).toEqual(clone(selected.sequences));
		h.ok([{ type: 'soundDesign.setSettings', referenceProfile: null }]);
		expect(soundDesignSettingsOf(h.seq).referenceProfile).toBeUndefined();
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web')).toBe(hash0);
	});

	it('refuses a malformed id; a stored malformed id is dropped on read and by repair', () => {
		const h = new Harness();
		for (const bad of ['sprf_xyz', '../x', 42, 'sprf_0102030405060708x'])
			expect(h.tx([{ type: 'soundDesign.setSettings', referenceProfile: bad }]).ok).toBe(false);
		const r = h.tx([{ type: 'soundDesign.setSettings', referenceProfile: 'nope' }]);
		expect(!r.ok && r.errors[0]!.code).toBe('E_SCHEMA');
		expect(
			readSoundDesignSettings({ delivery: 'web', referenceProfile: 'nope' }).referenceProfile,
		).toBeUndefined();
		expect(readSoundDesignSettings({ delivery: 'web', referenceProfile: ID }).referenceProfile).toBe(ID);
		h.ok([{ type: 'soundDesign.setSettings', density: 'rich' }]);
		const doc = clone(h.doc);
		const seq = Object.values(doc.sequences)[0] as unknown as {
			soundDesign: { settings: Record<string, unknown> };
		};
		seq.soundDesign.settings.referenceProfile = { evil: true };
		const fixed = repairDocument(doc as never, createCounterIdSource(9));
		const s = soundDesignSettingsOf(Object.values(fixed.document.sequences)[0]!);
		expect(s.referenceProfile).toBeUndefined();
		expect(s.density).toBe('rich');
		expect(checkInvariants(fixed.document)).toEqual([]);
	});
});

// keep the type import used
export type { ReferenceEntry };
