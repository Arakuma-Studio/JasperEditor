// JasperEditor document → format → JasperEditor document, through `project.importTimeline`.
import { type CaptionsClip, captionClipText, checkInvariants, defaultRegistries } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { exportTimeline, type Format, importTimeline, planPrerender } from '../src/index.ts';
import { addCaptions, Harness, richProject, summarize } from './support/rich.ts';

function roundTrip(format: Format, opts: { preset?: string } = {}) {
	const { h, ids } = richProject(opts);
	addCaptions(h);
	const out = exportTimeline(h.doc, h.seqId, format);
	const imp = importTimeline(out.files[0]!.bytes, { format, now: '2026-10-07T00:00:00.000Z' });
	const target = new Harness({ preset: opts.preset ?? 'hd-1080p-30', seed: 999 });
	const r = target.ok([{ type: 'project.importTimeline', fragment: imp }]);
	const res = r.results[0] as { topSequenceIds: string[]; binId: string };
	expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
	return { h, ids, out, imp, target, seqId: res.topSequenceIds[0]!, binId: res.binId };
}

const KEEP_ALL = [
	'name',
	'enabled',
	'label',
	'transform',
	'opacity',
	'blendMode',
	'volumeDb',
	'pan',
	'gainDb',
	'effects',
	'markers',
	'content',
	'channels',
];

describe('JasperEditor round trips', () => {
	it('OTIO restores the sequence exactly (text, solids, effects, keyframes, transitions, links, markers)', () => {
		const { h, target, seqId, binId, out } = roundTrip('otio');
		expect(summarize(target.doc, seqId, { keep: KEEP_ALL })).toEqual(
			summarize(h.doc, h.seqId, { keep: KEEP_ALL }),
		);
		const a = target.doc.sequences[seqId]!;
		const b = h.doc.sequences[h.seqId]!;
		expect(a.markers.map(({ id: _, ...m }) => m)).toEqual(b.markers.map(({ id: _, ...m }) => m));
		expect(a.settings).toEqual(b.settings);
		// Captions come back as a caption track with the same text and timing.
		const caps = (s: typeof a) =>
			(Object.values(s.clips) as CaptionsClip[])
				.filter((c) => c.kind === 'captions')
				.map((c) => [
					c.start,
					c.duration,
					captionClipText(s === a ? target.doc : h.doc, c, s.settings.frameRate),
				])
				.sort((x, y) => (x[0] as number) - (y[0] as number));
		expect(caps(a)).toEqual(caps(b));
		expect(caps(a).length).toBe(2);
		// The import landed in its own bin, with the media as items.
		const bin = target.doc.items[binId]!;
		expect(bin.kind).toBe('bin');
		// The text clip is named in the report (other applications see an offline clip).
		expect(out.warnings.some((w) => w.subject?.kind === 'clip' && /text clip/.test(w.message))).toBe(true);
	});

	it('import is one undoable transaction', () => {
		const { target } = roundTrip('otio');
		expect(Object.keys(target.doc.sequences).length).toBe(2);
	});

	it('plans pre-renders per format and mode', () => {
		const { h, ids } = richProject();
		const jobs = planPrerender(h.doc, h.seqId, 'edl', 'unsupported').map((j) => [j.clipId, j.reason]);
		expect(jobs).toContainEqual([ids.text, 'text clip']);
		expect(jobs).toContainEqual([ids.va, 'effects']);
		expect(jobs).toContainEqual([ids.vb, 'blend mode multiply']);
		expect(planPrerender(h.doc, h.seqId, 'fcp7', 'unsupported').map((j) => j.clipId)).not.toContain(ids.vb);
		expect(planPrerender(h.doc, h.seqId, 'edl', 'none')).toEqual([]);
		expect(planPrerender(h.doc, h.seqId, 'fcp7', 'all').length).toBe(5);
		expect(planPrerender(h.doc, h.seqId, 'omf', 'all')).toEqual([]);
	});

	it('substitutes pre-rendered clips and names the rest', () => {
		const { h, ids } = richProject();
		const out = exportTimeline(h.doc, h.seqId, 'otio', {
			prerendered: {
				[ids.text]: {
					path: '/renders/title.mov',
					width: 1920,
					height: 1080,
					rate: { num: 30, den: 1 },
					durationFlicks: 40 * 23520000,
				},
			},
		});
		const text = new TextDecoder().decode(out.files[0]!.bytes);
		expect(text).toContain('file:///renders/title.mov');
		expect(out.warnings.some((w) => w.subject?.id === ids.text)).toBe(false);
	});
});
