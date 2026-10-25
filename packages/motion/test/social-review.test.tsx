// Store review cards of social-comment@1 (happy-dom): Google Play, the App Store web / Mac card and the iPhone App
// Store card — names, dates, ages, titles, the stars and their fill (the like-tick extra), avatars, plain review text,
// emoji packs, inline-editing attributes, the long-review clamp (measured with stubbed layout boxes) and seek-order
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
import { INK_RING } from '../src/templates/social-comment/parts.tsx';

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
		const paths = [...c.querySelectorAll('path')].map((p) => p.getAttribute('d'));
		expect(paths).toContain(PLAY_STORE_GLYPHS.more.paths[0].d);
		expect(paths).toContain(PLAY_STORE_GLYPHS.star.paths[0].d);
		const fills = [...c.querySelectorAll('[data-part="stars"] path')].map((p) => p.getAttribute('fill'));
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
		const svg = c.querySelector('[data-part="stars"] svg')!;
		expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
		expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['24', '25']);
		const d = [...c.querySelectorAll('[data-part="stars"] path')].map((p) => p.getAttribute('d'));
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
		expect(age({ timeValue: 2, timeUnit: 'day' })).toBe('2d ago');
		expect(age({ timeValue: 3, timeUnit: 'week' })).toBe('3w ago');
		expect(age({ timeValue: 4, timeUnit: 'month' })).toBe('4mo ago');
		expect(age({ timeValue: 5, timeUnit: 'hour' })).toBe('5h ago');
		expect(age({ timeValue: 30, timeUnit: 'minute' })).toBe('Just now');
		expect(age({ timeValue: 0, timeUnit: 'day', edited: true })).toBe('edited just now');
		const r = render(at({ ...IOS, rating: 1 }, 100));
		const c = r.container;
		expect(part(c, 'title')!.textContent).toBe('Review title');
		expect(part(c, 'name')!.textContent).toBe('Display Name');
		expect(stars(c)).toEqual(['filled', 'empty', 'empty', 'empty', 'empty']);
		const d = [...c.querySelectorAll('[data-part="stars"] path')].map((p) => p.getAttribute('d'));
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
			for (let f = 0; f <= 60; f++) {
				const r = render(at(p, f));
				seen.add(stars(r.container).join(','));
				const row = part(r.container, 'stars')!;
				expect(row.style.boxShadow, `${variant} ${f}`).toBe(INK_RING);
				r.unmount();
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
				const r = render(at(p, 40 + k));
				const tf = part(r.container, 'stars')!.style.transform;
				r.unmount();
				return /scale\(1\.\d+\)/.test(tf);
			});
			expect(pulse, variant).toBe(true);
			const rest = render(at(p, 100));
			expect(part(rest.container, 'stars')!.style.transform).toBe('none');
			expect(stars(rest.container)).toEqual(['filled', 'filled', 'filled', 'filled', 'empty']);
			rest.unmount();
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

describe('long-review clamp (layout stubbed: happy-dom has none)', () => {
	// a fake layout: every word unit is 40 px wide on a 50 px pitch, 5 per line; the text block holds them all
	const LINE: Record<string, number> = {
		'play-store-review': 22.27,
		'app-store-review': 18,
		'app-store-review-ios': 20,
	};
	let restore: (() => void) | null = null;
	const stubLayout = (line: number) => {
		const proto = HTMLElement.prototype;
		const saved = ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'clientHeight'].map(
			(k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
		);
		const unit = (el: HTMLElement) => (el.dataset.unit === undefined ? null : Number(el.dataset.unit));
		const isText = (el: HTMLElement) => el.getAttribute('data-template-param') === 'text';
		const units = (el: HTMLElement) => el.querySelectorAll('[data-unit]').length;
		Object.defineProperty(proto, 'offsetTop', {
			configurable: true,
			get(this: HTMLElement) {
				const u = unit(this);
				return u === null ? 0 : Math.floor(u / 5) * line + 2;
			},
		});
		Object.defineProperty(proto, 'offsetLeft', {
			configurable: true,
			get(this: HTMLElement) {
				const u = unit(this);
				return u === null ? 0 : (u % 5) * 50;
			},
		});
		Object.defineProperty(proto, 'offsetWidth', {
			configurable: true,
			get(this: HTMLElement) {
				if (unit(this) !== null) return 40;
				return isText(this) ? 300 : 0;
			},
		});
		Object.defineProperty(proto, 'offsetHeight', {
			configurable: true,
			get(this: HTMLElement) {
				if (unit(this) !== null) return line - 4;
				return isText(this) ? Math.ceil(units(this) / 5) * line : 0;
			},
		});
		Object.defineProperty(proto, 'clientHeight', {
			configurable: true,
			get(this: HTMLElement) {
				const max = Number.parseFloat(this.style.maxHeight);
				const text = this.firstElementChild as HTMLElement | null;
				if (!text || !isText(text)) return 0;
				const h = text.offsetHeight;
				return Number.isFinite(max) ? Math.min(max, h) : h;
			},
		});
		restore = () => {
			for (const [k, d] of saved)
				if (d) Object.defineProperty(proto, k, d);
				else delete (proto as unknown as Record<string, unknown>)[k];
		};
	};
	afterEach(() => {
		restore?.();
		restore = null;
	});
	const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

	it('Play: three lines, the fade ending where the last visible line ends; none when it fits or truncate is off', () => {
		stubLayout(LINE['play-store-review']!);
		// 4 lines of words (the 4th line has 2): cut after 3; the 3rd line's last word ends at 4·50 + 40 = 240 of 300
		const r = render(at({ ...PLAY, text: words(17) }, 100));
		const clamp = part(r.container, 'clamp')!;
		expect(clamp.getAttribute('data-clamped')).toBe('true');
		const fade = part(r.container, 'fade')!;
		expect(fade.style.left).toBe('calc(80% - 29.8px)');
		expect(fade.style.top).toBe('66.667%');
		r.unmount();
		const fits = render(at({ ...PLAY, text: words(15) }, 100));
		expect(part(fits.container, 'fade')).toBeNull();
		fits.unmount();
		const off = render(at({ ...PLAY, text: words(30), truncate: false }, 100));
		expect(part(off.container, 'fade')).toBeNull();
		expect(part(off.container, 'clamp')!.firstElementChild!.getAttribute('style') ?? '').not.toMatch(
			/max-height/,
		);
		off.unmount();
	});

	it('App Store: four (web) / five (iPhone) lines, a "more" and the last-line mask when cut', () => {
		for (const [variant, lines] of [
			['app-store-review', 4],
			['app-store-review-ios', 5],
		] as const) {
			stubLayout(LINE[variant]!);
			const base = { ...socialDefaults(variant), truncate: true };
			const cut = render(at({ ...base, text: words(lines * 5 + 1) }, 100));
			expect(part(cut.container, 'more')!.textContent, variant).toBe('more');
			const box = part(cut.container, 'clamp')!.firstElementChild as HTMLElement;
			expect(box.style.maxHeight, variant).toBe(`${lines * LINE[variant]!}px`);
			expect(box.getAttribute('style'), variant).toMatch(/mask-image/);
			cut.unmount();
			const fits = render(at({ ...base, text: words(lines * 5) }, 100));
			expect(part(fits.container, 'more'), variant).toBeNull();
			expect(
				(part(fits.container, 'clamp')!.firstElementChild as HTMLElement).getAttribute('style'),
			).not.toMatch(/mask-image/);
			fits.unmount();
			restore?.();
			restore = null;
		}
	});
});
