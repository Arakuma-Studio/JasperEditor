// Land / exit cues of the ANIME motion-graphic templates follow their real animation (wp-note "Phase 6 → WP6.5b",
// item 16). The project layer may not import anime.js; @jasper/mg-templates measures the anime templates on a pure
// motion model (the phases the implementations here build their timelines from, and the anime.js ease curves ported
// as functions). This test is the bridge: it builds each template's REAL anime.js timeline (the implementations'
// own builds, seeked canonically like `useAnimeValues`) and checks
//   1. the model's values equal the anime.js values at every frame (and between frames), for every template, at
//      several rates, lengths (compressed intro / outro included) and params (every ease);
//   2. the derived land / exit cues (deriveCues with the shipped registry) sit within ±1 frame of where the real
//      animation's frames come to rest / start leaving (the frames' changes against the motion threshold, as the
//      keyframed-clip sampler measures a picture), and of a continuous-time oracle on the real values (land ±1;
//      exit −1…+1.5 frames: an ease-in onset averaged over a frame crosses the threshold up to 1.5 frames after the
//      instantaneous rate, as in @jasper/mg-templates' fframes test);
//   3. before (the declared intro / outro the anime templates used to fall back to) is reported for the wp-note.
// The fframes templates (lower-third, title-card) are checked the same way against their own analytic oracle in
// @jasper/mg-templates `test/motion-cues.test.ts`; together every shipped template is covered (asserted there).
import {
	ANIME_CATALOG,
	type AnimeTrack,
	animeMotionModel,
	animeTemplateTiming,
	CALLOUT_PHASES,
	calloutParams,
	counterParams,
	formatCounterValue,
	K_OPACITY,
	lowerThirdAnimParams,
	mgRegistry,
	needsShaping,
	phaseTimes,
	segmentText,
	socialCommentParamsSchema,
	socialCommentSchedule,
	socialCommentSegments,
	socialLikesTick,
	socialTickText,
	TEXT_CHANGE_SPEED,
	titleRevealParams,
	trackValueAt,
} from '@jasper/mg-templates';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	deriveCues,
	flicksPerFrame,
	K_SCALE,
	MOVE_OFF,
	MOVE_ON,
	mgPhases,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { createPausedTimeline, roundValue, seekCanonical } from '../src/runtime/index.ts';
import { buildCallout } from '../src/templates/callout.tsx';
import { easeOf } from '../src/templates/common.tsx';
import { buildCounter, buildCounterCount, counterProgressAt } from '../src/templates/counter.tsx';
import { buildLowerThirdAnim } from '../src/templates/lower-third-anim.tsx';
import {
	buildSocialComment,
	buildSocialTick,
	socialTickProgressAt,
} from '../src/templates/social-comment/build.ts';
import { buildTitleReveal } from '../src/templates/title-reveal.tsx';

const SEED = 7;
const RATES: Record<string, number> = {
	'23.976': 24000 / 1001,
	'25': 25,
	'29.97': 30000 / 1001,
	'30': 30,
	'50': 50,
	'59.94': 60000 / 1001,
};

type Real = {
	/** Value of model track `tr` at content ms, from the real anime.js timeline. */
	value(tr: Pick<AnimeTrack, 'target' | 'prop'>, ms: number): number;
	text: ((ms: number) => string) | null;
};

/** The template's REAL timeline (its own build, the component's input), seeked canonically. */
function realTimeline(id: string, params: Record<string, unknown>, totalFrames: number, fps: number): Real {
	const def = ANIME_CATALOG.find((d) => d.id === id)!;
	const at = animeTemplateTiming(def, { fps, localFrame: 0, durationFrames: totalFrames, sourceInFrames: 0 });
	const timing = { totalMs: at.totalMs, introMs: at.introMs, outroMs: at.outroMs };
	let built: { timeline: ReturnType<typeof createPausedTimeline>; targets: Record<string, number>[] };
	let text: Real['text'] = null;
	let line: { timeline: ReturnType<typeof createPausedTimeline>; target: { d: number } } | null = null;
	if (id === 'title-reveal') {
		const p = titleRevealParams.parse(params);
		const units = segmentText(p.title, needsShaping(p.title) ? 'word' : 'char').filter(
			(s) => !s.space,
		).length;
		built = buildTitleReveal({
			...timing,
			units,
			order: p.order,
			stagger: p.stagger,
			ease: easeOf(p.ease),
			seed: SEED,
		});
	} else if (id === 'lower-third-anim') {
		const p = lowerThirdAnimParams.parse(params);
		built = buildLowerThirdAnim({
			...timing,
			nameWords: segmentText(p.name, 'word').filter((s) => !s.space).length,
			roleWords: segmentText(p.role, 'word').filter((s) => !s.space).length,
			ease: easeOf(p.ease),
		});
	} else if (id === 'callout') {
		const p = calloutParams.parse(params);
		const input = { ...timing, ease: easeOf(p.ease), motionPath: p.motionPath };
		built = buildCallout(input);
		// The leader line is a DOM leaf (`createDrawable`): its drawn length is the same tweens on a plain value
		// (intro: the end 0 → 1 with the template's ease; outro: the start 0 → 1 with inOut, i.e. the length 1 → 0).
		const tl = createPausedTimeline();
		const target = { d: 0 };
		const pt = phaseTimes(input, CALLOUT_PHASES.line);
		tl.add(target, { d: [0, 1], duration: pt.introDur, ease: input.ease }, pt.introStart);
		if (pt.outroStart !== null)
			tl.add(target, { d: [1, 0], duration: pt.outroDur, ease: 'inOut' }, pt.outroStart);
		line = { timeline: tl, target };
	} else if (id === 'social-comment') {
		// the implementation's own input (SocialComment): the schedule, its anime.js timeline and the count tick
		const p = socialCommentParamsSchema.parse(params);
		const tick = socialLikesTick(p);
		const schedule = socialCommentSchedule({
			...timing,
			entrance: p.entrance,
			units: p.wordReveal ? socialCommentSegments(p.text, p.variant).units : 0,
			tick,
		});
		built = buildSocialComment(schedule);
		const count = schedule.tick ? buildSocialTick(schedule.tick) : null;
		if (count)
			text = (ms) =>
				// the like count, or on store reviews the stars filled so far
				socialTickText(p, socialTickProgressAt(count, ms));
	} else {
		const p = counterParams.parse(params);
		const countMs = Math.max(1, Math.min(p.countSeconds * 1000, timing.totalMs - timing.outroMs));
		const input = { ...timing, countMs, ease: easeOf(p.ease) };
		built = buildCounter(input);
		const count = buildCounterCount(input);
		text = (ms) => {
			const pr = counterProgressAt(count, ms);
			return formatCounterValue(pr === 0 ? p.from : pr === 1 ? p.to : p.from + (p.to - p.from) * pr, p);
		};
	}
	let at0 = Number.NaN;
	let values: Record<string, number>[] = [];
	return {
		value(tr, ms) {
			if (tr.target === 3 && tr.prop === 'draw' && line) {
				seekCanonical(line.timeline, ms);
				return roundValue(line.target.d);
			}
			if (ms !== at0) {
				seekCanonical(built.timeline, ms);
				values = built.targets.map((t) =>
					Object.fromEntries(Object.entries(t).map(([k, v]) => [k, roundValue(v)])),
				);
				at0 = ms;
			}
			return values[tr.target]![tr.prop]!;
		},
		text,
	};
}

/** Picture speed per content frame from values `v(track, ms)` (the rule of `animeTemplateSpeed`). */
function frameSpeeds(
	tracks: AnimeTrack[],
	v: (tr: AnimeTrack, ms: number) => number,
	text: ((ms: number) => string) | null,
	total: number,
	fps: number,
	scale: number,
): number[] {
	const diag = Math.hypot(1920, 1080);
	const out = new Array<number>(total).fill(0);
	// all values of a frame at once (the real timeline seeks once per time)
	let prev = tracks.map((tr) => v(tr, 0));
	let prevText = text ? text(0) : '';
	for (let f = 1; f < total; f++) {
		const cur = tracks.map((tr) => v(tr, (f * 1000) / fps));
		let px = 0;
		let other = 0;
		tracks.forEach((tr, i) => {
			const a = prev[i]!;
			const b = cur[i]!;
			if (a === b) return;
			const s = tr.show;
			if (s.kind === 'px') {
				const c = (x: number) => (s.clamp01 ? Math.min(1, Math.max(0, x)) : x);
				px = Math.max(px, Math.abs(c(b) - c(a)) * s.perUnit * scale);
			} else if (s.kind === 'point') {
				const pa = s.pointAt(a);
				const pb = s.pointAt(b);
				px = Math.max(px, Math.hypot(pb.x - pa.x, pb.y - pa.y) * scale);
			} else if (s.kind === 'opacity') other = Math.max(other, K_OPACITY * Math.abs(b - a));
			else other = Math.max(other, a > 0 && b > 0 ? K_SCALE * Math.abs(Math.log(b / a)) : K_SCALE * 5);
		});
		let sp = Math.max(px / diag, other) * fps;
		const t = text ? text((f * 1000) / fps) : '';
		if (text && t !== prevText) sp = Math.max(sp, TEXT_CHANGE_SPEED);
		prevText = t;
		out[f] = sp;
		prev = cur;
	}
	return out;
}

/**
 * Where a picture of per-frame speeds settles and starts leaving (written here, not `speedSegments`): moving frames
 * are runs above MOVE_OFF reaching MOVE_ON, at least 2 frames, joined over pauses ≤ 0.25 s; the intro is the first
 * when it starts within 0.1 s (+ 1 frame) and lands on its last moving frame; the outro is the last other movement
 * starting after the land, leaving on its first frame.
 */
function restAndLeave(speed: number[], fps: number): { land: number | null; exit: number | null } {
	const runs: [number, number, number][] = [];
	for (let i = 0; i < speed.length; ) {
		if (!(speed[i]! > MOVE_OFF)) {
			i++;
			continue;
		}
		const a = i;
		let peak = 0;
		while (i < speed.length && speed[i]! > MOVE_OFF) peak = Math.max(peak, speed[i++]!);
		runs.push([a, i - 1, peak]);
	}
	const bridge = Math.max(1, Math.round(0.25 * fps));
	const joined: [number, number, number][] = [];
	for (const r of runs) {
		const last = joined[joined.length - 1];
		if (last && r[0] - last[1] - 1 <= bridge) {
			last[1] = r[1];
			last[2] = Math.max(last[2], r[2]);
		} else joined.push([...r]);
	}
	const moves = joined.filter((s) => s[2] >= MOVE_ON && s[1] - s[0] + 1 >= 2);
	const first = moves[0];
	const intro = first && first[0] <= Math.round(0.1 * fps) + 1 ? first : undefined;
	const land = intro && intro[1] < speed.length - 1 ? intro[1] : null;
	const last = moves[moves.length - 1];
	const exit = last && last !== intro && (land === null || last[0] > land) ? last[0] : null;
	return { land, exit };
}

/** Continuous-time oracle on the real values (1 ms steps): settle / leave in seconds. */
function continuousOracle(
	tracks: AnimeTrack[],
	real: Real,
	seconds: number,
	scale: number,
	fps: number,
): { settle: number | null; leave: number | null } {
	// Pauses joined into one movement: the frames' rule (up to round(0.25·fps) still frames between moving ones)
	// in seconds — a count's last ticks are instants, so the rounding of 0.25 s to frames decides whether they join.
	const bridge = (Math.round(0.25 * fps) + 1) / fps;
	// The instantaneous rate of each real value: a central difference ±h inside its tweens. At a tween's own start
	// and end the rate is not defined (outExpo / inExpo jump by 2⁻¹⁰ there: a change of a quarter 8-bit code value,
	// not motion), so samples within 2h of a boundary take the rate from their neighbours.
	const dtMs = 2;
	const h = 0.01;
	const diag = Math.hypot(1920, 1080);
	const edges = tracks.map((tr) => tr.tweens.flatMap((tw) => [tw.start, tw.start + tw.dur]));
	const nearEdge = (i: number, ms: number) => edges[i]!.some((e) => Math.abs(e - ms) < 2 * h);
	const rateOf = (tr: AnimeTrack, a: number, b: number) => {
		const k = 1000 / (2 * h);
		const s = tr.show;
		if (s.kind === 'px') {
			const c = (x: number) => (s.clamp01 ? Math.min(1, Math.max(0, x)) : x);
			return (Math.abs(c(b) - c(a)) * s.perUnit * scale * k) / diag;
		}
		if (s.kind === 'point') {
			const pa = s.pointAt(a);
			const pb = s.pointAt(b);
			return (Math.hypot(pb.x - pa.x, pb.y - pa.y) * scale * k) / diag;
		}
		if (s.kind === 'opacity') return K_OPACITY * Math.abs(b - a) * k;
		return a > 0 && b > 0 ? K_SCALE * Math.abs(Math.log(b / a)) * k : a !== b ? 1 : 0;
	};
	const spans: [number, number][] = [];
	let open: number | null = null;
	let prevText = real.text ? real.text(0) : '';
	const last = tracks.map(() => 0);
	const end = seconds * 1000;
	for (let ms = dtMs; ms < end; ms += dtMs) {
		let moving = false;
		// all values at ms − h, then all at ms + h (the real timeline seeks once per time)
		const va = tracks.map((tr) => real.value(tr, ms - h));
		const vb = tracks.map((tr) => real.value(tr, ms + h));
		tracks.forEach((tr, i) => {
			let r = last[i]!;
			if (!nearEdge(i, ms)) r = rateOf(tr, va[i]!, vb[i]!);
			last[i] = r;
			if (r > MOVE_OFF) moving = true;
		});
		const text = real.text ? real.text(ms) : '';
		if (text !== prevText) moving = true;
		prevText = text;
		const t = ms / 1000;
		if (moving && open === null) open = t - dtMs / 2000;
		if (!moving && open !== null) {
			spans.push([open, t - dtMs / 2000]);
			open = null;
		}
	}
	if (open !== null) spans.push([open, seconds]);
	const joined: [number, number][] = [];
	for (const sp of spans) {
		const prev = joined[joined.length - 1];
		if (prev && sp[0] - prev[1] <= bridge + 1e-9) prev[1] = sp[1];
		else joined.push([...sp]);
	}
	const intro = joined[0] && joined[0][0] <= 0.1 ? joined[0] : undefined;
	const tail = joined[joined.length - 1];
	return { settle: intro ? intro[1] : null, leave: tail && tail !== intro ? tail[0] : null };
}

/** One motion-graphic clip on V1 at `at`, `duration` frames, content starting `sourceIn` frames in. */
function mgDoc(
	rate: string,
	template: string,
	params: Record<string, unknown>,
	at: number,
	duration: number,
	sourceIn = 0,
) {
	const ids = createCounterIdSource(1);
	const doc0 = createEmptyProject({ ids, name: 'T', preset: `hd-1080p-${rate}` });
	const seqId = Object.keys(doc0.sequences)[0]!;
	const { document, result } = applyTransaction(
		doc0,
		{
			label: 't',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at,
					duration,
					track: 'V1',
					template: { id: template, version: 1 },
					params,
					ref: '$m',
				},
			],
		},
		{
			ids: createCounterIdSource(9),
			now: () => '2026-10-17T10:00:00.000Z',
			revision: 0,
			registries: defaultRegistries(mgRegistry),
		},
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const doc = structuredClone(document);
	const seq = doc.sequences[seqId]!;
	if (sourceIn)
		(seq.clips[result.refs.$m!] as { sourceIn: number }).sourceIn =
			sourceIn * flicksPerFrame(seq.settings.frameRate);
	const r = deriveCues(doc, seqId, { sources: ['mg'], density: 'rich', mgTemplates: mgRegistry });
	const cues = r.cues.filter((c) => c.from === 'mg');
	return {
		land: cues.find((c) => c.kind === 'land'),
		exit: cues.find((c) => c.kind === 'exit'),
	};
}

type Variant = {
	template: string;
	rate: string;
	seconds: number;
	sourceIn?: number;
	params?: Record<string, unknown>;
};

const VARIANTS: Variant[] = [];
for (const def of ANIME_CATALOG)
	for (const rate of Object.keys(RATES))
		VARIANTS.push({ template: def.id, rate, seconds: def.defaultDurationSeconds });
VARIANTS.push(
	{ template: 'title-reveal', rate: '30', seconds: 4, params: { ease: 'outBack' } },
	{
		template: 'title-reveal',
		rate: '25',
		seconds: 4,
		params: { ease: 'outElastic', stagger: 0, order: 'center' },
	},
	{
		template: 'title-reveal',
		rate: '30',
		seconds: 3,
		params: { underline: false, subtitle: '', ease: 'linear' },
	},
	{ template: 'title-reveal', rate: '59.94', seconds: 4, params: { order: 'random', ease: 'outBounce' } },
	{ template: 'title-reveal', rate: '30', seconds: 1.2, params: {} }, // intro + outro compressed
	{ template: 'title-reveal', rate: '30', seconds: 4, sourceIn: 6, params: { ease: 'inOutExpo' } },
	{ template: 'lower-third-anim', rate: '30', seconds: 5, params: { ease: 'outElastic' } },
	{
		template: 'lower-third-anim',
		rate: '23.976',
		seconds: 5,
		params: { role: '', side: 'right', ease: 'outBack' },
	},
	{ template: 'lower-third-anim', rate: '50', seconds: 5, params: { ease: 'linear', name: 'Ana' } },
	{ template: 'lower-third-anim', rate: '30', seconds: 1.1, params: {} },
	{ template: 'callout', rate: '30', seconds: 4, params: { motionPath: true } },
	{ template: 'callout', rate: '29.97', seconds: 4, params: { path: 'straight', ease: 'outExpo' } },
	{ template: 'callout', rate: '59.94', seconds: 4, params: { ease: 'outBounce', motionPath: true } },
	{ template: 'callout', rate: '30', seconds: 4, sourceIn: 4, params: {} },
	{ template: 'counter', rate: '30', seconds: 5, params: { ease: 'linear', countSeconds: 1 } },
	{ template: 'counter', rate: '25', seconds: 6, params: { label: '', countSeconds: 4, to: 99 } },
	{
		template: 'counter',
		rate: '59.94',
		seconds: 5,
		params: { ease: 'inOutExpo', from: 1000, to: 0, decimals: 1 },
	},
);
// social-comment: every entrance × the extras (none, word reveal, like tick, both) on the TikTok variants (the
// schedule does not depend on the card, only on the likes being drawn: the reply bubble has none, so its tick is off),
// a long comment (the reveal compresses to its 2.4 s span), short clips (the extras squeezed before the exit; intro and
// outro compressed), other rates and a head trim.
for (const entrance of ['classic-pop', 'soft-spring', 'grow-from-tail', 'drop-bounce'])
	for (const [wordReveal, likeTick] of [
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	] as const)
		VARIANTS.push({
			template: 'social-comment',
			rate: '30',
			seconds: 5,
			params: { variant: 'tiktok-comment', entrance, wordReveal, likeTick },
		});
VARIANTS.push(
	{
		template: 'social-comment',
		rate: '25',
		seconds: 5,
		params: { entrance: 'drop-bounce', wordReveal: true },
	},
	{
		template: 'social-comment',
		rate: '59.94',
		seconds: 4,
		params: { variant: 'tiktok-comment', entrance: 'classic-pop', likeTick: true, likes: 4_812_345 },
	},
	{
		template: 'social-comment',
		rate: '23.976',
		seconds: 6,
		params: {
			entrance: 'grow-from-tail',
			wordReveal: true,
			text: 'Okay this is ==honestly the best== tutorial I have seen all week 😂 I tried it on my own videos and the engagement doubled overnight, can you please make a part two about ||editing||? 🔥🙏 ~~Thanks~~ so much!',
		},
	},
	{
		template: 'social-comment',
		rate: '30',
		seconds: 1.5,
		params: { variant: 'tiktok-comment', wordReveal: true, likeTick: true },
	},
	{ template: 'social-comment', rate: '30', seconds: 0.6, params: { entrance: 'drop-bounce' } },
	// Instagram: the post comment draws likes (its tick runs), the Reels reply card does not (word reveal only)
	...(['classic-pop', 'grow-from-tail'] as const).flatMap((entrance) => [
		{
			template: 'social-comment',
			rate: '30',
			seconds: 5,
			params: { variant: 'instagram-post', entrance, wordReveal: true, likeTick: true, likes: 114 },
		},
		{
			template: 'social-comment',
			rate: '30',
			seconds: 5,
			params: { variant: 'instagram-reel-reply', entrance, wordReveal: true, likeTick: true },
		},
	]),
	{
		template: 'social-comment',
		rate: '25',
		seconds: 1.5,
		params: { variant: 'instagram-post', entrance: 'soft-spring', likeTick: true, likes: 987_654 },
	},
	{
		template: 'social-comment',
		rate: '30',
		seconds: 4,
		sourceIn: 5,
		params: { variant: 'tiktok-comment', entrance: 'soft-spring', likeTick: true },
	},
);

// X: the post card draws likes (the heart ticks) — every entrance with both extras, the like tick alone with huge counts
// at another rate, word reveal growing from its avatar corner on a short clip
for (const entrance of ['classic-pop', 'soft-spring', 'grow-from-tail', 'drop-bounce'])
	VARIANTS.push({
		template: 'social-comment',
		rate: '30',
		seconds: 5,
		params: { variant: 'x-post', entrance, wordReveal: true, likeTick: true },
	});
VARIANTS.push(
	{
		template: 'social-comment',
		rate: '50',
		seconds: 3,
		params: {
			variant: 'x-post',
			theme: 'dark',
			entrance: 'soft-spring',
			likeTick: true,
			likes: 987_654_321_000,
		},
	},
	{
		template: 'social-comment',
		rate: '29.97',
		seconds: 1.5,
		params: { variant: 'x-post', entrance: 'grow-from-tail', wordReveal: true },
	},
);

// YouTube: the comment draws likes (the thumb ticks) — every entrance with both extras, and the like tick alone at
// another rate; the Shorts card has no likes (its tick is off) — word reveal growing from its avatar corner, and a
// like tick that must be ignored.
for (const entrance of ['classic-pop', 'soft-spring', 'grow-from-tail', 'drop-bounce'])
	VARIANTS.push({
		template: 'social-comment',
		rate: '30',
		seconds: 5,
		params: { variant: 'youtube-comment', entrance, wordReveal: true, likeTick: true },
	});
VARIANTS.push(
	{
		template: 'social-comment',
		rate: '25',
		seconds: 3,
		params: {
			variant: 'youtube-comment',
			theme: 'dark',
			entrance: 'soft-spring',
			likeTick: true,
			likes: 1_234_567,
		},
	},
	{
		template: 'social-comment',
		rate: '30',
		seconds: 5,
		params: { variant: 'youtube-shorts-reply', entrance: 'grow-from-tail', wordReveal: true },
	},
	{
		template: 'social-comment',
		rate: '59.94',
		seconds: 2,
		params: { variant: 'youtube-shorts-reply', entrance: 'drop-bounce', likeTick: true, wordReveal: true },
	},
);

// Store reviews: the like tick fills the stars one by one (`socialTickText` is the stars filled so far) — every
// entrance with both extras on the three cards, a 1-star review on a short clip, another rate
for (const variant of ['play-store-review', 'app-store-review', 'app-store-review-ios'])
	for (const entrance of ['classic-pop', 'soft-spring', 'grow-from-tail', 'drop-bounce'])
		VARIANTS.push({
			template: 'social-comment',
			rate: '30',
			seconds: 5,
			params: { variant, entrance, wordReveal: true, likeTick: true, rating: 4 },
		});
VARIANTS.push(
	{
		template: 'social-comment',
		rate: '25',
		seconds: 1.5,
		params: { variant: 'play-store-review', entrance: 'drop-bounce', likeTick: true, rating: 1 },
	},
	{
		template: 'social-comment',
		rate: '59.94',
		seconds: 4,
		params: { variant: 'app-store-review-ios', entrance: 'soft-spring', likeTick: true, rating: 5 },
	},
);

const report: string[] = [];
const before: number[] = [];
const after: number[] = [];

describe('anime template land / exit cues follow the real anime.js animation', () => {
	it('covers every shipped anime template, each measured (no declared fallback)', () => {
		expect(new Set(VARIANTS.map((v) => v.template))).toEqual(new Set(ANIME_CATALOG.map((d) => d.id)));
		for (const d of ANIME_CATALOG)
			expect(mgRegistry.get(d.id, d.version)!.motionSpeed).toBeTypeOf('function');
	});

	for (const v of VARIANTS)
		it(`${v.template} ${JSON.stringify(v.params ?? {})} at ${v.rate} fps, ${v.seconds} s${v.sourceIn ? `, sourceIn ${v.sourceIn}` : ''}`, () => {
			const fps = RATES[v.rate]!;
			const def = ANIME_CATALOG.find((d) => d.id === v.template)!;
			const duration = Math.round(v.seconds * fps);
			const s = v.sourceIn ?? 0;
			const total = s + duration;
			const params = { ...def.defaults, ...(v.params ?? {}) };
			const model = animeMotionModel(def, params, { fps, totalFrames: total })!;
			expect(model).not.toBeNull();
			const real = realTimeline(v.template, params, total, fps);
			// 1. the model's values are anime.js's, at every frame and halfway between frames
			const order = (params as { order?: string }).order;
			for (let k = 0; k < 2 * total; k++) {
				const ms = (k * 500) / fps;
				// a seeded order (title-reveal 'random'): the same set of character values at every time
				const chars =
					order === 'random' ? segmentText(String(params.title), 'char').filter((x) => !x.space).length : 0;
				for (const prop of chars ? ['o', 'y'] : []) {
					const units = model.tracks.filter((tr) => tr.prop === prop && tr.target < chars);
					const m = units.map((tr) => trackValueAt(tr, ms)).sort((a, b) => a - b);
					const r = units.map((tr) => real.value(tr, ms)).sort((a, b) => a - b);
					for (let i = 0; i < m.length; i++) expect(Math.abs(m[i]! - r[i]!)).toBeLessThan(1e-6);
				}
				// (at a tween's end, anime.js and the model may round the time to opposite sides of it: 1e-6 ms either
				// side is accepted — outExpo / inExpo jump by 2⁻¹⁰ there)
				for (const tr of model.tracks.filter((x) => x.target >= chars)) {
					const r = real.value(tr, ms);
					const d = Math.min(...[ms - 1e-6, ms, ms + 1e-6].map((t) => Math.abs(trackValueAt(tr, t) - r)));
					expect(d, `${tr.target}.${tr.prop} at ${ms.toFixed(3)} ms`).toBeLessThan(1e-6);
				}
				if (model.textAt) expect(model.textAt(ms)).toBe(real.text!(ms));
			}
			// 2. the cues against the real animation's frames and a continuous oracle
			const speed = frameSpeeds(
				model.tracks,
				(tr, ms) => real.value(tr, ms),
				real.text,
				total,
				fps,
				model.scale,
			);
			const truth = restAndLeave(speed, fps);
			const oracle = continuousOracle(model.tracks, real, total / fps, model.scale, fps);
			const at = 120;
			const { land, exit } = mgDoc(v.rate, v.template, params, at, duration, s);
			const content = (frame: number) => frame - at + s;
			if (process.env.MG_DEBUG)
				process.stderr.write(
					`${JSON.stringify(v)} truth ${JSON.stringify(truth)} oracle ${((oracle.settle ?? 0) * fps).toFixed(2)},${((oracle.leave ?? 0) * fps).toFixed(2)} cues ${land ? content(land.frame) : '-'} ${exit ? content(exit.frame) : '-'}\n`,
				);
			if (truth.land !== null && truth.land > s) {
				expect(land, 'land cue').toBeDefined();
				expect(Math.abs(content(land!.frame) - truth.land)).toBeLessThanOrEqual(1);
				expect(land!.confidence).toBe(0.8);
				// The counter settles on its last ticks of the number: instants, which only the frames define (two ticks
				// 0.29 s apart are one movement or two depending on the frame grid) — its reference is the frames above.
				if (!model.textAt)
					expect(Math.abs(content(land!.frame) - oracle.settle! * fps)).toBeLessThanOrEqual(1);
			} else expect(land).toBeUndefined();
			if (truth.exit !== null && truth.exit > s) {
				expect(exit, 'exit cue').toBeDefined();
				expect(Math.abs(content(exit!.frame) - truth.exit)).toBeLessThanOrEqual(1);
				const lag = content(exit!.frame) - oracle.leave! * fps;
				expect(lag).toBeGreaterThanOrEqual(-1);
				expect(lag).toBeLessThanOrEqual(1.5);
			} else expect(exit).toBeUndefined();
			// 3. before: the declared intro / outro (what anime templates used to get)
			const declared = mgPhases(def, fps, total);
			if (truth.land !== null && land) {
				before.push(Math.abs(declared.intro - truth.land));
				after.push(Math.abs(content(land.frame) - truth.land));
			}
			if (truth.exit !== null && exit && declared.outro > 0) {
				before.push(Math.abs(total - declared.outro - truth.exit));
				after.push(Math.abs(content(exit.frame) - truth.exit));
			}
			report.push(
				`${v.template} ${v.rate} ${JSON.stringify(v.params ?? {})}: land ${land ? content(land.frame) : '-'} (real ${truth.land}, oracle ${oracle.settle === null ? '-' : (oracle.settle * fps).toFixed(2)}, declared ${declared.intro}); exit ${exit ? content(exit.frame) : '-'} (real ${truth.exit}, oracle ${oracle.leave === null ? '-' : (oracle.leave * fps).toFixed(2)}, declared ${total - declared.outro})`,
			);
		}, 180_000);

	it('reports declared (before) vs measured (after) distance to the real frames', () => {
		console.log(report.join('\n'));
		const max = (xs: number[]) => Math.max(0, ...xs);
		console.log(
			`declared timing: max ${max(before)} frames off; measured: max ${max(after)} frames off (${after.length} cues)`,
		);
		expect(max(after)).toBeLessThanOrEqual(1);
	});
});
