// social-comment@1 implementation (happy-dom): the variant cards, the shared parts (avatars, glyphs, comment text with
// marks / mentions / emoji, counts), the extras (word reveal, like tick) at their frames, seek-order independence and
// the fit zoom. Real-Chrome layout (fit on every canvas, renderStill = renderFrames) is social-comment-render.e2e.
import {
	animeTemplateTiming,
	SOCIAL_VARIANTS,
	socialComment,
	socialCommentParamsSchema,
	socialCommentSegments,
	socialDefaults,
} from '@jasper/mg-templates';
import { act, render } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';
import { TIKTOK_DEFAULT_AVATAR } from '../src/templates/social/glyphs.ts';
import { splitEmojiPieces } from '../src/templates/social-comment/assets.tsx';
import type { SocialCardAssets } from '../src/templates/social-comment/contract.ts';
import { CommentText, Glyph, SocialAvatar } from '../src/templates/social-comment/parts.tsx';
import { socialFitZoom } from '../src/templates/social-comment/stage.tsx';
import { socialVariantAvailable } from '../src/templates/social-comment/variants.ts';

const Impl = ANIME_TEMPLATE_IMPLS['social-comment@1']!;
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
	it('draws the TikTok cards in both themes and a visible "not available" card for the variants still to come', () => {
		for (const variant of SOCIAL_VARIANTS)
			for (const theme of ['light', 'dark']) {
				const r = render(at({ ...socialDefaults(variant), theme }, 100));
				const card = r.container.querySelector('[data-social-variant]')!;
				expect(card.getAttribute('data-social-variant')).toBe(variant);
				if (variant.startsWith('tiktok')) {
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
			/>,
		);
		expect(r.container.querySelector('[data-social-variant="tiktok-reply"]')).not.toBeNull();
		r.unmount();
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
		expect(c.textContent!.replace(/😊/, '')).toBe('hi big deal secret gone @bob #fyp  🤔');
		const pill = [...c.querySelectorAll<HTMLElement>('[data-unit]')].find(
			(u) => u.textContent === 'big deal',
		)!;
		expect(pill.style.background).toMatch(/#FFE500|rgb\(255, 229, 0\)/i);
		expect(c.querySelector<HTMLElement>('[data-mark="blur"]')!.style.filter).toBe('blur(4px)');
		expect(c.querySelector<HTMLElement>('[data-mark="remove"]')!.style.opacity).toBe('0');
		const colored = [...c.querySelectorAll<HTMLElement>('span:not([data-unit])')].filter(
			(s) => s.style.color,
		);
		expect(colored.map((s) => [s.textContent, s.style.color])).toEqual([
			['@bob', 'rgb(1, 2, 3)'],
			['#fyp', 'rgb(4, 5, 6)'],
		]);
		expect(c.querySelector('img[data-emoji="😊"]')!.getAttribute('src')).toBe('http://x/1f60a.png');
		// an emoji without an image of the pack is drawn as text (the emoji pack delivery marks it, contract C2)
		expect(c.querySelector('[data-emoji-text="🤔"]')).not.toBeNull();
		r.unmount();
	});

	it('emoji split: text runs and whole emoji graphemes (flags, ZWJ, keycaps, skin tones)', () => {
		expect(splitEmojiPieces('a👍🏽b🇵🇦👨‍👩‍👧1️⃣ c')).toEqual([
			{ kind: 'text', text: 'a' },
			{ kind: 'emoji', grapheme: '👍🏽' },
			{ kind: 'text', text: 'b' },
			{ kind: 'emoji', grapheme: '🇵🇦' },
			{ kind: 'emoji', grapheme: '👨‍👩‍👧' },
			{ kind: 'emoji', grapheme: '1️⃣' },
			{ kind: 'text', text: ' c' },
		]);
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
