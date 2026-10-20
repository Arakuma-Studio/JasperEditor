// Sound Check Phase 6 model (spec 12 §4 P6-E1…E3, P6-E13; wp-note "Phase 6 → WP-E1"): the new codes have categories
// and filled templates; ShareAlike obligations, the Commercial-safe filter's single switch, the credits notice and the
// W_SHARE_ALIKE warning. Hostile licence strings never throw.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	COMMERCIAL_SAFE_FILTER_KEEPS_SHARE_ALIKE,
	isCommercialSafe,
	isShareAlike,
	LICENSE_FILTERS,
	type LibraryProvenance,
	licenseObligations,
	passesCommercialSafeFilter,
	type RankableSound,
	rankSounds,
	SOUND_CHECK_CATEGORIES,
	SOUND_CHECK_CATEGORY,
	SOUND_CHECK_CODES,
	SOUND_CHECK_EDGE_THRESHOLDS,
	SOUND_CHECK_MESSAGES,
	SOUND_CHECK_MODEL_STRINGS,
	SOUND_FILTER_LICENSE,
	SYNC_END_WINDOW_MS,
	shareAlikeNotice,
	soundCheckMessage,
	soundCredits,
	soundFilterOf,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const lib = (over: Partial<LibraryProvenance>): LibraryProvenance => ({ ...LIB, ...over });

describe('Phase 6 Sound Check codes', () => {
	it('every code has a category; the new ones are in the edges, tonal, mix, cues and loudness groups', () => {
		for (const c of SOUND_CHECK_CODES) expect(SOUND_CHECK_CATEGORIES).toContain(SOUND_CHECK_CATEGORY[c]);
		expect(Object.keys(SOUND_CHECK_CATEGORY).sort()).toEqual([...SOUND_CHECK_CODES].sort());
		expect({
			CLICK: SOUND_CHECK_CATEGORY.CLICK,
			EDGE: SOUND_CHECK_CATEGORY.EDGE,
			ENDING: SOUND_CHECK_CATEGORY.ENDING,
			HEAD: SOUND_CHECK_CATEGORY.HEAD,
			HARSH: SOUND_CHECK_CATEGORY.HARSH,
			LAYER_INAUDIBLE: SOUND_CHECK_CATEGORY.LAYER_INAUDIBLE,
			COVERAGE: SOUND_CHECK_CATEGORY.COVERAGE,
			ARC: SOUND_CHECK_CATEGORY.ARC,
		}).toEqual({
			CLICK: 'edges',
			EDGE: 'edges',
			ENDING: 'edges',
			HEAD: 'edges',
			HARSH: 'tonal',
			LAYER_INAUDIBLE: 'mix',
			COVERAGE: 'cues',
			ARC: 'loudness',
		});
	});

	it('the thresholds are the spec numbers (earshot norms)', () => {
		expect(SOUND_CHECK_EDGE_THRESHOLDS).toMatchObject({
			clickEdgeMs: 2,
			entryPreDb: -20,
			entryFadeMs: 5,
			entryAttackMs: 10,
			decayTailDb: -35,
			decayPostDb: -35,
			decayFadeMs: 30,
			musicSustainDb: 6,
			musicOverNextDb: 6,
			musicCrossfadeMs: 100,
			harshOverDb: 6,
			brightCentroidHz: 6500,
			layerAddDb: 1,
			layerTargetAddDb: 3,
			layerWindowMs: 60,
			endRmsDbfs: -45,
			endPeakDbfs: -60,
			endFadeSec: 0.5,
			headPeakDbfs: -40,
			arcWindowSec: 3,
			arcLateShare: 0.15,
		});
		expect(SOUND_CHECK_EDGE_THRESHOLDS.harshBandHz).toEqual([2000, 6000]);
		expect(SYNC_END_WINDOW_MS).toEqual({ early: 250, late: 30 });
	});

	it('the new templates fill and are model strings', () => {
		for (const k of [
			'clickStart',
			'clickEnd',
			'clickJoint',
			'clickTransition',
			'clickBody',
			'clickMix',
			'edgeEntry',
			'edgeDecay',
			'edgeMusic',
			'harshMusic',
			'harshDialogue',
			'bright',
			'layerInaudible',
			'coverage',
			'ending',
			'head',
			'arcNoHero',
			'arcLate',
			'syncEndEarly',
			'syncEndLate',
			'licenseShareAlike',
			'fixFadeIn',
			'fixFadeOut',
			'fixLengthenTransition',
			'fixCrossfade',
			'fixExtendDecay',
			'fixHarshGain',
			'fixHarshEq',
			'fixLayerGain',
			'fixRemoveLayer',
			'fixFillCoverage',
			'fixMuteCoverage',
			'fixEndingFade',
			'fixHeadFade',
		] as const) {
			const t = SOUND_CHECK_MESSAGES[k];
			expect(SOUND_CHECK_MODEL_STRINGS).toContain(t);
			const n = new Set([...t.matchAll(/\{(\d+)\}/g)].map((x) => x[1])).size;
			expect(soundCheckMessage(k, ...Array.from({ length: n }, (_, i) => `p${i}`)).text).not.toMatch(
				/\{\d+\}/,
			);
		}
		expect(soundCheckMessage('coverage', 3, 4, 'appear', 1, '00:00:02:03').text).toBe(
			'3 of 4 appear cues like these have a sound; 1 do not: 00:00:02:03',
		);
	});
});

describe('ShareAlike (P6-E13)', () => {
	it('obligations: attribution and ShareAlike by licence', () => {
		expect(licenseObligations('CC-BY-SA-4.0')).toEqual({ attribution: true, shareAlike: true });
		expect(licenseObligations('CC-BY-SA-3.0-AT')).toEqual({ attribution: true, shareAlike: true });
		expect(licenseObligations('CC-BY-NC-SA-4.0')).toEqual({ attribution: true, shareAlike: true });
		expect(licenseObligations('CC-BY-4.0')).toEqual({ attribution: true, shareAlike: false });
		expect(licenseObligations('CC0-1.0')).toEqual({ attribution: false, shareAlike: false });
		expect(licenseObligations('MIT')).toEqual({ attribution: true, shareAlike: false });
		expect(licenseObligations('LicenseRef-UserProvided')).toEqual({ attribution: false, shareAlike: false });
		expect(isShareAlike('cc-by-sa-4.0')).toBe(true);
		expect(isShareAlike('CC-BY-ND-4.0')).toBe(false);
		// BY-SA stays on the allowlist (never a LICENSE error)
		expect(isCommercialSafe('CC-BY-SA-4.0')).toBe(true);
		fc.assert(
			fc.property(fc.anything(), (v) => {
				const o = licenseObligations(v);
				expect(typeof o.attribution).toBe('boolean');
				expect(typeof o.shareAlike).toBe('boolean');
				expect(typeof passesCommercialSafeFilter(v)).toBe('boolean');
			}),
			{ numRuns: 500 },
		);
	});

	it('the Commercial-safe filter has ONE switch: CC BY-SA excluded by default (human decision), included on request', () => {
		expect(COMMERCIAL_SAFE_FILTER_KEEPS_SHARE_ALIKE).toBe(false);
		expect(passesCommercialSafeFilter('CC-BY-SA-4.0')).toBe(false);
		expect(passesCommercialSafeFilter('CC-BY-SA-4.0', true)).toBe(true);
		expect(passesCommercialSafeFilter('CC-BY-4.0')).toBe(true);
		expect(passesCommercialSafeFilter('CC0-1.0')).toBe(true);
		expect(passesCommercialSafeFilter('CC-BY-NC-4.0', true)).toBe(false);
		expect(LICENSE_FILTERS).toEqual(['commercial-safe', 'commercial-safe-sa', 'any']);
		// the ranking: commercial-safe (the default) leaves BY-SA out; "Include ShareAlike" lists it under BY; any adds NC
		const snd = (id: string, license: string): RankableSound => ({
			id,
			title: `whoosh ${id}`,
			tags: [],
			types: ['whoosh'],
			source: { type: 'starter' },
			license,
			judge: { ok: true, score: 1 },
			descriptors: {
				durationSec: 1,
				peakSec: 0.2,
				riseMs: 10,
				centroidHz: 1500,
				below150Share: 0.1,
				above6kShare: 0.1,
				flatness: 0.2,
				octaveBandsDb: [-20, -18, -16, -15, -17, -20, -26],
			},
		});
		const list = [snd('snd_sa', 'CC-BY-SA-4.0'), snd('snd_by', 'CC-BY-4.0'), snd('snd_nc', 'CC-BY-NC-4.0')];
		const ids = (license?: (typeof LICENSE_FILTERS)[number]) =>
			rankSounds(list, { query: 'whoosh', ...(license ? { license } : {}) }).map((r) => r.entry.id);
		expect(ids()).toEqual(['snd_by']);
		expect(ids('commercial-safe')).toEqual(['snd_by']);
		expect(ids('commercial-safe-sa')).toEqual(['snd_by', 'snd_sa']);
		expect(ids('any').sort()).toEqual(['snd_by', 'snd_nc', 'snd_sa']);
		// the facet bits follow the same filter
		const bits = soundFilterOf({ query: 'whoosh' });
		expect(bits(list[0]!) & SOUND_FILTER_LICENSE).toBe(0);
		expect(
			soundFilterOf({ query: 'whoosh', license: 'commercial-safe-sa' })(list[0]!) & SOUND_FILTER_LICENSE,
		).toBe(SOUND_FILTER_LICENSE);
	});

	it('credits: the SA flag per row, the ShareAlike notice in text and Markdown, a W_SHARE_ALIKE warning', () => {
		const h = new Harness();
		const sa = h.registerVideo({ kind: 'audio', seconds: 1 });
		const by = h.registerVideo({ kind: 'audio', seconds: 1 });
		h.ok([
			{
				type: 'media.setLibraryInfo',
				mediaId: sa,
				library: lib({ soundId: 'snd_sa', title: 'Muted Riser', license: 'CC-BY-SA-4.0', author: 'Cy' }),
			},
			{
				type: 'media.setLibraryInfo',
				mediaId: by,
				library: lib({ soundId: 'snd_by', title: 'Whoosh', license: 'CC-BY-4.0', author: 'Ana' }),
			},
			{ type: 'clip.place', source: { mediaId: sa }, at: 0, tracks: { audio: 'A1' } },
			{ type: 'clip.place', source: { mediaId: by }, at: 40, tracks: { audio: 'A1' } },
		]);
		const c = soundCredits(h.doc, h.seqId);
		expect(c.rows.map((r) => [r.soundId, r.shareAlike])).toEqual([
			['snd_sa', true],
			['snd_by', false],
		]);
		const notice = shareAlikeNotice(c.rows)!;
		expect(notice).toMatch(
			/^ShareAlike: "Muted Riser" is licensed CC BY-SA\. Under CC BY-SA 4\.0 §1\(a\) and §3\(b\)/,
		);
		expect(c.text.split('\n').at(-1)).toBe(notice);
		expect(c.markdown).toContain('ShareAlike: "Muted Riser" is licensed CC BY-SA');
		// the CSV keeps its columns (the licence column says CC-BY-SA-4.0)
		expect(c.csv.trimEnd().split('\r\n')).toHaveLength(3);
		expect(c.warnings.filter((w) => w.code === 'W_SHARE_ALIKE').map((w) => w.mediaId)).toEqual([sa]);
		// without a ShareAlike sound: no notice
		expect(shareAlikeNotice(c.rows.filter((r) => !r.shareAlike))).toBeNull();
		const only = soundCredits(h.doc, h.seqId, { attributionOnly: true });
		expect(only.text).toContain('ShareAlike:');
	});
});
