import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderSnapshot,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPreviews, usableAudioSpans } from '../src/index.ts';

function makeDoc(): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'C', preset: 'hd-1080p-25' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 50, track: 'V1', color: [0, 0.5, 1, 1] },
				{ type: 'clip.addSolid', at: 50, duration: 50, track: 'V1', color: [1, 0, 0, 1] },
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

describe('applyPreviews', () => {
	it('unmounts only the live clips whose whole span is covered', () => {
		const doc = makeDoc();
		const a = applyPreviews(doc, { video: [{ start: 0, frames: 50, url: '/p/a.mp4' }], audio: [] });
		expect(a.doc.videoTracks[0]!.clips.map((c) => c.start)).toEqual([50]);
		expect(a.video).toHaveLength(1);
		const b = applyPreviews(doc, { video: [{ start: 0, frames: 30, url: '/p/a.mp4' }], audio: [] });
		expect(b.doc.videoTracks[0]!.clips.map((c) => c.start)).toEqual([0, 50]);
		const c = applyPreviews(doc, {
			video: [
				{ start: 0, frames: 50, url: '/p/a.mp4' },
				{ start: 50, frames: 50, url: '/p/b.mp4' },
			],
			audio: [],
		});
		expect(c.doc.videoTracks[0]!.clips).toEqual([]);
	});

	it('audio previews never play over a live clip (no double audio)', () => {
		const clips = [
			{ start: 0, duration: 40 },
			{ start: 40, duration: 40 },
		];
		// the second clip continues past the rendered span: the span keeps only the first clip's frames
		expect(usableAudioSpans(clips, [{ start: 0, frames: 60 }])).toEqual([{ start: 0, end: 40 }]);
		// a crossfade handle reaching into the span makes that part live as well
		expect(
			usableAudioSpans(
				[
					{ start: 0, duration: 40, tailHandle: 10 },
					{ start: 40, duration: 40, headHandle: 10 },
				],
				[{ start: 0, frames: 40 }],
			),
		).toEqual([]);
		// Each clip stays live when its own handle extends beyond the rendered audio.
		expect(
			usableAudioSpans(
				[
					{ start: 0, duration: 40, tailHandle: 10 },
					{ start: 80, duration: 40, headHandle: 10 },
				],
				[
					{ start: 0, frames: 40 },
					{ start: 80, frames: 40 },
				],
			),
		).toEqual([]);
	});

	it('property: no live audio clip overlaps a usable span, and usable ⊆ the rendered spans', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({ start: fc.integer({ min: 0, max: 200 }), duration: fc.integer({ min: 1, max: 80 }) }),
					{
						maxLength: 8,
					},
				),
				fc.array(
					fc.record({ start: fc.integer({ min: 0, max: 200 }), frames: fc.integer({ min: 1, max: 120 }) }),
					{
						maxLength: 5,
					},
				),
				(clips, spans) => {
					const usable = usableAudioSpans(clips, spans);
					for (const u of usable) {
						for (let f = u.start; f < u.end; f++)
							expect(spans.some((s) => f >= s.start && f < s.start + s.frames)).toBe(true);
						for (const c of clips) {
							const inside = c.start >= u.start && c.start + c.duration <= u.end;
							const apart = c.start + c.duration <= u.start || c.start >= u.end;
							expect(inside || apart).toBe(true);
						}
					}
				},
			),
			{ numRuns: 200 },
		);
	});
});
