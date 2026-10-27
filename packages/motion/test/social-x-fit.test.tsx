// @vitest-environment node
// App QA N6: six-character counts must stay unclipped and at least 6 reference pixels before the next icon.
// Measure the public card in Chrome, with the fallback face and Chirp when SOCIAL_CHIRP_DIR supplies it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	animeTemplateTiming,
	SOCIAL_VARIANT_FONTS,
	socialComment,
	socialCommentParamsSchema,
	socialDefaults,
} from '@jasper/mg-templates';
import { type Browser, chromium, type Page } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';

const Impl = ANIME_TEMPLATE_IMPLS['social-comment@1']!;
/** The longest X counts: six characters ("999.9K", "999.9M", "999.9B", "1,000B" at the 1e12 cap). */
const LONGEST = [999_999, 999_999_999, 999_999_999_999, 1e12, 321_300] as const;
const COLUMNS = ['replies', 'reposts', 'likes', 'views'] as const;

const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find(
		(path) => existsSync(path),
	);

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

type Measured = {
	part: string;
	right: number;
	nextLeft: number;
	clipped: boolean;
	scale: number;
	countPx: number;
};

describe.skipIf(!CHROME)('X action bar in Chrome', { timeout: 60_000 }, () => {
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
		browser = await chromium.launch({ executablePath: CHROME, headless: true });
		page = await browser.newPage();
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
						countPx: Number.parseFloat(getComputedStyle(count).fontSize),
					});
				}
				return out;
			},
			COLUMNS as unknown as string[],
		);
	}

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
					expect(r.countPx, what).toBeGreaterThanOrEqual(10);
					expect((r.nextLeft - r.right) / r.scale, what).toBeGreaterThanOrEqual(5.5);
				}
			}
	});
});
