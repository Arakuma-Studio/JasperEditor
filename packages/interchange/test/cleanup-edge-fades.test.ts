// Spec 14 TC-024: the sub-frame edge micro-fades of cleanup joins have no equivalent in interchange formats; every
// exporter names them in its report instead of dropping them silently (AGENTS §4).
import { describe, expect, it } from 'vitest';
import { videoAsset } from '../../project/test/helpers.ts';
import { exportTimeline, type Format } from '../src/index.ts';
import { Harness, withPath } from './support/rich.ts';

function cleanedUp(): Harness {
	const h = new Harness({ preset: 'hd-1080p-30' });
	const r = h.ok([
		{ type: 'media.register', asset: withPath(videoAsset({ kind: 'audio', seconds: 20 }), '/media/voz.wav') },
	]);
	const m = (r.results[0] as { mediaId: string }).mediaId;
	h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
	h.ok([
		{ type: 'cleanup.apply', clipIds: [h.clips('A1')[0]!.id], ranges: [{ start: 60, end: 90 }], fadeMs: 4 },
	]);
	return h;
}

describe('edge micro-fades in interchange exports', () => {
	for (const format of ['fcp7', 'fcpxml', 'otio', 'edl', 'aaf', 'omf'] as Format[])
		it(`${format} names them in its report`, () => {
			const h = cleanedUp();
			const out = exportTimeline(h.doc, h.seqId, format);
			const named = out.warnings.filter((w) => /edge micro-fade/.test(w.message));
			expect(named).toHaveLength(2);
			expect(named.every((w) => w.subject?.kind === 'clip')).toBe(true);
		});
});
