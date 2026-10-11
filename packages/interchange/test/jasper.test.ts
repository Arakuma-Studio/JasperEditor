import { type CaptionsClip, captionClipText, checkInvariants, defaultRegistries } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { budgetMs, budgetReport } from '../../../scripts/perf/budget.ts';
import { exportTimeline, type Format, importTimeline, planPrerender } from '../src/index.ts';
import { addCaptions, Harness, richProject, summarize } from './support/rich.ts';

function roundTrip(format: Format, opts: { preset?: string } = {}) {
	const { h, ids } = richProject(opts);
	addCaptions(h);
	const out = exportTimeline(h.doc, h.seqId, format);
	const imp = importTimeline(out.files[0]!.bytes, {
		format,
		now: '2026-10-07T00:00:00.000Z',
		rate: { num: 30, den: 1 },
	});
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
	it('a 3,000-clip ALE bin imports in linear time (< 2 s)', () => {
		const rows = Array.from(
			{ length: 3000 },
			(_, i) => `Clip_${i}\tVA1A2\t01:00:00:00\t01:00:10:00\tR${i % 50}\t/Volumes/Shoot/Clip_${i}.mov`,
		);
		const ale = [
			'Heading',
			'FIELD_DELIM\tTABS',
			'VIDEO_FORMAT\t1080',
			'FPS\t25',
			'',
			'Column',
			'Name\tTracks\tStart\tEnd\tTape\tSource File',
			'',
			'Data',
			...rows,
		].join('\n');
		const imp = importTimeline(new TextEncoder().encode(ale), {
			format: 'ale',
			now: '2026-10-07T00:00:00.000Z',
			rate: { num: 25, den: 1 },
		});
		const target = new Harness({ preset: 'hd-1080p-25', seed: 7 });
		const t0 = performance.now();
		target.ok([{ type: 'project.importTimeline', fragment: imp }]);
		const ms = performance.now() - t0;
		console.info(budgetReport('ALE import, 3,000 clips', ms, 2000));
		expect(Object.keys(target.doc.media)).toHaveLength(3000);
		expect(ms).toBeLessThan(budgetMs(2000));
	});

	it('OTIO re-imported into its own project: restored clips get fresh child ids (animated title, masks, effects)', () => {
		const { h } = richProject();
		const t = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V3', content: { text: 'Title' }, ref: '$t' },
		]).refs.$t!;
		h.ok([{ type: 'textAnimator.applyPreset', clipIds: [t], preset: 'fade-in' }]);
		const out = exportTimeline(h.doc, h.seqId, 'otio');
		const imp = importTimeline(out.files[0]!.bytes, {
			format: 'otio',
			now: '2026-10-07T00:00:00.000Z',
			rate: { num: 30, den: 1 },
		});
		const r = h.ok([{ type: 'project.importTimeline', fragment: imp }]);
		expect(checkInvariants(h.doc, { effects: defaultRegistries().effects })).toEqual([]);
		const seqId = (r.results[0] as { topSequenceIds: string[] }).topSequenceIds[0]!;
		const titles = Object.values(h.doc.sequences[seqId]!.clips).filter(
			(c) => c.kind === 'text' && c.animators?.length,
		);
		expect(titles).toHaveLength(1);
	});

	it('OTIO restores the sequence exactly (text, solids, effects, keyframes, transitions, links, markers)', () => {
		const { h, target, seqId, binId, out } = roundTrip('otio');
		expect(summarize(target.doc, seqId, { keep: KEEP_ALL })).toEqual(
			summarize(h.doc, h.seqId, { keep: KEEP_ALL }),
		);
		const a = target.doc.sequences[seqId]!;
		const b = h.doc.sequences[h.seqId]!;
		expect(a.markers.map(({ id: _, ...m }) => m)).toEqual(b.markers.map(({ id: _, ...m }) => m));
		expect(a.settings).toEqual(b.settings);
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
		const bin = target.doc.items[binId]!;
		expect(bin.kind).toBe('bin');
		// The text clip is named in the report (other applications see an offline clip).
		expect(out.warnings.some((w) => w.subject?.kind === 'clip' && /text clip/.test(w.message))).toBe(true);
	});

	/** The media-backed and solid clips of a summary (what every format can carry), with `keep` fields. */
	const carried = (
		doc: Parameters<typeof summarize>[0],
		seqId: string,
		keep: string[],
		tracks?: string[],
	) => {
		const s = summarize(doc, seqId, { keep }) as {
			video: Record<string, unknown>[][];
			audio: Record<string, unknown>[][];
			transitions: unknown[];
			links: string[];
		};
		const media = (list: Record<string, unknown>[][], tag: string) =>
			list
				.map(
					(t, i) =>
						[
							`${tag}${i + 1}`,
							t.filter((c) => c.kind === 'video' || c.kind === 'audio' || c.kind === 'solid'),
						] as const,
				)
				.filter(([name, t]) => t.length && (!tracks || tracks.includes(name)));
		return { tracks: norm([...media(s.video, 'V'), ...media(s.audio, 'A')]), transitions: s.transitions };
	};
	/**
	 * What no format besides OTIO keeps and what is equivalent: spatial tangents of position keyframes, the static
	 * value of a keyframed parameter, the width scale of a uniform scale.
	 */
	const norm = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(norm);
		if (!v || typeof v !== 'object') return v;
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			if (k === 'spatial') continue;
			if (
				k === 'value' &&
				Array.isArray((v as { keyframes?: unknown[] }).keyframes) &&
				(v as { keyframes: unknown[] }).keyframes.length
			)
				continue;
			if (k === 'scaleWidth' && (v as { uniformScale?: boolean }).uniformScale) continue;
			o[k] = norm(x);
		}
		return o;
	};

	/** V3 holds the text clip, which other applications see as an offline clip. */
	const MEDIA_TRACKS = ['V1', 'V2', 'A1', 'A2'];
	for (const [format, keep, tracks] of [
		['fcp7', ['transform', 'opacity', 'blendMode', 'volumeDb', 'pan', 'effects', 'enabled'], MEDIA_TRACKS],
		['fcpxml', ['transform', 'opacity', 'blendMode', 'volumeDb', 'pan', 'effects', 'enabled'], MEDIA_TRACKS],
		['aaf', ['volumeDb'], MEDIA_TRACKS],
	] as const)
		it(`${format} keeps the timing and ${keep.join(', ')} of the media clips`, () => {
			const { h, target, seqId, out } = roundTrip(format);
			const got = carried(target.doc, seqId, [...keep], [...tracks]);
			const want = carried(h.doc, h.seqId, [...keep], [...tracks]);
			// FCPXML has no solids (they are pre-rendered); AAF has no speed changes (pre-rendered, else named).
			const fix = (x: typeof want) =>
				(x.tracks as [string, Record<string, unknown>[]][]).map(([n, t]) => [
					n,
					t
						.filter(
							(c) =>
								!(format === 'fcpxml' && c.kind === 'solid') && !(format === 'aaf' && c.kind === 'solid'),
						)
						.map((c) => (format === 'aaf' ? { ...c, speed: 1 } : c)),
				]);
			expect(fix(got)).toEqual(fix(want));
			if (format !== 'aaf') expect(got.transitions).toEqual(want.transitions);
			expect(out.warnings.some((w) => /text clip/.test(w.message))).toBe(true);
			if (format === 'aaf') expect(out.warnings.some((w) => /speed|synthetic/.test(w.message))).toBe(true);
		});

	it('edl keeps what each record frame shows (a centred dissolve starts at its edit)', () => {
		const { h, target, seqId } = roundTrip('edl');
		const F = 23_520_000;
		const align = (doc: typeof h.doc, id: string) =>
			(
				carried(doc, id, [], ['V1']).tracks as [
					string,
					{ media: string; start: number; sourceIn: number }[],
				][]
			)[0]![1].map((c) => [c.media, c.start - c.sourceIn / F]);
		expect(align(target.doc, seqId)).toEqual(align(h.doc, h.seqId));
		const t = Object.values(target.doc.sequences[seqId]!.transitions);
		expect(t.map((x) => [x.effectId, x.duration])).toEqual([['jasper.cross-dissolve', 10]]);
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
