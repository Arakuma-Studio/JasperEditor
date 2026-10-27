// ShareAlike model contracts (spec 12 §4 P6-E13): obligations, the Commercial-safe filter's
// explicit opt-in, exported credits and W_SHARE_ALIKE. Hostile licence strings never throw.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	isCommercialSafe,
	isShareAlike,
	type LICENSE_FILTERS,
	type LibraryProvenance,
	licenseObligations,
	passesCommercialSafeFilter,
	type RankableSound,
	rankSounds,
	SOUND_FILTER_LICENSE,
	shareAlikeNotice,
	soundCredits,
	soundFilterOf,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const lib = (over: Partial<LibraryProvenance>): LibraryProvenance => ({ ...LIB, ...over });

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
		expect(passesCommercialSafeFilter('CC-BY-SA-4.0')).toBe(false);
		expect(passesCommercialSafeFilter('CC-BY-SA-4.0', true)).toBe(true);
		expect(passesCommercialSafeFilter('CC-BY-4.0')).toBe(true);
		expect(passesCommercialSafeFilter('CC0-1.0')).toBe(true);
		expect(passesCommercialSafeFilter('CC-BY-NC-4.0', true)).toBe(false);
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
		expect(notice).toContain('Muted Riser');
		expect(notice).toContain('CC BY-SA');
		expect(c.text.split('\n').at(-1)).toBe(notice);
		expect(c.markdown).toContain('CC BY-SA');
		expect(c.warnings.filter((w) => w.code === 'W_SHARE_ALIKE').map((w) => w.mediaId)).toEqual([sa]);
		// without a ShareAlike sound: no notice
		expect(shareAlikeNotice(c.rows.filter((r) => !r.shareAlike))).toBeNull();
		const only = soundCredits(h.doc, h.seqId, { attributionOnly: true });
		expect(only.text).toContain('ShareAlike:');
	});
});
