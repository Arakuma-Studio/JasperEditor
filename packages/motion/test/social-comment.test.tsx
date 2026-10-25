// social-comment@1 implementation (happy-dom): the variant cards, the shared parts (avatars, glyphs, comment text with
// marks / mentions / emoji, counts), the extras (word reveal, like tick) at their frames, seek-order independence and
// the fit zoom. Real-Chrome layout (fit on every canvas, renderStill = renderFrames) is social-comment-render.e2e.
import {
	animeTemplateTiming,
	generatedAvatar,
	isReviewVariant,
	REMOTE_IMAGE_IDS,
	SOCIAL_VARIANTS,
	socialComment,
	socialCommentParamsSchema,
	socialCommentSegments,
	socialDefaults,
} from '@jasper/mg-templates';
import { act, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';
import {
	INSTAGRAM_GLYPHS,
	TIKTOK_DEFAULT_AVATAR,
	X_GLYPHS,
	YOUTUBE_GLYPHS,
} from '../src/templates/social/glyphs.ts';
import type { SocialCardAssets } from '../src/templates/social-comment/contract.ts';
import { INSTAGRAM_DEFAULT_AVATAR } from '../src/templates/social-comment/instagram.tsx';
import { CommentText, Glyph, SocialAvatar } from '../src/templates/social-comment/parts.tsx';
import { socialFitZoom } from '../src/templates/social-comment/stage.tsx';
import { socialVariantAvailable } from '../src/templates/social-comment/variants.ts';
import { xActionLayout, xActionsWidth } from '../src/templates/social-comment/x.tsx';

const Impl = ANIME_TEMPLATE_IMPLS['social-comment@1']!;

// Remotion counts NODE_ENV=test as a render (a missing emoji would cancel it): these tests are the Player's
// behaviour. happy-dom reports every image as complete at once; a browser does so only once it loaded or broke.
const completeDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
beforeEach(() => {
	vi.stubEnv('NODE_ENV', 'development');
	Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => false });
});
afterEach(() => {
	vi.unstubAllEnvs();
	if (completeDesc) Object.defineProperty(HTMLImageElement.prototype, 'complete', completeDesc);
});
const EMOJI_URLS = { 'apple:😊': '/fonts/emoji/apple/419/1f60a.png' };
const fps = 30;
const FRAMES = 150;

function at(params: Record<string, unknown>, frame: number, extra: Record<string, unknown> = {}) {
	const t = animeTemplateTiming(socialComment, { fps, localFrame: frame, durationFrames: FRAMES });
	return (
		<Impl
			params={socialCommentParamsSchema.parse(params)}
			{...t}
			fps={fps}
			canvas={{ width: 1080, height: 1920 }}
			seed={7}
			isPreview={false}
			mediaUrls={{}}
			emojiUrls={EMOJI_URLS}
			imageUrls={{}}
			{...extra}
		/>
	);
}
const html = (params: Record<string, unknown>, frame: number, extra?: Record<string, unknown>) => {
	const r = render(at(params, frame, extra));
	const out = r.container.innerHTML;
	r.unmount();
	return out;
};
const ASSETS: SocialCardAssets = {
	mediaUrls: { med_a: 'http://x/a.png' },
	imageUrls: {},
	emojiUrls: { 'apple:😊': 'http://x/1f60a.png' },
	emojiPack: 'apple',
	idScope: 't',
};

describe('social-comment@1 cards', () => {
	it('draws every variant\'s card in both themes (a variant without one would draw a visible "not available" card)', () => {
		for (const variant of SOCIAL_VARIANTS)
			for (const theme of ['light', 'dark']) {
				const r = render(at({ ...socialDefaults(variant), theme }, 100));
				const card = r.container.querySelector('[data-social-variant]')!;
				expect(card.getAttribute('data-social-variant')).toBe(variant);
				if (
					variant.startsWith('tiktok') ||
					variant.startsWith('instagram') ||
					variant.startsWith('youtube') ||
					variant === 'x-post' ||
					isReviewVariant(variant)
				) {
					expect(socialVariantAvailable(variant)).toBe(true);
					expect(card.hasAttribute('data-social-unavailable')).toBe(false);
				} else {
					expect(socialVariantAvailable(variant)).toBe(false);
					expect(r.container.textContent).toMatch(/not available yet/);
				}
				r.unmount();
			}
	});

	it('TikTok reply: "Reply to <name>\'s comment", the badge only when verified, the bubble tail', () => {
		const r = render(at({ displayName: 'Luna', verified: true }, 100));
		const header = r.container.querySelector('[data-part="header"]')!;
		expect(header.textContent).toBe("Reply to Luna's comment");
		expect(header.querySelectorAll('svg')).toHaveLength(1);
		expect(r.container.querySelectorAll('svg path[d^="M0 -0.5H25.5"]')).toHaveLength(1);
		r.unmount();
		const plain = render(at({ displayName: 'Luna' }, 100));
		expect(plain.container.querySelector('[data-part="header"] svg')).toBeNull();
		plain.unmount();
	});

	it('TikTok comment: formatted time, likes and replies; 0 replies hides the row; huge counts stay short', () => {
		const base = { ...socialDefaults('tiktok-comment') };
		const r = render(at(base, 100));
		expect(r.container.querySelector('[data-part="likes"]')!.textContent).toBe('1,393');
		expect(r.container.querySelector('[data-part="meta"]')!.textContent).toContain('1d');
		expect(r.container.querySelector('[data-part="replies"]')!.textContent).toBe('View 2 replies');
		r.unmount();
		const none = render(at({ ...base, replies: 0 }, 100));
		expect(none.container.querySelector('[data-part="replies"]')).toBeNull();
		none.unmount();
		const huge = render(at({ ...base, likes: 987_654_321_000, replies: 4_812_345 }, 100));
		expect(huge.container.querySelector('[data-part="likes"]')!.textContent).toBe('987.6B');
		expect(huge.container.querySelector('[data-part="replies"]')!.textContent).toBe('View 4.8M replies');
		huge.unmount();
	});

	it('showProfile false hides the avatar; the name and text remain (inline-editing attributes on them)', () => {
		const r = render(at({ ...socialDefaults('tiktok-comment'), showProfile: false }, 100));
		expect(r.container.querySelector('[data-social-avatar]')).toBeNull();
		expect(r.container.querySelector('[data-template-param="displayName"]')!.textContent).toBe('username');
		expect(
			r.container.querySelector('[data-template-param="text"][data-template-marks="true"]'),
		).not.toBeNull();
		r.unmount();
	});

	it('invalid params fall back to the defaults instead of throwing', () => {
		const t = animeTemplateTiming(socialComment, { fps, localFrame: 100, durationFrames: FRAMES });
		const r = render(
			<Impl
				params={{ variant: 'myspace', likes: -1 }}
				{...t}
				fps={fps}
				canvas={{ width: 1920, height: 1080 }}
				seed={1}
				isPreview
				mediaUrls={{}}
				emojiUrls={{}}
				imageUrls={{}}
			/>,
		);
		expect(r.container.querySelector('[data-social-variant="tiktok-reply"]')).not.toBeNull();
		r.unmount();
	});
});

describe('social-comment@1 Instagram cards', () => {
	const post = socialDefaults('instagram-post');
	const reel = socialDefaults('instagram-reel-reply');
	const q = (c: HTMLElement, sel: string) => c.querySelector<HTMLElement>(sel);
	/** A CSS colour as `#rrggbb` (happy-dom keeps hex as written, browsers report rgb()). */
	const hex = (color: string) => {
		const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
		return m
			? `#${m
					.slice(1)
					.map((n) => Number(n).toString(16).padStart(2, '0'))
					.join('')}`
			: color.toLowerCase();
	};

	it('post comment: handle, time, likes and "View N more replies" with tokcomment\'s defaults; the badge only when verified', () => {
		const r = render(at(post, 100));
		const c = r.container;
		expect(q(c, '[data-part="name"]')!.getAttribute('data-template-param')).toBe('handle');
		expect(q(c, '[data-part="name"]')!.textContent).toBe('username');
		expect(q(c, '[data-part="time"]')!.textContent).toBe('2w');
		expect(q(c, '[data-part="header"]')!.querySelector('svg')).toBeNull();
		expect(q(c, '[data-part="meta"]')!.textContent).toBe('Reply');
		expect(q(c, '[data-part="likes"]')!.textContent).toBe('114');
		expect(q(c, '[data-part="replies"]')!.textContent).toBe('View 5 more replies');
		// the outline heart (Instagram's own glyph), no filled heart without the like tick
		expect(q(c, '[data-part="heart"]')!.innerHTML).toContain(INSTAGRAM_GLYPHS.heartOutline.paths[0]!.d);
		expect(q(c, '[data-part="heart"]')!.innerHTML).not.toContain(INSTAGRAM_GLYPHS.heartFilled.paths[0]!.d);
		r.unmount();
		const v = render(at({ ...post, verified: true }, 100));
		const badge = v.container.querySelector('[data-part="header"] svg')!;
		expect(badge.innerHTML).toContain(INSTAGRAM_GLYPHS.verified.paths[0]!.d);
		v.unmount();
	});

	it('post comment: counts per Instagram; 1 reply is singular; 0 replies hides the row; 0 likes shows no number', () => {
		const one = render(at({ ...post, replies: 1, likes: 9_999 }, 100));
		expect(q(one.container, '[data-part="replies"]')!.textContent).toBe('View 1 more reply');
		expect(q(one.container, '[data-part="likes"]')!.textContent).toBe('9,999');
		one.unmount();
		const none = render(at({ ...post, replies: 0, likes: 0 }, 100));
		expect(q(none.container, '[data-part="replies"]')).toBeNull();
		expect(q(none.container, '[data-part="likes"]')).toBeNull();
		expect(q(none.container, '[data-part="heart"]')).not.toBeNull();
		none.unmount();
		const huge = render(at({ ...post, likes: 987_654_321_000, replies: 4_812_345 }, 100));
		expect(q(huge.container, '[data-part="likes"]')!.textContent).toBe('987.6B');
		expect(q(huge.container, '[data-part="replies"]')!.textContent).toBe('View 4.8M more replies');
		// the like column keeps its width, so a long count never narrows the comment
		expect(q(huge.container, '[data-part="like"]')!.style.width).toBe('25.6px');
		huge.unmount();
		for (const [timeValue, timeUnit, shown] of [
			[3, 'minute', '3m'],
			[3, 'hour', '3h'],
			[3, 'day', '3d'],
			[56, 'week', '56w'],
			[3, 'month', '3mo'],
			[3, 'year', '3y'],
			[0, 'day', 'now'],
		] as const) {
			const t = render(at({ ...post, timeValue, timeUnit }, 100));
			expect(q(t.container, '[data-part="time"]')!.textContent).toBe(shown);
			t.unmount();
		}
	});

	it('dark theme: the username is light on the dark card (tokcomment drew it black), mentions in --ig-link', () => {
		for (const [theme, name, link] of [
			['light', '#000000', '#00376b'],
			['dark', '#ffffff', '#e0f1ff'],
		] as const) {
			const r = render(at({ ...post, theme, text: 'hi @luna.park #fyp' }, 100));
			expect(hex(q(r.container, '[data-part="name"]')!.style.color)).toBe(name);
			const colored = [...r.container.querySelectorAll<HTMLElement>('[data-template-param="text"] span')]
				.filter((s) => s.style.color)
				.map((s) => [s.textContent, hex(s.style.color)]);
			expect(colored).toEqual([
				['@luna.park', link],
				['#fyp', link],
			]);
			r.unmount();
		}
	});

	it("avatars: Instagram's default look for null, initials from the handle for a generated one, showProfile hides it", () => {
		const d = render(at(post, 100));
		const def = q(d.container, '[data-social-avatar="default"]')!;
		const paths = [...def.querySelectorAll('path')].map((el) => [
			el.getAttribute('d'),
			el.getAttribute('fill'),
		]);
		expect(paths).toEqual([
			[INSTAGRAM_DEFAULT_AVATAR.disc, '#C7C7C7'],
			[INSTAGRAM_DEFAULT_AVATAR.head, '#FFFFFF'],
			[INSTAGRAM_DEFAULT_AVATAR.shoulders, '#FFFFFF'],
		]);
		d.unmount();
		const g = render(at({ ...post, avatar: { generated: 3 }, handle: 'zed.wolf' }, 100));
		expect(q(g.container, '[data-social-avatar="generated"]')).not.toBeNull();
		g.unmount();
		const m = render(
			at({ ...reel, avatar: { mediaId: 'med_a' } }, 100, { mediaUrls: { med_a: 'http://x/a.png' } }),
		);
		expect(m.container.innerHTML).toContain('src="http://x/a.png"');
		m.unmount();
		for (const params of [post, reel]) {
			const r = render(at({ ...params, showProfile: false }, 100));
			expect(q(r.container, '[data-social-avatar]')).toBeNull();
			expect(q(r.container, '[data-template-param="handle"]')!.textContent).toBe('username');
			expect(q(r.container, '[data-template-param="text"][data-template-marks="true"]')).not.toBeNull();
			r.unmount();
		}
	});

	it('like tick: the count rises to the final value, then the heart is filled in Instagram red (hold state)', () => {
		const p = { ...post, likeTick: true, likes: 12_345 };
		const view = render(at(p, 0));
		const shown = () => q(view.container, '[data-part="likes"]')!.textContent;
		expect(shown()).toBe('0');
		const seen = new Set<string>();
		for (let f = 1; f <= 60; f++) {
			act(() => view.rerender(at(p, f)));
			seen.add(shown()!);
		}
		expect(shown()).toBe('12.3K');
		expect(seen.size).toBeGreaterThan(10);
		const svgs = q(view.container, '[data-part="heart"]')!.querySelectorAll<SVGElement>('svg');
		expect(svgs).toHaveLength(2);
		expect(svgs[1]!.style.opacity).toBe('1');
		expect(hex(svgs[1]!.style.color)).toBe('#ff3040');
		view.unmount();
	});

	it('Reels reply: the comment and "Replying to <handle>", no stats, no badge, at most 255 px wide', () => {
		const r = render(at({ ...reel, verified: true, likeTick: true }, 100));
		const c = r.container;
		const card = q(c, '[data-social-variant="instagram-reel-reply"]')!;
		expect(card.style.maxWidth).toBe('255px');
		expect(q(c, '[data-part="replying"]')!.textContent).toBe('Replying to username');
		expect(q(c, '[data-part="replying"] [data-template-param="handle"]')!.textContent).toBe('username');
		// the only drawing is the default avatar: no badge, heart or count
		expect([...c.querySelectorAll('svg')].every((svg) => svg.closest('[data-social-avatar]'))).toBe(true);
		expect(q(c, '[data-part="likes"]')).toBeNull();
		// the emoji is an image of the Apple pack (EmojiImage), never a host-font glyph
		expect(q(c, '[data-template-param="text"]')!.textContent).toBe('Write any comment and see what happens ');
		expect(q(c, '[data-template-param="text"] img[data-emoji="😊"]')).not.toBeNull();
		r.unmount();
	});

	it('grow from tail grows from the avatar corner on both cards', () => {
		for (const params of [post, reel]) {
			const r = render(at({ ...params, entrance: 'grow-from-tail' }, 4));
			expect(q(r.container, '[data-social-card]')!.style.transformOrigin).toBe('0% 0%');
			r.unmount();
		}
	});
});

describe('social-comment@1 YouTube cards', () => {
	const yt = socialDefaults('youtube-comment');
	const shorts = socialDefaults('youtube-shorts-reply');
	const q = (c: HTMLElement, part: string) => c.querySelector(`[data-part="${part}"]`);

	it('comment: "@handle", the badge only when verified, "N units ago", likes, "N replies" with the thread line', () => {
		const r = render(at({ ...yt, handle: 'luna.makes', verified: true }, 100));
		const c = r.container;
		expect(q(c, 'name')!.textContent).toBe('@luna.makes');
		// the editable element holds exactly the handle (the "@" is outside it, contract C5)
		expect(c.querySelector('[data-template-param="handle"]')!.textContent).toBe('luna.makes');
		expect(q(c, 'header')!.querySelectorAll('svg')).toHaveLength(1);
		expect(q(c, 'header')!.innerHTML).toContain(YOUTUBE_GLYPHS.verified.paths[0]!.d);
		expect(q(c, 'time')!.textContent).toBe('10 months ago');
		expect(q(c, 'likes')!.textContent).toBe('72');
		expect(q(c, 'replies')!.textContent).toBe('2 replies');
		expect(q(c, 'thread')).not.toBeNull();
		for (const g of ['thumbUp', 'thumbDown', 'reply', 'more', 'chevronDown'] as const)
			expect(c.innerHTML, g).toContain(YOUTUBE_GLYPHS[g].paths[0]!.d);
		r.unmount();
		const plain = render(at(yt, 100));
		expect(q(plain.container, 'header')!.querySelector('svg')).toBeNull();
		plain.unmount();
	});

	it('comment: months stay months, 1 reply is singular, 0 replies hides the row and the thread line (tokcomment bugs)', () => {
		const r = render(at({ ...yt, timeValue: 3, timeUnit: 'month', replies: 1 }, 100));
		expect(q(r.container, 'time')!.textContent).toBe('3 months ago');
		expect(q(r.container, 'replies')!.textContent).toBe('1 reply');
		r.unmount();
		const none = render(at({ ...yt, replies: 0, timeValue: 0 }, 100));
		expect(q(none.container, 'replies')).toBeNull();
		expect(q(none.container, 'thread')).toBeNull();
		expect(none.container.textContent).not.toMatch(/0 replies/);
		expect(q(none.container, 'time')!.textContent).toBe('Just now');
		none.unmount();
	});

	it('comment: huge counts stay short (no overflow), formatted the YouTube way', () => {
		const r = render(at({ ...yt, likes: 987_654_321_000, replies: 4_812_345 }, 100));
		expect(q(r.container, 'likes')!.textContent).toBe('987B');
		expect(q(r.container, 'replies')!.textContent).toBe('4.8M replies');
		r.unmount();
		const k = render(at({ ...yt, likes: 1_234_567, replies: 1_299 }, 100));
		expect(q(k.container, 'likes')!.textContent).toBe('1.2M');
		expect(q(k.container, 'replies')!.textContent).toBe('1.2K replies');
		k.unmount();
	});

	it('comment: showProfile false hides the avatar and the thread line; name and text stay editable', () => {
		const r = render(at({ ...yt, showProfile: false }, 100));
		expect(r.container.querySelector('[data-social-avatar]')).toBeNull();
		expect(q(r.container, 'thread')).toBeNull();
		expect(r.container.querySelector('[data-template-param="handle"]')!.textContent).toBe('Username');
		expect(
			r.container.querySelector('[data-template-param="text"][data-template-marks="true"]'),
		).not.toBeNull();
		r.unmount();
	});

	it('avatars: YouTube default picture by its manifest id (silhouette until delivered), a picture, generated initials from the handle', () => {
		const id = REMOTE_IMAGE_IDS.youtubeDefaultAvatar;
		for (const variant of ['youtube-comment', 'youtube-shorts-reply'] as const) {
			const base = socialDefaults(variant);
			const missing = render(at(base, 100));
			const el = missing.container.querySelector('[data-social-avatar="default"]')!;
			expect(el.querySelector('img')).toBeNull();
			expect(el.querySelector('svg')).not.toBeNull();
			missing.unmount();
			const raster = render(at(base, 100, { imageUrls: { [id]: 'http://engine/yt-default.jpg' } }));
			expect(
				raster.container.querySelector('img[data-testid="social-avatar-media"]')!.getAttribute('src'),
			).toBe('http://engine/yt-default.jpg');
			raster.unmount();
			const pic = render(
				at({ ...base, avatar: { mediaId: 'med_a' } }, 100, { mediaUrls: { med_a: 'http://x/a.png' } }),
			);
			expect(pic.container.innerHTML).toContain('src="http://x/a.png"');
			pic.unmount();
			// YouTube shows the handle, so a generated avatar's initials come from it (not the hidden display name)
			const seed = [...Array(64).keys()].find((n) => generatedAvatar(n, 'zed').style === 'initials')!;
			const gen = render(
				at({ ...base, avatar: { generated: seed }, handle: 'zed', displayName: 'Amy Bo' }, 100),
			);
			const g = gen.container.querySelector('[data-social-avatar="generated"]')!;
			expect(g.textContent).toBe(generatedAvatar(seed, 'zed').initials);
			expect(g.textContent).not.toBe(generatedAvatar(seed, 'Amy Bo').initials);
			gen.unmount();
		}
	});

	it('comment: mentions and hashtags in YouTube link blue per theme; emoji as Noto images by default', () => {
		const text = 'hi @bob #fyp 😊';
		for (const [theme, color] of [
			['light', '#065FD4'],
			['dark', '#3EA6FF'],
		] as const) {
			const r = render(
				at({ ...yt, theme, text }, 100, { emojiUrls: { 'noto:😊': 'http://x/noto/1f60a.png' } }),
			);
			const colored = [...r.container.querySelectorAll<HTMLElement>('[data-template-param="text"] span')]
				.filter((sp) => sp.style.color && !sp.hasAttribute('data-unit'))
				.map((sp) => [sp.textContent, sp.style.color]);
			expect(colored).toEqual([
				['@bob', color],
				['#fyp', color],
			]);
			expect(r.container.querySelector('img[data-emoji="😊"]')!.getAttribute('src')).toBe(
				'http://x/noto/1f60a.png',
			);
			r.unmount();
		}
	});

	it('comment like tick: the count rises, then the thumb is filled (hold state)', () => {
		const p = { ...yt, likeTick: true, likes: 12_345 };
		const view = render(at(p, 0));
		expect(q(view.container, 'likes')!.textContent).toBe('0');
		for (let f = 1; f <= 60; f++) act(() => view.rerender(at(p, f)));
		expect(q(view.container, 'likes')!.textContent).toBe('12K');
		const icon = q(view.container, 'like-icon')!;
		const svgs = icon.querySelectorAll<SVGElement>('svg');
		expect(svgs).toHaveLength(2);
		expect(svgs[1]!.innerHTML).toContain(YOUTUBE_GLYPHS.thumbUpFilled.paths[0]!.d);
		expect(svgs[1]!.style.opacity).toBe('1');
		expect(svgs[0]!.style.opacity).toBe('0');
		// the widest counts it passes through reserve the width (the buttons after it never move during the tick)
		const reserved = [
			...q(view.container, 'likes')!.parentElement!.querySelectorAll('[aria-hidden="true"]'),
		].map((e) => e.textContent);
		expect(reserved).toEqual(['12K', '9', '99', '999', '9.9K']);
		view.unmount();
	});

	it('Shorts card: "Comment from @handle", no stats, no badge, no like tick; showProfile hides the avatar', () => {
		const r = render(at({ ...shorts, verified: true, likeTick: true, handle: 'luna' }, 100));
		const c = r.container;
		expect(q(c, 'header')!.textContent).toBe('Comment from @luna');
		expect(c.querySelector('[data-template-param="handle"]')!.textContent).toBe('luna');
		expect(q(c, 'header')!.querySelector('svg')).toBeNull();
		for (const part of ['likes', 'time', 'replies', 'thread', 'like-icon'])
			expect(q(c, part), part).toBeNull();
		expect(c.querySelector('[data-social-avatar]')).not.toBeNull();
		r.unmount();
		const bare = render(at({ ...shorts, showProfile: false }, 100));
		expect(bare.container.querySelector('[data-social-avatar]')).toBeNull();
		expect(q(bare.container, 'header')!.textContent).toBe('Comment from @Username');
		bare.unmount();
	});

	it('Shorts card: a long handle stays on one line (ellipsis), the card stays at most 305 reference px wide', () => {
		const r = render(at({ ...shorts, handle: 'x'.repeat(64) }, 100));
		const header = q(r.container, 'header') as HTMLElement;
		expect(header.style.whiteSpace).toBe('nowrap');
		expect(header.style.textOverflow).toBe('ellipsis');
		const card = r.container.querySelector<HTMLElement>('[data-social-variant="youtube-shorts-reply"]')!;
		expect(card.style.maxWidth).toBe('305px');
		r.unmount();
	});
});

describe('social-comment@1 X post card', () => {
	const X = socialDefaults('x-post');
	const view = (params: Record<string, unknown>, extra?: Record<string, unknown>, frame = 100) =>
		render(at({ ...X, ...params }, frame, extra));
	const part = (c: HTMLElement, name: string) => c.querySelector<HTMLElement>(`[data-part="${name}"]`);

	it('header: bold name, @handle, "·", compact time, the blue badge only when verified, Grok and More', () => {
		const r = view({ displayName: 'Luna Park', handle: 'lunapark', verified: true });
		const c = r.container;
		expect(c.querySelector('[data-social-variant="x-post"]')).not.toBeNull();
		expect(part(c, 'name')!.textContent).toBe('Luna Park');
		expect(part(c, 'name')!.style.fontWeight).toBe('700');
		expect(part(c, 'handle')!.textContent).toBe('@lunapark');
		expect(part(c, 'time')!.textContent).toBe('2h');
		const d = (g: { paths: readonly { d: string }[] }) => g.paths[0]!.d;
		const header = part(c, 'header')!;
		expect(header.querySelector(`path[d="${d(X_GLYPHS.verifiedBlue)}"]`)).not.toBeNull();
		expect(header.querySelector(`path[d="${d(X_GLYPHS.grok)}"]`)).not.toBeNull();
		expect(header.querySelector(`path[d="${d(X_GLYPHS.more)}"]`)).not.toBeNull();
		r.unmount();
		const plain = view({});
		expect(plain.container.querySelector(`path[d="${d(X_GLYPHS.verifiedBlue)}"]`)).toBeNull();
		plain.unmount();
	});

	it('inline editing: displayName, handle (without the "@") and the marked text are editable elements', () => {
		const r = view({ displayName: 'Luna 🌙', handle: 'luna' });
		const c = r.container;
		// the emoji is an image of the pack (here not delivered: the visible "?" marker)
		expect(c.querySelector('[data-template-param="displayName"]')!.textContent).toBe('Luna ?');
		expect(c.querySelector('[data-template-param="handle"]')!.textContent).toBe('luna');
		expect(c.querySelector('[data-template-param="text"][data-template-marks="true"]')).not.toBeNull();
		r.unmount();
	});

	it("action bar: X's glyphs and formatted counts (45 · 12 · 1.2K · 12K), bookmark and share", () => {
		const r = view({});
		const c = r.container;
		expect(['replies', 'reposts', 'likes', 'views'].map((n) => part(c, n)!.textContent)).toEqual([
			'45',
			'12',
			'1.2K',
			'12K',
		]);
		const actions = part(c, 'actions')!;
		for (const g of ['reply', 'repost', 'like', 'views', 'bookmark', 'share'] as const)
			expect(actions.querySelector(`path[d="${X_GLYPHS[g].paths[0]!.d}"]`), g).not.toBeNull();
		// the secondary colour of x.com 2026 (rgba(0, 0, 0, .6)), not tokcomment's greys
		expect(part(c, 'likes')!.style.color).toBe('rgba(0, 0, 0, 0.6)');
		r.unmount();
	});

	it('showReposts / showViews hide their counts (the icons stay); zero counts show the icon alone', () => {
		const r = view({ showReposts: false, showViews: false });
		// the count goes, the icon stays (and the columns keep their places)
		for (const n of ['reposts', 'views']) {
			expect(part(r.container, n), n).toBeNull();
			expect(part(r.container, `${n}-action`)!.querySelector('svg'), n).not.toBeNull();
		}
		expect(part(r.container, 'replies')!.textContent).toBe('45');
		r.unmount();
		const zero = view({ replies: 0, reposts: 0, likes: 0, views: 0 });
		for (const n of ['replies', 'reposts', 'likes', 'views']) {
			expect(part(zero.container, n), n).toBeNull();
			expect(part(zero.container, `${n}-action`)!.querySelector('svg'), n).not.toBeNull();
		}
		zero.unmount();
	});

	it('huge counts stay short; columns get the room their counts need (no touching), and clip as a last guard', () => {
		const r = view({ replies: 1_234_567, reposts: 999_999_999_999, likes: 1e12, views: 987_654_321_000 });
		const c = r.container;
		expect(['replies', 'reposts', 'likes', 'views'].map((n) => part(c, n)!.textContent)).toEqual([
			'1.2M',
			'999.9B',
			'1,000B',
			'987.6B',
		]);
		// App QA N6: the bar is laid out for these counts (xActionLayout, test/social-x-fit.test.tsx measures it)
		// (the likes column for the widest count its tick passes: "999.9M" on the way to "1,000B")
		const bar = xActionLayout(['1.2M', '999.9B', '999.9M', '987.6B'], true);
		let total = 0;
		for (const [i, n] of ['replies', 'reposts', 'likes', 'views'].entries()) {
			const col = part(c, `${n}-action`)!;
			expect(col.style.flex).toBe('1 1 0px');
			expect(col.style.minWidth).toBe(`${bar.minWidths[i]}px`);
			expect(col.style.overflow).toBe('hidden');
			expect(part(c, n)!.style.fontSize).toBe(`${bar.countPx}px`);
			total += bar.minWidths[i]!;
		}
		expect(total).toBeLessThanOrEqual(xActionsWidth(true));
		r.unmount();
	});

	it('like tick: the count ticks up, then the heart fills and the count turns magenta (#F91880)', () => {
		const p = { ...X, likeTick: true, likes: 12_345 };
		const v = render(at(p, 0));
		const likes = () => v.container.querySelector<HTMLElement>('[data-part="likes"]');
		expect(likes()).toBeNull(); // 0 is not shown on X
		act(() => v.rerender(at(p, 25)));
		expect(Number(likes()!.textContent!.replace(/[^0-9.]/g, ''))).toBeGreaterThan(0);
		act(() => v.rerender(at(p, 100)));
		expect(likes()!.textContent).toBe('12.3K');
		expect(likes()!.style.color).toMatch(/^(#F91880|rgb\(249, 24, 128\))$/i);
		const icon = v.container.querySelector('[data-part="like-icon"]')!;
		const [outline, filled] = [...icon.querySelectorAll<SVGElement>('svg')];
		expect(outline!.style.opacity).toBe('0');
		expect(filled!.style.opacity).toBe('1');
		expect(filled!.querySelector('path')!.getAttribute('d')).toBe(X_GLYPHS.likeFilled.paths[0]!.d);
		v.unmount();
	});

	it('dark theme: black card, white name and text, white-60 secondary', () => {
		const r = view({ theme: 'dark' });
		const card = r.container.querySelector<HTMLElement>('[data-social-variant="x-post"]')!;
		expect(card.style.background).toMatch(/#000000|rgb\(0, 0, 0\)/i);
		expect(part(r.container, 'name')!.style.color).toMatch(/#FFFFFF|rgb\(255, 255, 255\)/i);
		expect(part(r.container, 'handle')!.style.color).toBe('rgba(255, 255, 255, 0.6)');
		r.unmount();
	});

	it('mentions and hashtags in X blue; emoji as Apple images (emojiStyle auto)', () => {
		const r = view(
			{ text: 'hi @friend #fyp 😊' },
			{ emojiUrls: { 'apple:😊': 'http://x/apple-1f60a.png', 'twemoji:😊': 'http://x/tw.svg' } },
		);
		const c = r.container;
		const colored = [...c.querySelectorAll<HTMLElement>('[data-template-param="text"] span')].filter(
			(s) => s.style.color && !s.hasAttribute('data-unit'),
		);
		const blue = (c: string) => (c.toUpperCase() === '#1D9BF0' ? 'rgb(29, 155, 240)' : c);
		expect(colored.map((s) => [s.textContent, blue(s.style.color)])).toEqual([
			['@friend', 'rgb(29, 155, 240)'],
			['#fyp', 'rgb(29, 155, 240)'],
		]);
		expect(c.querySelector('img[data-emoji="😊"]')!.getAttribute('src')).toBe('http://x/apple-1f60a.png');
		r.unmount();
	});

	it("avatars: X's default (manifest image when resolved, else its vector twin), picture, generated; showProfile", () => {
		const id = REMOTE_IMAGE_IDS.xDefaultAvatar;
		const resolved = view({}, { imageUrls: { [id]: 'http://engine/x-default.png' } });
		const def = resolved.container.querySelector('[data-social-avatar="default"]')!;
		expect(def.querySelector('img')!.getAttribute('src')).toBe('http://engine/x-default.png');
		resolved.unmount();
		const twin = view({});
		expect(
			twin.container.querySelector('[data-social-avatar="default"] svg rect')!.getAttribute('fill'),
		).toBe('#CCD6DD');
		twin.unmount();
		const pic = view({ avatar: { mediaId: 'med_a' } }, { mediaUrls: { med_a: 'http://x/a.png' } });
		expect(pic.getByTestId('social-avatar-media').getAttribute('src')).toBe('http://x/a.png');
		pic.unmount();
		const gen = view({ avatar: { generated: 42 }, displayName: 'Luna Park' });
		expect(gen.container.querySelector('[data-social-avatar="generated"]')).not.toBeNull();
		gen.unmount();
		const none = view({ showProfile: false });
		expect(none.container.querySelector('[data-social-avatar]')).toBeNull();
		expect(part(none.container, 'name')!.textContent).toBe('Display Name');
		none.unmount();
	});

	it('long names truncate (ellipsis) while the time and the header buttons never shrink', () => {
		const r = view({ displayName: 'W'.repeat(64), handle: 'w'.repeat(64), verified: true });
		const c = r.container;
		expect(part(c, 'name')!.style.textOverflow).toBe('ellipsis');
		expect(part(c, 'handle')!.style.textOverflow).toBe('ellipsis');
		expect(part(c, 'time')!.style.flexShrink).toBe('0');
		r.unmount();
	});

	it('every frame of the X card is a pure function of params and time (any visiting order)', () => {
		const p = { ...X, wordReveal: true, likeTick: true, entrance: 'drop-bounce', verified: true };
		const frames = [0, 5, 16, 24, 40, 100, 148];
		const fresh = new Map(frames.map((f) => [f, html(p, f)]));
		const v = render(at(p, frames[3]!));
		for (const f of [...frames].reverse()) {
			act(() => v.rerender(at(p, f)));
			expect(v.container.innerHTML).toBe(fresh.get(f));
		}
		v.unmount();
	});
});

describe('social-comment@1 animation', () => {
	it('hidden at frame 0, at rest in the hold, leaving at the end', () => {
		const style = (frame: number, entrance: string) => {
			const r = render(at({ entrance }, frame));
			const el = r.container.querySelector<HTMLElement>('[data-social-card]')!;
			const s = { opacity: el.style.opacity, transform: el.style.transform };
			r.unmount();
			return s;
		};
		for (const entrance of ['classic-pop', 'soft-spring', 'grow-from-tail', 'drop-bounce']) {
			expect(style(0, entrance).opacity, entrance).toBe('0');
			expect(style(60, entrance), entrance).toEqual({
				opacity: '1',
				transform: 'translateY(0px) rotate(0deg) scale(1)',
			});
			expect(Number(style(FRAMES - 1, entrance).opacity)).toBeLessThan(0.5);
		}
	});

	it('word reveal: words hidden until their turn, all shown in the hold', () => {
		const p = { wordReveal: true, text: 'one two three ==four five== six' };
		const units = (frame: number) => {
			const r = render(at(p, frame));
			const o = [...r.container.querySelectorAll<HTMLElement>('[data-unit]')].map((u) =>
				Number(u.style.opacity),
			);
			r.unmount();
			return o;
		};
		expect(socialCommentSegments(p.text, 'tiktok-reply').units).toBe(5);
		// the soft-spring entrance ends at 450 ms (frame 13.5); one word every 90 ms (2.7 frames) from there
		expect(units(13)).toEqual([0, 0, 0, 0, 0]);
		const mid = units(17);
		expect(mid[0]).toBeGreaterThan(0);
		expect(mid[4]).toBe(0);
		expect(units(100)).toEqual([1, 1, 1, 1, 1]);
	});

	it('like tick: the count rises 0 → final in formatted steps, then the heart is filled (hold state)', () => {
		const p = { ...socialDefaults('tiktok-comment'), likeTick: true, likes: 12_345 };
		const t = animeTemplateTiming(socialComment, { fps, localFrame: 0, durationFrames: FRAMES });
		const view = render(at(p, 0));
		const shown = () => view.container.querySelector('[data-part="likes"]')!.textContent;
		expect(shown()).toBe('0');
		const seen: string[] = [];
		for (let f = 1; f <= 60; f++) {
			act(() => view.rerender(at(p, f)));
			seen.push(shown()!);
		}
		expect(shown()).toBe('12.3K');
		expect(new Set(seen).size).toBeGreaterThan(10);
		const nums = seen.map((s) =>
			s.endsWith('K') ? Number.parseFloat(s) * 1000 : Number(s.replace(/,/g, '')),
		);
		for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]!);
		const filled =
			view.container.querySelectorAll<SVGElement>('[data-part="likes"]')[0]!.previousElementSibling!;
		expect(filled.querySelectorAll('svg')).toHaveLength(2);
		expect((filled.querySelectorAll('svg')[1] as SVGElement).style.opacity).toBe('1');
		view.unmount();
		expect(t.introMs).toBeGreaterThan(0);
	});

	it('every frame is a pure function of the params and the time, in any visiting order (fast-check)', () => {
		const p = {
			...socialDefaults('tiktok-comment'),
			wordReveal: true,
			likeTick: true,
			entrance: 'grow-from-tail',
		};
		const fresh = new Map<number, string>();
		const frames = [0, 3, 9, 17, 20, 30, 45, 60, 146, 149];
		for (const f of frames) fresh.set(f, html(p, f));
		fc.assert(
			fc.property(fc.shuffledSubarray(frames, { minLength: frames.length }), (order) => {
				const view = render(at(p, order[0]!));
				for (const f of order) {
					act(() => view.rerender(at(p, f)));
					expect(view.container.innerHTML).toBe(fresh.get(f));
				}
				view.unmount();
			}),
			{ numRuns: 8 },
		);
	});
});

describe('social-comment@1 shared parts', () => {
	it('avatars: picture (TemplateImage), missing picture placeholder, generated initials, TikTok default', () => {
		const one = (avatar: unknown) => {
			const r = render(
				<SocialAvatar
					avatar={avatar as never}
					platform="tiktok"
					size={50}
					name="Luna Park"
					fontFamily="x"
					assets={ASSETS}
				/>,
			);
			const out = r.container.innerHTML;
			r.unmount();
			return out;
		};
		expect(one({ mediaId: 'med_a' })).toContain('src="http://x/a.png"');
		expect(one({ mediaId: 'med_gone' })).toContain('data-template-image="placeholder"');
		expect(one({ generated: 42 })).toMatch(/data-social-avatar="generated"/);
		expect(one(null)).toContain(TIKTOK_DEFAULT_AVATAR.paths[0]!.d);
		expect(one({ generated: 42 })).toBe(one({ generated: 42 }));
	});

	it('glyphs draw every path, currentColor unless the path has its own fill', () => {
		const r = render(
			<Glyph
				glyph={{
					viewBox: '0 0 10 10',
					paths: [{ d: 'M0 0H1' }, { d: 'M1 1H2', fill: '#f00' }],
					origin: 'live-dom',
				}}
				size={10}
				color="#123"
			/>,
		);
		const paths = r.container.querySelectorAll('path');
		expect([...paths].map((p) => p.getAttribute('fill'))).toEqual(['currentColor', '#f00']);
		r.unmount();
	});

	it('comment text: highlight pill per run, blur, remove keeps the gap, mention / hashtag colours, emoji images', () => {
		const text = 'hi ==big deal== ||secret|| ~~gone~~ @bob #fyp 😊 🤔';
		const seg = socialCommentSegments(text, 'tiktok-comment');
		const r = render(
			<CommentText
				spans={seg.spans}
				segments={seg.segments}
				words={null}
				colors={{ mention: 'rgb(1, 2, 3)', hashtag: 'rgb(4, 5, 6)' }}
				emoji={{ size: 1.2, shift: -0.2 }}
				assets={ASSETS}
				style={{ fontSize: 20 }}
			/>,
		);
		const c = r.container;
		// the emoji are images (the missing one a "?" marker), the rest is text
		expect(c.textContent).toBe('hi big deal secret gone @bob #fyp  ?');
		const pill = [...c.querySelectorAll<HTMLElement>('[data-unit]')].find(
			(u) => u.textContent === 'big deal',
		)!;
		expect(pill.style.background).toMatch(/#FFE500|rgb\(255, 229, 0\)/i);
		const blurred = c.querySelector<HTMLElement>('[data-mark="blur"]')!;
		expect(blurred.style.textShadow).toBe('0 0 8px currentColor');
		expect(c.querySelector<HTMLElement>('[data-mark="remove"]')!.style.opacity).toBe('0');
		const colored = [
			...c.querySelectorAll<HTMLElement>('span:not([data-unit]):not([data-missing-asset])'),
		].filter((s) => s.style.color);
		expect(colored.map((s) => [s.textContent, s.style.color])).toEqual([
			['@bob', 'rgb(1, 2, 3)'],
			['#fyp', 'rgb(4, 5, 6)'],
		]);
		expect(c.querySelector('img[data-emoji="😊"]')!.getAttribute('src')).toBe('http://x/1f60a.png');
		// an emoji the pack does not deliver is a visible marker (EmojiImage → MissingAssetMarker), never a host glyph
		expect(c.querySelector('[data-missing-asset="emoji"]')!.getAttribute('aria-label')).toMatch(/🤔/);
		r.unmount();
	});

	it('fit zoom: the canvas scale unless the card is too tall or wide; a measured card at any zoom gives one answer', () => {
		const design = { width: 1080, height: 1920 };
		expect(socialFitZoom({ w: 0, h: 0 }, 1.8, 1.8, design)).toBe(1.8);
		expect(socialFitZoom({ w: 756, h: 300 }, 1.8, 1.8, design)).toBe(1.8);
		const tall = socialFitZoom({ w: 756, h: 5000 }, 1.8, 1.8, design);
		expect(tall).toBeLessThan(1.8);
		expect((5000 / 1.8) * tall).toBeLessThanOrEqual(1920 * 0.88 + 1);
		expect(socialFitZoom({ w: 420 * tall, h: (5000 / 1.8) * tall }, tall, 1.8, design)).toBeCloseTo(tall, 3);
	});
});
