// social-comment@1 (design 2026-10-25 §7.6): definition, the shared schedule (entrances, extras, exit), the text units
// of the word reveal, the like tick count and the closed-form eases. The real anime.js timelines are compared with the
// schedule frame by frame in @jasper/motion `test/mg-cue-timing.test.ts`.
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	ANIME_CATALOG,
	animeTemplateTiming,
	easeFunction,
	mgRegistry,
	REMOTE_IMAGE_IDS,
	SOCIAL_ENTRANCES,
	SOCIAL_EXIT_SCALE,
	SOCIAL_REVEAL_MAX_SPAN_MS,
	SOCIAL_VARIANT_FONTS,
	SOCIAL_WORD_STAGGER_MS,
	type SocialScheduleInput,
	socialCardScale,
	socialComment,
	socialCommentPresets,
	socialCommentSchedule,
	socialCommentSegments,
	socialCommentUnavailableVariant,
	socialLikesTick,
	socialTickCount,
	stripMarks,
	TEMPLATE_EASE_FUNCTIONS,
	trackValueAt,
} from '../src/index.ts';

const timingAt = (seconds: number, fps = 30) => {
	const t = animeTemplateTiming(socialComment, {
		fps,
		localFrame: 0,
		durationFrames: Math.round(seconds * fps),
	});
	return { totalMs: t.totalMs, introMs: t.introMs, outroMs: t.outroMs };
};
const input = (o: Partial<SocialScheduleInput> = {}): SocialScheduleInput => ({
	...timingAt(5),
	entrance: 'soft-spring',
	units: 0,
	tick: false,
	...o,
});
const value = (s: ReturnType<typeof socialCommentSchedule>, target: number, prop: string, ms: number) => {
	const tr = s.tracks.find((t) => t.target === target && t.prop === prop);
	return tr ? trackValueAt(tr, ms) : null;
};

describe('social-comment@1 definition', () => {
	it('is a registered anime template in "Social comments" with an implementation key and defaults that parse', () => {
		expect(ANIME_CATALOG).toContain(socialComment);
		const info = mgRegistry.get('social-comment', 1)!;
		expect(info).toMatchObject({ renderer: 'anime', category: 'Social comments', defaultDurationSeconds: 5 });
		expect(info.motionSpeed).toBeTypeOf('function');
		expect(socialComment.renderVersion).toBe(1);
		expect(socialComment.paramsSchema.safeParse(socialComment.defaults).success).toBe(true);
		expect(socialComment.canvases.map((c) => `${c.width}x${c.height}`)).toEqual([
			'1920x1080',
			'1080x1920',
			'1080x1080',
		]);
		// the declared intro holds the longest entrance (550 ms), the outro is the 200 ms exit
		expect((socialComment.introFrames * 1000) / 30).toBeGreaterThanOrEqual(550);
		expect((socialComment.outroFrames * 1000) / 30).toBe(200);
	});

	it('zooms the card to 60–75 % of the width on 9:16 and keeps it proportional on the other canvases', () => {
		expect((420 * socialCardScale({ width: 1080, height: 1920 })) / 1080).toBeGreaterThanOrEqual(0.6);
		expect((420 * socialCardScale({ width: 1080, height: 1920 })) / 1080).toBeLessThanOrEqual(0.75);
		expect(socialCardScale({ width: 1080, height: 1080 })).toBeLessThan(1.8);
		expect(socialCardScale({ width: 1920, height: 1080 })).toBeLessThan(1.8);
	});
});

describe('social-comment@1 schedule', () => {
	it('every entrance starts hidden, lands at rest when it ends (hold state) and exits to 82 % and transparent', () => {
		for (const entrance of SOCIAL_ENTRANCES) {
			const t = timingAt(5);
			const s = socialCommentSchedule(input({ entrance }));
			expect(value(s, 0, 'o', 0), entrance).toBe(0);
			expect(s.entranceEnd, entrance).toBeLessThanOrEqual(t.introMs);
			for (const ms of [s.entranceEnd, (s.entranceEnd + s.exitStart) / 2, s.exitStart]) {
				expect(value(s, 0, 's', ms) ?? 1, `${entrance} s @${ms}`).toBe(1);
				expect(value(s, 0, 'o', ms) ?? 1).toBe(1);
				expect(value(s, 0, 'y', ms) ?? 0).toBe(0);
				expect(value(s, 0, 'r', ms) ?? 0).toBe(0);
			}
			expect(s.exitStart).toBeCloseTo(t.totalMs - t.outroMs, 9);
			expect(value(s, 0, 's', t.totalMs)).toBe(SOCIAL_EXIT_SCALE);
			expect(value(s, 0, 'o', t.totalMs)).toBe(0);
		}
	});

	it('entrance shapes: pop overshoots to 130 %, spring bounces a little, drop falls 60 px, grow tilts from −8°', () => {
		const peak = (entrance: (typeof SOCIAL_ENTRANCES)[number], prop: string) => {
			const s = socialCommentSchedule(input({ entrance }));
			let hi = Number.NEGATIVE_INFINITY;
			let lo = Number.POSITIVE_INFINITY;
			for (let ms = 0; ms <= s.entranceEnd; ms += 1) {
				const v = value(s, 0, prop, ms)!;
				hi = Math.max(hi, v);
				lo = Math.min(lo, v);
			}
			return { hi, lo };
		};
		expect(peak('classic-pop', 's').hi).toBeCloseTo(1.3, 6);
		expect(peak('soft-spring', 's')).toMatchObject({ lo: 0.6 });
		expect(peak('soft-spring', 's').hi).toBeGreaterThan(1.02);
		expect(peak('soft-spring', 's').hi).toBeLessThan(1.05);
		expect(peak('drop-bounce', 'y').lo).toBe(-60);
		// one bounce: the card goes back up by at most 14 % of the fall
		const drop = socialCommentSchedule(input({ entrance: 'drop-bounce' }));
		let landed = false;
		let bounceTop = 0;
		for (let ms = 0; ms <= drop.entranceEnd; ms++) {
			const y = value(drop, 0, 'y', ms)!;
			if (y > -0.5) landed = true;
			if (landed) bounceTop = Math.min(bounceTop, y);
		}
		expect(bounceTop).toBeLessThan(-6);
		expect(bounceTop).toBeGreaterThanOrEqual(-60 * 0.14 - 1e-9);
		expect(peak('grow-from-tail', 'r').lo).toBe(-8);
		expect(peak('grow-from-tail', 's').hi).toBeGreaterThan(1.05);
	});

	it('word reveal: one word every 90 ms after the entrance, at most 2.4 s for long comments', () => {
		const s = socialCommentSchedule(input({ units: 8 }));
		const starts = s.tracks.filter((t) => t.target > 0 && t.prop === 's').map((t) => t.tweens[0]!.start);
		expect(starts).toHaveLength(8);
		expect(starts[0]).toBeCloseTo(s.entranceEnd, 9);
		for (let i = 1; i < 8; i++) expect(starts[i]! - starts[i - 1]!).toBeCloseTo(SOCIAL_WORD_STAGGER_MS, 9);
		// hidden before its turn, shown at rest
		expect(value(s, 8, 'o', starts[7]! - 1)).toBe(0);
		expect(value(s, 8, 's', s.exitStart)).toBe(1);
		const long = socialCommentSchedule(input({ ...timingAt(10), units: 300 }));
		const ls = long.tracks.filter((t) => t.target > 0 && t.prop === 's').map((t) => t.tweens[0]!.start);
		expect(ls[ls.length - 1]! - ls[0]!).toBeCloseTo(SOCIAL_REVEAL_MAX_SPAN_MS, 6);
	});

	it('like tick: 900 ms count from the entrance end, then the heart thumps and fills (hold: filled, count final)', () => {
		const s = socialCommentSchedule(input({ tick: true }));
		expect(s.tick).toMatchObject({ start: s.entranceEnd, dur: 900, ease: 'outCubic' });
		const heart = s.heartTarget!;
		expect(heart).toBe(1);
		expect(value(s, heart, 'f', s.entranceEnd + 899)).toBe(0);
		expect(value(s, heart, 'f', s.exitStart)).toBe(1);
		expect(value(s, heart, 's', s.exitStart)).toBe(1);
		let top = 0;
		for (let ms = s.entranceEnd + 900; ms < s.entranceEnd + 1200; ms++)
			top = Math.max(top, value(s, heart, 's', ms)!);
		expect(top).toBeCloseTo(1.3, 6);
		expect(socialTickCount(1393, 0)).toBe(0);
		expect(socialTickCount(1393, 1)).toBe(1393);
		expect(socialTickCount(1393, 0.5)).toBe(697);
		expect(socialTickCount(Number.NaN, 0.5)).toBe(0);
	});

	it('only variants that draw likes tick', () => {
		expect(socialLikesTick({ variant: 'tiktok-reply', likeTick: true })).toBe(false);
		expect(socialLikesTick({ variant: 'tiktok-comment', likeTick: true })).toBe(true);
		expect(socialLikesTick({ variant: 'tiktok-comment', likeTick: false })).toBe(false);
	});

	it('short clips: the extras compress before the exit; no value is driven by two overlapping tweens (fast-check)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 400 }),
				fc.constantFrom(23.976, 25, 30, 50, 59.94),
				fc.constantFrom(...SOCIAL_ENTRANCES),
				fc.integer({ min: 0, max: 500 }),
				fc.boolean(),
				(frames, fps, entrance, units, tick) => {
					const t = animeTemplateTiming(socialComment, { fps, localFrame: 0, durationFrames: frames });
					const s = socialCommentSchedule({
						totalMs: t.totalMs,
						introMs: t.introMs,
						outroMs: t.outroMs,
						entrance,
						units,
						tick,
					});
					for (const tr of s.tracks)
						for (let i = 1; i < tr.tweens.length; i++)
							expect(tr.tweens[i]!.start).toBeGreaterThanOrEqual(
								tr.tweens[i - 1]!.start + tr.tweens[i - 1]!.dur - 1e-9,
							);
					const room = s.exitStart - s.entranceEnd;
					// when there is room for the shortest tweens, every extra ends before the exit starts
					if (room >= 4)
						for (const tr of s.tracks.filter((x) => x.target > 0))
							for (const tw of tr.tweens) expect(tw.start + tw.dur).toBeLessThanOrEqual(s.exitStart + 1e-6);
					if (s.tick && room >= 4) expect(s.tick.start + s.tick.dur).toBeLessThanOrEqual(s.exitStart + 1e-6);
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe('social-comment@1 text units', () => {
	it('words are units, whitespace is not; a highlighted run is one unit (one pill)', () => {
		const r = socialCommentSegments('Write ==any comment== and ||see|| it 😊', 'tiktok-reply');
		const units = r.segments.filter((s) => s.unit >= 0);
		expect(units.map((u) => u.text)).toEqual(['Write', 'any comment', 'and', 'see', 'it', '😊']);
		expect(units.map((u) => u.highlight)).toEqual([false, true, false, false, false, false]);
		expect(r.units).toBe(6);
		expect(r.segments.map((s) => s.text).join('')).toBe('Write any comment and see it 😊');
	});

	it('two separate highlights stay two units; partial highlights do not merge', () => {
		const r = socialCommentSegments('==a== ==b== un==real==', 'tiktok-comment');
		expect(r.segments.filter((s) => s.unit >= 0).map((s) => [s.text, s.highlight])).toEqual([
			['a', true],
			['b', true],
			['unreal', false],
		]);
	});

	it('segments always cover the visible text in order with offsets (fast-check)', () => {
		fc.assert(
			fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
				const r = socialCommentSegments(text, 'tiktok-reply');
				const visible = stripMarks(text);
				expect(r.segments.map((s) => s.text).join('')).toBe(visible);
				let at = 0;
				let unit = 0;
				for (const s of r.segments) {
					expect(s.start).toBe(at);
					at += s.text.length;
					if (s.unit >= 0) expect(s.unit).toBe(unit++);
				}
				expect(r.units).toBe(unit);
			}),
			{ numRuns: 300 },
		);
	});
});

describe('closed-form template eases', () => {
	it('start at 0 and end exactly at 1; unknown names fall back to anime.js eases', () => {
		for (const name of Object.keys(TEMPLATE_EASE_FUNCTIONS)) {
			const fn = easeFunction(name);
			expect(fn(0), name).toBe(0);
			expect(fn(1), name).toBe(1);
			expect(fn(-1), name).toBe(0);
			expect(fn(2), name).toBe(1);
		}
		expect(easeFunction('outQuad')(0.5)).toBeCloseTo(0.75, 9);
		let peak = 0;
		for (let t = 0; t <= 1; t += 0.001) peak = Math.max(peak, easeFunction('jasper.spring')(t));
		expect(peak).toBeGreaterThan(1.05);
		expect(peak).toBeLessThan(1.09);
	});
});

describe('social-comment@1 presets and fill hook', () => {
	it('one preset per variant with a card, named "<platform> · <card>"', () => {
		expect(socialComment.presets?.map((p) => [p.id, p.name])).toEqual([
			['tiktok-reply', 'TikTok · Comment reply'],
			['tiktok-comment', 'TikTok · Comment'],
			['youtube-comment', 'YouTube · Comment'],
			['youtube-shorts-reply', 'YouTube · Shorts reply'],
		]);
		// the YouTube presets carry tokcomment's YouTube defaults ("Username", 10 months ago, 72 likes, 2 replies)
		const yt = socialComment.presets!.find((p) => p.id === 'youtube-comment')!;
		expect({ ...socialComment.defaults, ...yt.params }).toMatchObject({
			variant: 'youtube-comment',
			handle: 'Username',
			timeValue: 10,
			timeUnit: 'month',
			likes: 72,
			replies: 2,
		});
		expect(socialCommentUnavailableVariant({ variant: 'youtube-comment' })).toBeNull();
		expect(socialCommentUnavailableVariant({ variant: 'youtube-shorts-reply' })).toBeNull();
		// the YouTube default avatar is a remote image the clip declares (snapshot, planner) only while it is drawn
		const req = (p: Record<string, unknown>) =>
			socialComment.requiredAssets!(socialComment.paramsSchema.parse({ ...socialComment.defaults, ...p }));
		expect(req({ variant: 'youtube-comment' }).images).toEqual([REMOTE_IMAGE_IDS.youtubeDefaultAvatar]);
		expect(req({ variant: 'youtube-shorts-reply' }).images).toEqual([REMOTE_IMAGE_IDS.youtubeDefaultAvatar]);
		expect(req({ variant: 'youtube-comment', showProfile: false }).images).toEqual([]);
		expect(req({ variant: 'youtube-comment', avatar: { generated: 4 } }).images).toEqual([]);
		expect(req({ variant: 'tiktok-comment' }).images).toEqual([]);
		expect(SOCIAL_VARIANT_FONTS['youtube-comment']).toEqual({ family: 'Roboto', weights: [400, 500] });
		expect(SOCIAL_VARIANT_FONTS['youtube-shorts-reply']).toEqual({ family: 'Roboto', weights: [400, 500] });
		for (const p of socialCommentPresets(['x-post', 'youtube-comment']))
			expect(socialComment.paramsSchema.safeParse({ ...socialComment.defaults, ...p.params }).success).toBe(
				true,
			);
	});

	it('fills only what the caller and the preset left out, deterministically; bad input is an error, not a throw', () => {
		const a = socialComment.fill!({ variant: 'tiktok-comment', text: 'hi ==there==', likes: 5000 }, 7);
		const b = socialComment.fill!({ variant: 'tiktok-comment', text: 'hi ==there==', likes: 5000 }, 7);
		expect(a).toEqual(b);
		if (!a.ok) throw new Error(a.error);
		expect(a.params).toMatchObject({ variant: 'tiktok-comment', text: 'hi ==there==', likes: 5000 });
		expect(a.filled).not.toContain('text');
		expect(a.filled).toContain('displayName');
		expect(socialComment.paramsSchema.safeParse(a.params).success).toBe(true);
		expect(socialComment.fill!({ bogus: 1 }, 7)).toMatchObject({ ok: false });
		expect(socialComment.fill!({ likes: -3 }, 7)).toMatchObject({ ok: false });
	});

	it('clip.addMotionGraphic {fill} with the real registry returns resolved params and the filled names', () => {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'F', preset: 'hd-1080p-30' });
		const { result } = applyTransaction(
			doc,
			{
				label: 'fill',
				origin: 'user',
				commands: [
					{
						type: 'clip.addMotionGraphic',
						at: 0,
						duration: 150,
						track: 'V1',
						placement: 'first-free',
						template: { id: 'social-comment', version: 1 },
						params: { variant: 'tiktok-reply', text: 'Part two please' },
						fill: { seed: 3 },
					},
				],
			},
			{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
		);
		expect(result.ok).toBe(true);
		const r = (result as { results: { params: Record<string, unknown>; filled: string[] }[] }).results[0]!;
		expect(r.params).toMatchObject({ variant: 'tiktok-reply', text: 'Part two please' });
		expect(r.params.avatar).toMatchObject({ generated: expect.any(Number) });
		expect(r.filled).toEqual(expect.arrayContaining(['displayName', 'handle', 'avatar']));
	});
});
