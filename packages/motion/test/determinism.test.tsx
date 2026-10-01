// Determinism suite (S11:ANM-013): every registered text animator (TEXT_ANIMATION_IMPLS) and anime template
// (ANIME_TEMPLATE_IMPLS) visited in order, reversed, shuffled and with revisits (fast-check, fixed seeds) equals a
// fresh build / fresh mount per frame. Presets and templates join automatically by being registered. The harness
// is proven here on fixture implementations, including deliberately broken ones it must reject.
import { mgRegistry } from '@jasper/mg-templates';
import { getTextAnimationSpec, type TextAnimationSpec } from '@jasper/project';
import { useMemo } from 'react';
import { describe, expect, it } from 'vitest';
import { createPausedTimeline } from '../src/runtime/index.ts';
import { ANIME_TEMPLATE_IMPLS, type AnimeTemplateProps } from '../src/templates/index.ts';
import {
	REST_UNIT_VALUES,
	TEXT_ANIMATION_IMPLS,
	type TextAnimationImpl,
	type UnitValues,
} from '../src/text/index.ts';
import { FixtureScene, FixtureTemplate, riseImpl, SCENE } from './determinism-fixtures.tsx';
import { checkTemplate, checkTextAnimation, paramVariants, visitOrders } from './determinism-harness.tsx';

/** Broken on purpose: one persistent timeline moved with a plain (history-dependent) seek. */
function PlainSeekTemplate({ timeMs }: AnimeTemplateProps) {
	const built = useMemo(() => {
		const v = { x: 0 };
		const timeline = createPausedTimeline();
		timeline.add(v, { x: [0, 100], duration: 400, ease: 'linear' }, 0);
		timeline.add(v, { x: [200, 300], duration: 400, ease: 'linear' }, 600);
		return { timeline, v };
	}, []);
	built.timeline.seek(timeMs, true);
	return <div style={{ transform: `translateX(${built.v.x}px)` }} />;
}

/** Broken on purpose: an unseeded random offset per mount. */
function RandomTemplate({ timeMs }: AnimeTemplateProps) {
	const offset = useMemo(() => Math.random(), []);
	return <div data-x={timeMs + offset} />;
}

const failuresOf = (reports: { failures: string[] }[]) => reports.flatMap((r) => r.failures);

describe('determinism harness (proven on fixtures)', { timeout: 120_000 }, () => {
	it('visit orders: in order, reversed, shuffled and revisits, the same every run (fixed seeds)', () => {
		const frames = [0, 1, 2, 3, 4, 5, 6, 7];
		const a = visitOrders(frames);
		expect(a.map((o) => o.name).slice(0, 2)).toEqual(['in order', 'reversed']);
		expect(a.length).toBeGreaterThan(10);
		for (const o of a.filter((x) => x.name.startsWith('shuffled')))
			expect([...o.order].sort((x, y) => x - y)).toEqual(frames);
		expect(visitOrders(frames)).toEqual(a);
	});

	it('accepts a correct text animator (both sides, several unit counts, 30 and 24 fps)', () => {
		const reports = checkTextAnimation(riseImpl());
		expect(reports.length).toBeGreaterThanOrEqual(6);
		expect(failuresOf(reports)).toEqual([]);
	});

	it('param variants come from the preset schema (defaults, then each enum value)', () => {
		// A strict zod object with an enum param (borrowed from the fframes title card: motion has no zod).
		const card = mgRegistry.getDefinition('title-card', 1)!;
		const spec = { defaults: card.defaults, paramsSchema: card.paramsSchema } as unknown as TextAnimationSpec;
		const variants = paramVariants(spec);
		expect(variants[0]).toEqual(card.defaults);
		expect(variants.slice(1).map((v) => v.alignment)).toEqual(['left', 'right']);
		expect(paramVariants(undefined)).toEqual([{}]);
	});

	it('rejects unseeded randomness, shared targets, a wrong rest state and a too long timeline', () => {
		const random: TextAnimationImpl = {
			...riseImpl('fixture-random@1'),
			build(ctx) {
				return riseImpl().build({ ...ctx, seed: Math.floor(Math.random() * 1e9) });
			},
		};
		expect(failuresOf(checkTextAnimation(random)).join('\n')).toMatch(/Math\.random/);
		const shared: UnitValues[] = [];
		const sharing = riseImpl('fixture-shared@1', (targets) => {
			if (shared.length === 0) shared.push(...targets);
			return shared.length === targets.length ? shared : targets;
		});
		expect(failuresOf(checkTextAnimation(sharing)).join('\n')).toMatch(/share target objects|differs/);
		const restless: TextAnimationImpl = {
			key: 'fixture-restless@1',
			unitDefault: 'word',
			build({ units, durationMs }) {
				const targets = Array.from({ length: units }, () => ({ ...REST_UNIT_VALUES }));
				const timeline = createPausedTimeline();
				for (const t of targets) timeline.add(t, { opacity: [0, 0.5], duration: durationMs }, 0);
				return { timeline, targets };
			},
		};
		expect(failuresOf(checkTextAnimation(restless)).join('\n')).toMatch(/rest is 1 \(ANM-009\)/);
		const long: TextAnimationImpl = {
			key: 'fixture-long@1',
			unitDefault: 'word',
			build({ units, durationMs }) {
				const targets = Array.from({ length: units }, () => ({ ...REST_UNIT_VALUES }));
				const timeline = createPausedTimeline();
				for (const t of targets) timeline.add(t, { opacity: [1, 1], duration: durationMs * 2 }, 0);
				return { timeline, targets };
			},
		};
		expect(failuresOf(checkTextAnimation(long)).join('\n')).toMatch(/timeline lasts/);
	});

	it('accepts a correct anime template (value engine + DOM leaf), mounted once or fresh, StrictMode', () => {
		expect(checkTemplate('fixture-template@1', FixtureTemplate, undefined).failures).toEqual([]);
	});

	it('accepts the render-parity scene (title in/out, template with a DOM leaf, shape)', () => {
		const Scene = ({ timeMs }: AnimeTemplateProps) => (
			<FixtureScene frame={Math.round((timeMs * SCENE.fps) / 1000)} />
		);
		const def = { introFrames: 18, outroFrames: 12, canvases: [SCENE], defaults: {} } as never;
		expect(checkTemplate('fixture-scene@1', Scene, def).failures).toEqual([]);
	});

	it('rejects a template driven by a plain seek, and one using Math.random', () => {
		expect(checkTemplate('fixture-plain-seek@1', PlainSeekTemplate, undefined).failures.join('\n')).toMatch(
			/differs from a fresh mount/,
		);
		expect(checkTemplate('fixture-random@1', RandomTemplate, undefined).failures.join('\n')).toMatch(
			/Math\.random/,
		);
	});
});

describe('every registered text animator (S11:ANM-013)', { timeout: 120_000 }, () => {
	const impls = Object.entries(TEXT_ANIMATION_IMPLS);
	it('the table is keyed by implementation key', () => {
		for (const [key, impl] of impls) expect(impl.key).toBe(key);
	});
	for (const [key, impl] of impls) {
		const [id, version] = key.split('@') as [string, string];
		it(`${key} is order-independent, rests outside its window and keeps the build contract`, () => {
			const spec = getTextAnimationSpec(id, Number(version));
			expect(failuresOf(checkTextAnimation(impl, spec))).toEqual([]);
		});
	}
});

describe('every registered anime template (S11:ANM-013)', { timeout: 120_000 }, () => {
	const impls = Object.entries(ANIME_TEMPLATE_IMPLS);
	it('the table is keyed id@version', () => {
		for (const [key] of impls) expect(key).toMatch(/^[a-z0-9-]+@\d+$/);
	});
	for (const [key, Component] of impls) {
		const [id, version] = key.split('@') as [string, string];
		it(`${key} renders the same DOM whatever the frame order`, () => {
			const def = mgRegistry.getDefinition(id, Number(version));
			const anime = def && def.renderer === 'anime' ? def : undefined;
			expect(checkTemplate(key, Component, anime).failures).toEqual([]);
		});
	}
});
