// @vitest-environment node
// X card action bar fit (App QA N6: with six-character counts the repost count touched the like icon): counts of the
// longest formatted length, in every column and in all four at once, keep `X_COUNT_GAP` from the next icon and are
// never clipped. The budget (`xActionLayout`) is checked over every count; a real Chrome lays the card out and
// measures it — with Chirp when SOCIAL_CHIRP_DIR holds X's Regular woff2 (the remote-asset cache's
// `chirp-400-<hash>.woff2` or the manifest's `Chirp-Regular…woff2`), and always with the fallback face — and checks
// that the em bounds of `xCountEm` hold for the face drawn.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	animeTemplateTiming,
	formatCount,
	SOCIAL_VARIANT_FONTS,
	socialComment,
	socialCommentParamsSchema,
	socialDefaults,
} from '@jasper/mg-templates';
import { type Browser, chromium } from '@playwright/test';
import fc from 'fast-check';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';
import { X_COUNT_GAP, xActionLayout, xActionsWidth, xCountEm } from '../src/templates/social-comment/x.tsx';

const Impl = ANIME_TEMPLATE_IMPLS['social-comment@1']!;
const fmt = (n: number) => (n >= 1 ? formatCount('x-post', n, 'likes') : '');
/** The longest X counts: six characters ("999.9K", "999.9M", "999.9B", "1,000B" at the 1e12 cap). */
const LONGEST = [999_999, 999_999_999, 999_999_999_999, 1e12, 321_300] as const;
const COLUMNS = ['replies', 'reposts', 'likes', 'views'] as const;

describe('xActionLayout (the bar budget)', () => {
	it('the longest formatted counts are six characters, "999.9M" the widest', () => {
		for (const n of LONGEST) expect(fmt(n)).toHaveLength(6);
		const widest = [...LONGEST].map(fmt).sort((a, b) => xCountEm(b) - xCountEm(a))[0];
		expect(widest).toBe('999.9M');
	});

	it('one longest count in any column keeps x.com sizes (13 px, 8 px inset); all four still fit', () => {
		for (const showProfile of [true, false])
			for (let col = 0; col < 4; col++) {
				const counts = ['45', '12', '1.2K', '12K'];
				counts[col] = '999.9M';
				const l = xActionLayout(counts, showProfile);
				expect(l).toMatchObject({ countPx: 13, inset: 8 });
				expect(l.minWidths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(xActionsWidth(showProfile));
			}
		const all = xActionLayout(['999.9M', '999.9M', '999.9M', '999.9M'], true);
		expect(all.inset).toBe(4);
		expect(all.countPx).toBeGreaterThanOrEqual(12);
		expect(all.minWidths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(xActionsWidth(true));
		// the QA card (42.3K · 321.3K · 2.1M · 35.8M) keeps x.com's sizes
		expect(xActionLayout(['42.3K', '321.3K', '2.1M', '35.8M'], true)).toMatchObject({
			countPx: 13,
			inset: 8,
		});
	});

	it('every combination of counts fits the bar (fast-check)', () => {
		const count = fc.oneof(fc.constantFrom(0, ...LONGEST), fc.integer({ min: 0, max: 1e12 }));
		fc.assert(
			fc.property(fc.array(count, { minLength: 4, maxLength: 4 }), fc.boolean(), (ns, showProfile) => {
				const l = xActionLayout(ns.map(fmt), showProfile);
				expect(l.minWidths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(xActionsWidth(showProfile) + 1e-9);
				expect(l.countPx).toBeGreaterThanOrEqual(10);
				expect(l.countPx).toBeLessThanOrEqual(13);
			}),
			{ numRuns: 500 },
		);
	});
});

// ------------------------------------------------------------------------------------------------ real Chrome

const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

/** X's Regular face from SOCIAL_CHIRP_DIR (null when not given). */
function chirpRegular(): string | null {
	const dir = process.env.SOCIAL_CHIRP_DIR;
	if (!dir || !existsSync(dir)) return null;
	const file = readdirSync(dir).find((f) => /^chirp[-_]?(400|regular)\b.*\.woff2$/i.test(f));
	return file ? join(dir, file) : null;
}

function cardHtml(params: Record<string, unknown>): string {
	const t = animeTemplateTiming(socialComment, { fps: 30, localFrame: 100, durationFrames: 150 });
	return renderToStaticMarkup(
		<Impl
			params={socialCommentParamsSchema.parse(params)}
			{...t}
			fps={30}
			canvas={{ width: 1080, height: 1920 }}
			seed={7}
			isPreview={false}
			mediaUrls={{}}
			emojiUrls={{}}
			imageUrls={{}}
		/>,
	);
}

type Measured = { part: string; right: number; nextLeft: number; clipped: boolean; scale: number };

describe.skipIf(!CHROME)('X action bar in Chrome', { timeout: 60_000 }, () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await chromium.launch({ executablePath: CHROME, headless: true });
	});
	afterAll(async () => browser?.close());

	const faces = (): { name: string; css: string }[] => {
		const chirp = chirpRegular();
		const family = SOCIAL_VARIANT_FONTS['x-post']!.family;
		const out = [{ name: 'fallback face', css: '' }];
		if (chirp)
			out.push({
				name: 'Chirp',
				css: `@font-face{font-family:"${family}";font-weight:400;src:url(data:font/woff2;base64,${readFileSync(chirp).toString('base64')})}`,
			});
		else console.info('[x fit] SOCIAL_CHIRP_DIR not set: measured with the fallback face only');
		return out;
	};

	async function measure(css: string, params: Record<string, unknown>): Promise<Measured[]> {
		const page = await browser.newPage();
		try {
			await page.setContent(
				`<!doctype html><html><head><style>${css}</style></head><body style="margin:0">${cardHtml(params)}</body></html>`,
			);
			await page.evaluate(() => document.fonts.ready);
			return await page.evaluate(
				(parts) => {
					const out: Measured[] = [];
					const q = (sel: string) => document.querySelector<HTMLElement>(sel);
					const ends = q('[data-part="end-actions"]')!;
					for (let i = 0; i < parts.length; i++) {
						const count = q(`[data-part="${parts[i]}"]`);
						if (!count) continue;
						const col = q(`[data-part="${parts[i]}-action"]`)!;
						const next = i + 1 < parts.length ? q(`[data-part="${parts[i + 1]}-action"]`)! : ends;
						const icon = next.firstElementChild as HTMLElement;
						const r = count.getBoundingClientRect();
						out.push({
							part: parts[i]!,
							right: r.right,
							nextLeft: icon.getBoundingClientRect().left,
							clipped:
								count.scrollWidth > count.clientWidth + 0.5 ||
								r.right > col.getBoundingClientRect().right + 0.5,
							scale: col.getBoundingClientRect().width / col.offsetWidth,
						});
					}
					return out;
				},
				COLUMNS as unknown as string[],
			);
		} finally {
			await page.close();
		}
	}

	it('the em bounds of xCountEm hold for the faces drawn', async () => {
		for (const face of faces()) {
			const page = await browser.newPage();
			try {
				const family = SOCIAL_VARIANT_FONTS['x-post']!.family;
				await page.setContent(
					`<!doctype html><html><head><style>${face.css}</style></head><body></body></html>`,
				);
				const widths = await page.evaluate(
					async ({ family, chars }) => {
						await document.fonts.load(`400 100px "${family}"`);
						const out: Record<string, number> = {};
						for (const ch of chars) {
							const s = document.createElement('span');
							s.style.font = `400 100px "${family}", sans-serif`;
							s.style.fontVariantNumeric = 'tabular-nums';
							s.textContent = ch.repeat(10);
							document.body.appendChild(s);
							out[ch] = s.getBoundingClientRect().width / 1000;
							s.remove();
						}
						return out;
					},
					{ family, chars: [...'0123456789.,KMB'] },
				);
				for (const [ch, em] of Object.entries(widths))
					expect(em, `${face.name} ${ch}`).toBeLessThanOrEqual(xCountEm(ch));
			} finally {
				await page.close();
			}
		}
	});

	it('longest counts in each column and in all four keep the gap to the next icon, unclipped', async () => {
		const X = socialDefaults('x-post');
		const cases: Record<string, unknown>[] = [];
		for (const n of LONGEST) for (const c of COLUMNS) cases.push({ ...X, [c]: n, likeTick: false });
		for (const n of LONGEST)
			cases.push({ ...X, replies: n, reposts: n, likes: n, views: n, likeTick: false });
		cases.push({ ...X, replies: 42_300, reposts: 321_300, likes: 2_100_000, views: 35_800_000 }); // the QA card
		cases.push({
			...X,
			replies: 999_999_999,
			reposts: 999_999_999,
			likes: 999_999_999,
			views: 999_999_999,
			showProfile: false,
		});
		for (const face of faces())
			for (const params of cases) {
				const rows = await measure(face.css, params);
				expect(rows.length).toBeGreaterThan(0);
				for (const r of rows) {
					const what = `${face.name} ${r.part} ${JSON.stringify(params)}`;
					expect(r.clipped, what).toBe(false);
					expect((r.nextLeft - r.right) / r.scale, what).toBeGreaterThanOrEqual(X_COUNT_GAP - 0.5);
				}
			}
	});
});
