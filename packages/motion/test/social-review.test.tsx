// Store review cards of social-comment@1 (happy-dom): Google Play, the App Store web / Mac card and the iPhone App
// Store card — names, dates, ages, titles, the stars and their fill (the like-tick extra), avatars, plain review text,
// emoji packs, inline-editing attributes, seek-order
// independence. Real-Chrome layout and parity: social-review-render.e2e.test.ts.
import {
	animeTemplateTiming,
	SOCIAL_REVIEW_VARIANTS,
	socialComment,
	socialCommentParamsSchema,
	socialDefaults,
} from '@jasper/mg-templates';
import { act, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';
import { APP_STORE_GLYPHS, PLAY_STORE_GLYPHS } from '../src/templates/social/glyphs.ts';
import { vectorMarkupOf } from '../src/templates/social-comment/vector.tsx';

/** The vector images inside `el` (stars, icons, avatars: `VectorImage`). */
const vectors = (el: ParentNode) => [...el.querySelectorAll<HTMLImageElement>('img[data-vector]')];
/** The SVG document a vector image draws. */
const markup = (img: Element) => vectorMarkupOf(img) ?? '';
/** `[d, fill]` of each path a vector image draws. */
const pathsOf = (img: Element): [string, string][] =>
	[...markup(img).matchAll(/<path d="([^"]*)" fill="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]);

const Impl = ANIME_TEMPLATE_IMPLS['social-comment@1']!;

// as social-comment.test.tsx: the Player's behaviour (NODE_ENV=test would be a render), images not yet complete
const completeDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
beforeEach(() => {
	vi.stubEnv('NODE_ENV', 'development');
	Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => false });
});
afterEach(() => {
	vi.unstubAllEnvs();
	if (completeDesc) Object.defineProperty(HTMLImageElement.prototype, 'complete', completeDesc);
});

const fps = 30;
const FRAMES = 150;
const EMOJI_URLS = { 'apple:😊': '/e/apple/1f60a.png', 'noto:😊': '/e/noto/1f60a.png' };

function at(params: Record<string, unknown>, frame: number) {
	const t = animeTemplateTiming(socialComment, { fps, localFrame: frame, durationFrames: FRAMES });
	return (
		<Impl
			params={socialCommentParamsSchema.parse(params)}
			{...t}
			fps={fps}
			canvas={{ width: 1080, height: 1920 }}
			seed={7}
			isPreview={false}
			mediaUrls={{ med_a: 'http://x/a.png' }}
			emojiUrls={EMOJI_URLS}
			imageUrls={{}}
		/>
	);
}
const PLAY = socialDefaults('play-store-review');
const WEB = socialDefaults('app-store-review');
const IOS = socialDefaults('app-store-review-ios');
const part = (c: Element, name: string) => c.querySelector<HTMLElement>(`[data-part="${name}"]`);
const stars = (c: Element) =>
	[...c.querySelectorAll<HTMLElement>('[data-part="stars"] [data-star]')].map((s) => s.dataset.star);

describe('store review cards', () => {
	it('Google Play: avatar, name, kebab, green stars and the M/D/YY date, plain text', () => {
		const r = render(at({ ...PLAY, rating: 4, date: '2018-11-06', text: 'thanks @luna #fyp 😊' }, 100));
		const c = r.container;
		expect(c.querySelector('[data-social-variant="play-store-review"]')).not.toBeNull();
		expect(c.querySelector('[data-social-avatar]')).not.toBeNull();
		expect(part(c, 'name')!.textContent).toBe('Display Name');
		expect(part(c, 'name')!.getAttribute('data-template-param')).toBe('displayName');
		expect(part(c, 'date')!.textContent).toBe('11/6/18');
		expect(stars(c)).toEqual(['filled', 'filled', 'filled', 'filled', 'empty']);
		// the kebab is Play's more_vert, the stars Play's star path, in the screenshot's green / grey
		const paths = vectors(c)
			.flatMap(pathsOf)
			.map(([d]) => d);
		expect(paths).toContain(PLAY_STORE_GLYPHS.more.paths[0].d);
		expect(paths).toContain(PLAY_STORE_GLYPHS.star.paths[0].d);
		const fills = vectors(part(c, 'stars')!)
			.flatMap(pathsOf)
			.map(([, fill]) => fill);
		expect(new Set(fills)).toEqual(new Set(['#479B5F', '#BABABA']));
		// review text is plain: no mention / hashtag colour; the emoji is a Noto image (Play = Android)
		const text = c.querySelector<HTMLElement>('[data-template-param="text"]')!;
		expect([...text.querySelectorAll<HTMLElement>('span')].every((s) => !s.style.color)).toBe(true);
		expect(text.querySelector('img')?.getAttribute('src')).toBe('/e/noto/1f60a.png');
		r.unmount();
	});

	it('Google Play: showProfile off hides the avatar; dark theme uses Play dark colours', () => {
		const r = render(at({ ...PLAY, showProfile: false, theme: 'dark' }, 100));
		expect(r.container.querySelector('[data-social-avatar]')).toBeNull();
		const card = r.container.querySelector<HTMLElement>('[data-social-variant]')!;
		expect(card.style.background).toMatch(/#202124|rgb\(32, 33, 36\)/i);
		r.unmount();
	});

	it('App Store web: no avatar; "name, MM/DD/YYYY", the title, legacy stars stretched into 24 × 25 cells', () => {
		const r = render(
			at({ ...WEB, displayName: 'ekeyser', date: '2021-09-24', title: 'Poor UX', rating: 2 }, 100),
		);
		const c = r.container;
		expect(c.querySelector('[data-social-avatar]')).toBeNull();
		expect(part(c, 'byline')!.textContent).toBe('ekeyser, 09/24/2021');
		expect(part(c, 'title')!.textContent).toBe('Poor UX');
		expect(part(c, 'title')!.getAttribute('data-template-param')).toBe('title');
		expect(stars(c)).toEqual(['filled', 'filled', 'empty', 'empty', 'empty']);
		const svg = markup(vectors(part(c, 'stars')!)[0]!);
		expect(svg).toContain('preserveAspectRatio="none"');
		expect(svg).toContain('width="24" height="25"');
		const d = vectors(part(c, 'stars')!)
			.flatMap(pathsOf)
			.map(([path]) => path);
		expect(d).toContain(APP_STORE_GLYPHS.legacyStar.paths[0].d);
		expect(d).toContain(APP_STORE_GLYPHS.legacyStarEmpty.paths[0].d);
		r.unmount();
		// an empty title hides the title line
		const none = render(at({ ...WEB, title: '' }, 100));
		expect(part(none.container, 'title')).toBeNull();
		none.unmount();
	});

	it('iPhone: title and the age ("1y ago", "edited 1y ago", "Just now"), outline stars, name on the right', () => {
		const age = (p: Record<string, unknown>) => {
			const r = render(at({ ...IOS, ...p }, 100));
			const t = part(r.container, 'date')!.textContent;
			r.unmount();
			return t;
		};
		expect(age({})).toBe('1y ago');
		expect(age({ edited: true })).toBe('edited 1y ago');
		expect(age({ timeValue: 3, timeUnit: 'week' })).toBe('3w ago');
		expect(age({ timeValue: 4, timeUnit: 'month' })).toBe('4mo ago');
		// the screenshot's iOS 14-era rule (default): under a week, the weekday counted back from Sunday 2026-10-25
		expect(age({ timeValue: 2, timeUnit: 'day' })).toBe('Fri');
		expect(age({ timeValue: 6, timeUnit: 'day' })).toBe('Mon');
		expect(age({ timeValue: 5, timeUnit: 'hour' })).toBe('Sun');
		expect(age({ timeValue: 0, timeUnit: 'day', edited: true })).toBe('edited Sun');
		expect(age({ timeValue: 7, timeUnit: 'day' })).toBe('7d ago');
		// today's App Store (iOS 15+)
		const rel = { iosAgeStyle: 'relative' };
		expect(age({ ...rel, timeValue: 2, timeUnit: 'day' })).toBe('2d ago');
		expect(age({ ...rel, timeValue: 5, timeUnit: 'hour' })).toBe('5h ago');
		expect(age({ ...rel, timeValue: 30, timeUnit: 'minute' })).toBe('Just now');
		expect(age({ ...rel, timeValue: 0, timeUnit: 'day', edited: true })).toBe('edited just now');
		const r = render(at({ ...IOS, rating: 1 }, 100));
		const c = r.container;
		expect(part(c, 'title')!.textContent).toBe('Review title');
		expect(part(c, 'name')!.textContent).toBe('Display Name');
		expect(stars(c)).toEqual(['filled', 'empty', 'empty', 'empty', 'empty']);
		const d = vectors(part(c, 'stars')!)
			.flatMap(pathsOf)
			.map(([path]) => path);
		expect(d).toContain(APP_STORE_GLYPHS.starOutline.paths[0].d);
		// App Store emoji are Apple's
		r.unmount();
		const e = render(at({ ...IOS, text: 'nice 😊' }, 100));
		expect(e.container.querySelector('[data-template-param="text"] img')?.getAttribute('src')).toBe(
			'/e/apple/1f60a.png',
		);
		e.unmount();
		// no title: the line keeps its height and nothing is editable there
		const blank = render(at({ ...IOS, title: '' }, 100));
		expect(part(blank.container, 'title')!.hasAttribute('data-template-param')).toBe(false);
		blank.unmount();
	});

	it('long names and titles truncate on one line', () => {
		for (const variant of SOCIAL_REVIEW_VARIANTS) {
			const r = render(
				at({ ...socialDefaults(variant), displayName: 'W'.repeat(64), title: 'T'.repeat(120) }, 100),
			);
			expect(part(r.container, 'name')!.style.textOverflow, variant).toBe('ellipsis');
			const title = part(r.container, 'title');
			if (variant !== 'play-store-review') expect(title!.style.textOverflow, variant).toBe('ellipsis');
			r.unmount();
		}
	});
});

describe('star fill (likes tick up on store reviews)', () => {
	it('the stars fill one by one after the entrance, pulse at the end and rest filled up to the rating', () => {
		for (const variant of SOCIAL_REVIEW_VARIANTS) {
			const p = { ...socialDefaults(variant), likeTick: true, rating: 4 };
			const seen = new Set<string>();
			const r = render(at(p, 0));
			for (let f = 0; f <= 60; f++) {
				act(() => r.rerender(at(p, f)));
				seen.add(stars(r.container).join(','));
				const row = part(r.container, 'stars')!;
				// animation styles only while the stars pulse (paint determinism: the un-animated DOM otherwise)
				expect(row.style.boxShadow !== '', `${variant} ${f}`).toBe(row.style.transform !== '');
			}
			// empty → partial stars in order → all four filled
			expect(seen.has('empty,empty,empty,empty,empty'), variant).toBe(true);
			expect(
				[...seen].some((s) => s.includes('partial')),
				variant,
			).toBe(true);
			expect(seen.has('filled,filled,filled,filled,empty'), variant).toBe(true);
			for (const s of seen) {
				const order = s.split(',');
				// never a filled star after an empty one (one by one)
				expect(order.join(',')).toMatch(/^(filled,)*(partial,)?(empty,?)*$/);
			}
			// the pulse: a frame of the thump scales the stars, the hold does not
			const pulse = [...Array(30).keys()].some((k) => {
				act(() => r.rerender(at(p, 40 + k)));
				const tf = part(r.container, 'stars')!.style.transform;
				return /scale\(1\.\d+\)/.test(tf);
			});
			expect(pulse, variant).toBe(true);
			act(() => r.rerender(at(p, 100)));
			expect(part(r.container, 'stars')!.style.transform).toBe('');
			expect(stars(r.container)).toEqual(['filled', 'filled', 'filled', 'filled', 'empty']);
			r.unmount();
		}
	});

	it('without the extra the stars are drawn filled from the first frame, with no ink ring', () => {
		const r = render(at({ ...PLAY, rating: 5 }, 3));
		expect(stars(r.container)).toEqual(['filled', 'filled', 'filled', 'filled', 'filled']);
		expect(part(r.container, 'stars')!.style.boxShadow).toBe('');
		r.unmount();
	});

	it('every frame is a pure function of params and time, in any visiting order (fast-check)', () => {
		for (const variant of SOCIAL_REVIEW_VARIANTS) {
			const p = { ...socialDefaults(variant), likeTick: true, wordReveal: true, entrance: 'drop-bounce' };
			const frames = [0, 8, 17, 24, 33, 45, 100, 148];
			const fresh = new Map(
				frames.map((f) => {
					const r = render(at(p, f));
					const h = r.container.innerHTML;
					r.unmount();
					return [f, h];
				}),
			);
			fc.assert(
				fc.property(fc.shuffledSubarray(frames, { minLength: 2 }), (order) => {
					const v = render(at(p, order[0]!));
					for (const f of order) {
						act(() => v.rerender(at(p, f)));
						expect(v.container.innerHTML).toBe(fresh.get(f));
					}
					v.unmount();
				}),
				{ numRuns: 15 },
			);
		}
	});
});
