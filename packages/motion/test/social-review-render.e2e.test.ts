// @vitest-environment node
// The store review cards of social-comment@1 (play-store-review, app-store-review, app-store-review-ios) in a real
// Chrome through Remotion (REMOTION_E2E=1), with the entry of social-comment-render.e2e.test.ts:
// - renderStill of a frame = the same frame of renderFrames while the entrance, the word reveal and the star fill run
//   (S11:ANM-014), with the long-review clamp measured;
// - the clamp: a long review is cut to the store's lines (shorter card) and grows back with `truncate` off;
// - the card fits every canvas (long titles and reviews, 64-character names, clamp on and off);
// - with SOCIAL_CALIBRATION_DIR set, writes the calibration stills at the scale of the requester's screenshots
//   (cases from SOCIAL_REVIEW_CASES, a JSON file outside the repo with the screenshots' own texts, plus the generic ones).
// Fonts: Roboto from @fontsource/roboto (bundled for the engine); SF Pro Text from SOCIAL_SF_PRO_DIR (the manifest's
// `SF-Pro-Text-{Regular,Semibold}.otf`, never in the repo; without it the App Store cards draw in a fallback face).
// Emoji: SOCIAL_EMOJI_APPLE_DIR / SOCIAL_EMOJI_NOTO_DIR (`<codepoints>.png`), else flat stand-in squares.
import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	emojiGraphemes,
	resolveEmojiStyle,
	SOCIAL_DEFAULT_REVIEW_TEXT,
	type SocialVariant,
	socialCommentParamsSchema,
	socialDefaults,
} from '@jasper/mg-templates';
import type { HeadlessBrowser } from '@remotion/renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CardProps } from './social-comment-render/types.ts';
import { parityIssue, parityRow, restWindow } from './social-parity.ts';

const enabled = process.env.REMOTION_E2E === '1';
const here = dirname(fileURLToPath(import.meta.url));
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const ffmpeg = process.env.JASPER_FFMPEG ?? 'ffmpeg';

const STORE: readonly SocialVariant[] = ['play-store-review', 'app-store-review', 'app-store-review-ios'];

function rgba(png: Buffer): { data: Buffer; width: number; height: number } {
	const probe = spawnSync(
		ffmpeg,
		['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
		{ input: png, maxBuffer: 1 << 30 },
	);
	if (probe.status !== 0) throw new Error(`ffmpeg: ${probe.stderr.toString()}`);
	return { data: probe.stdout, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Bounding box of the painted (alpha > 0) pixels. */
function paintedBox(png: Buffer) {
	const { data, width, height } = rgba(png);
	let x0 = width;
	let y0 = height;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			if (data[(y * width + x) * 4 + 3]! > 0) {
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x);
				y0 = Math.min(y0, y);
				y1 = Math.max(y1, y);
			}
	return { x0, y0, x1, y1, width, height };
}

const LONG_REVIEW =
	'I have used this app every day for two years and it keeps getting better 😍 The new update made syncing between my phone and laptop instant, the widgets are lovely and support answered within an hour when I had a billing question. Only wish there was a way to export everything as a spreadsheet, but that is a small thing. Highly recommend to anyone who plans their week! 🔥🙏';
const LONG_TITLE =
	'Absolutely the best planner app I have ever used on any phone, tablet or computer, period';

type Case = { name: string; canvas: string; params: Record<string, unknown>; frame?: number; scale?: number };

/** The scale that draws a 9:16 card at the pixel scale of the requester's screenshot of that store. */
const REF_SCALE: Readonly<Record<string, number>> = {
	// image px per reference px (Play dp, legacy App Store CSS px, iPhone pt) over the 1.8 zoom of 9:16
	'play-store-review': 3.525 / 1.8,
	'app-store-review': 2.094 / 1.8,
	// the iPhone screenshot is 0.769 px/pt: render at 2× (the page enlarges the screenshot instead)
	'app-store-review-ios': 2 / 1.8,
};

const CALIBRATION: Case[] = [];
for (const variant of STORE)
	for (const theme of ['light', 'dark'])
		CALIBRATION.push(
			{
				name: `${variant}_${theme}_default`,
				canvas: '1080x1920',
				params: { ...socialDefaults(variant), theme },
			},
			{
				name: `${variant}_${theme}_long`,
				canvas: '1080x1920',
				params: { ...socialDefaults(variant), theme, text: LONG_REVIEW, truncate: true, rating: 3 },
			},
		);
for (const variant of STORE)
	CALIBRATION.push(
		{
			name: `${variant}_light_long-untruncated`,
			canvas: '1080x1920',
			params: { ...socialDefaults(variant), text: LONG_REVIEW, truncate: false, rating: 5 },
		},
		{
			name: `${variant}_light_long-title-name`,
			canvas: '1080x1920',
			params: {
				...socialDefaults(variant),
				title: LONG_TITLE,
				displayName: 'Averyveryveryverylongname With Many Characters And Even More 1',
				rating: 1,
			},
		},
		{
			name: `${variant}_light_marks`,
			canvas: '1080x1920',
			params: {
				...socialDefaults(variant),
				text: 'Write any ==review== and ||see|| what ~~happens~~ @friend #fyp 😊',
				rating: 2,
			},
		},
		{
			name: `${variant}_light_avatar-generated`,
			canvas: '1080x1920',
			params: { ...socialDefaults(variant), avatar: { generated: 42 }, displayName: 'Luna Park' },
		},
	);
CALIBRATION.push(
	{
		name: 'app-store-review-ios_light_edited',
		canvas: '1080x1920',
		params: { ...socialDefaults('app-store-review-ios'), edited: true, timeValue: 1, timeUnit: 'year' },
	},
	{
		name: 'play-store-review_light_no-profile',
		canvas: '1080x1920',
		params: { ...socialDefaults('play-store-review'), showProfile: false },
	},
);
// the star fill: frames through the tick (entrance ends at 17, the stars fill until ≈ 44, then pulse)
for (const variant of STORE)
	for (const frame of [17, 22, 28, 34, 40, 46, 50])
		CALIBRATION.push({
			name: `anim_${variant}_stars_f${String(frame).padStart(3, '0')}`,
			canvas: '1080x1920',
			params: { ...socialDefaults(variant), likeTick: true, rating: 4 },
			frame,
		});
// the requester's screenshot texts (outside the repo: third-party content)
if (process.env.SOCIAL_REVIEW_CASES && existsSync(process.env.SOCIAL_REVIEW_CASES))
	for (const c of JSON.parse(readFileSync(process.env.SOCIAL_REVIEW_CASES, 'utf8')) as Case[])
		CALIBRATION.push(c);

describe.runIf(enabled)('store review cards render (REMOTION_E2E=1)', { timeout: 1_200_000 }, () => {
	let r: typeof import('@remotion/renderer');
	let browser: HeadlessBrowser | undefined;
	let serveUrl = '';
	const browserOpts = CHROME ? { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const } : {};
	const work = enabled ? mkdtempSync(join(tmpdir(), 'jasper-review-')) : '';
	const fonts: CardProps['fonts'] = [];
	const emojiFiles: Record<string, string> = {};

	beforeAll(async () => {
		r = await import('@remotion/renderer');
		const { bundle } = await import('@remotion/bundler');
		const pub = join(work, 'public');
		mkdirSync(join(pub, 'fonts'), { recursive: true });
		mkdirSync(join(pub, 'emoji'), { recursive: true });
		try {
			const req = createRequire(join(here, '../../../apps/engine/package.json'));
			const dir = join(dirname(req.resolve('@fontsource/roboto/package.json')), 'files');
			for (const weight of [400, 500]) {
				const file = `roboto-latin-${weight}-normal.woff2`;
				copyFileSync(join(dir, file), join(pub, 'fonts', file));
				fonts.push({ family: 'Roboto', weight, file: `fonts/${file}` });
			}
		} catch {
			// no Roboto: the Play card draws in a fallback face (the calibration needs it)
		}
		const sf = process.env.SOCIAL_SF_PRO_DIR;
		if (sf && existsSync(sf))
			for (const [name, weight] of [
				['Regular', 400],
				['Semibold', 600],
			] as const) {
				const file = `SF-Pro-Text-${name}.otf`;
				if (!existsSync(join(sf, file))) continue;
				copyFileSync(join(sf, file), join(pub, 'fonts', file));
				fonts.push({ family: 'SF Pro Text', weight, file: `fonts/${file}` });
			}
		for (const [pack, dir] of [
			['apple', process.env.SOCIAL_EMOJI_APPLE_DIR],
			['noto', process.env.SOCIAL_EMOJI_NOTO_DIR],
		] as const)
			if (dir && existsSync(dir))
				for (const f of readdirSync(dir).filter((n) => n.endsWith('.png'))) {
					copyFileSync(join(dir, f), join(pub, 'emoji', `${pack}-${f}`));
					const g = String.fromCodePoint(
						...f
							.replace('.png', '')
							.split('-')
							.map((h) => Number.parseInt(h, 16)),
					);
					emojiFiles[`${pack}:${g}`] = `emoji/${pack}-${f}`;
				}
		// every emoji the cases draw needs an image of the variant's pack: flat stand-ins where none was given
		const texts = [SOCIAL_DEFAULT_REVIEW_TEXT, LONG_REVIEW, LONG_TITLE];
		for (const c of CALIBRATION)
			texts.push(
				String(c.params.text ?? ''),
				String(c.params.displayName ?? ''),
				String(c.params.title ?? ''),
			);
		for (const g of emojiGraphemes(texts.join('\n')))
			for (const pack of ['apple', 'noto']) {
				if (emojiFiles[`${pack}:${g}`]) continue;
				const name = `${pack}-${[...g].map((ch) => ch.codePointAt(0)!.toString(16)).join('-')}.png`;
				spawnSync(ffmpeg, [
					'-v',
					'error',
					'-y',
					'-f',
					'lavfi',
					'-i',
					'color=c=0xffcc33:s=160x160',
					'-frames:v',
					'1',
					join(pub, 'emoji', name),
				]);
				emojiFiles[`${pack}:${g}`] = `emoji/${name}`;
			}
		console.log(
			`[store-reviews] fonts: ${fonts.length} faces, emoji: ${Object.keys(emojiFiles).length}; ${work}`,
		);
		serveUrl = await bundle({ entryPoint: join(here, 'social-comment-render', 'entry.tsx'), publicDir: pub });
		browser = await r.openBrowser('chrome', { ...browserOpts });
	}, 900_000);
	afterAll(async () => {
		await browser?.close({ silent: true });
	});

	const propsOf = (c: Pick<Case, 'params'>): CardProps => ({
		params: c.params,
		fonts,
		mediaFiles: {},
		emojiFiles,
	});
	const still = async (c: Case, frame: number, scale = 1) => {
		const composition = await r.selectComposition({
			serveUrl,
			id: `Card-${c.canvas}`,
			inputProps: propsOf(c),
			puppeteerInstance: browser,
			...browserOpts,
		});
		const { buffer } = await r.renderStill({
			composition,
			serveUrl,
			frame,
			scale,
			inputProps: propsOf(c),
			imageFormat: 'png',
			output: null,
			puppeteerInstance: browser,
			...browserOpts,
		});
		return buffer!;
	};

	it('every emoji of the cases has an image of its pack', () => {
		for (const c of CALIBRATION) {
			const p = socialCommentParamsSchema.parse(c.params);
			const pack = resolveEmojiStyle(p.variant, p.emojiStyle);
			for (const g of emojiGraphemes(`${p.text}\n${p.displayName}\n${p.title}`))
				expect(emojiFiles[`${pack}:${g}`], `${c.name} ${g}`).toBeDefined();
		}
	});

	it('renderStill = renderFrames: byte-identical at rest, the parity standard while the card animates', async () => {
		const cases: Case[] = [
			{
				name: 'play-light',
				canvas: '1080x1920',
				params: {
					...socialDefaults('play-store-review'),
					text: LONG_REVIEW,
					likeTick: true,
					wordReveal: true,
					entrance: 'grow-from-tail',
				},
			},
			{
				name: 'web-dark',
				canvas: '1920x1080',
				params: {
					...socialDefaults('app-store-review'),
					theme: 'dark',
					text: LONG_REVIEW,
					likeTick: true,
					entrance: 'drop-bounce',
				},
			},
			{
				name: 'ios-light',
				canvas: '1080x1080',
				params: {
					...socialDefaults('app-store-review-ios'),
					text: LONG_REVIEW,
					truncate: true,
					edited: true,
					likeTick: true,
					wordReveal: true,
					entrance: 'classic-pop',
				},
			},
		];
		for (const c of cases) {
			const frames = [0, 4, 8, 12, 17, 22, 30, 40, 46, 60, 146];
			const stills = new Map<number, Buffer>();
			for (const f of frames) stills.set(f, await still(c, f));
			const composition = await r.selectComposition({
				serveUrl,
				id: `Card-${c.canvas}`,
				inputProps: propsOf(c),
				puppeteerInstance: browser,
				...browserOpts,
			});
			const out = new Map<number, Buffer>();
			await r.renderFrames({
				composition,
				serveUrl,
				inputProps: propsOf(c),
				outputDir: null,
				imageFormat: 'png',
				concurrency: 2,
				frameRange: [0, 149],
				onStart: () => {},
				onFrameUpdate: () => {},
				onFrameBuffer: (buffer: Buffer, frame: number) => {
					out.set(frame, buffer);
				},
				puppeteerInstance: browser,
				...browserOpts,
			});
			const differing = frames.filter((f) => !stills.get(f)!.equals(out.get(f)!));
			for (const f of differing) {
				writeFileSync(join(work, `${c.name}-still-${f}.png`), stills.get(f)!);
				writeFileSync(join(work, `${c.name}-frames-${f}.png`), out.get(f)!);
			}
			// the shared policy (social-parity.ts, as social-comment-render): byte-identical at rest (entrance and star fill
			// over, exit not begun), the project's parity standard while the card animates
			const rest = restWindow(c.params);
			const rows = differing.map((f) =>
				parityRow(c.name, f, rgba(stills.get(f)!).data, rgba(out.get(f)!).data, rest),
			);
			const issues = rows.map(parityIssue).filter((x): x is string => x !== null);
			// SOCIAL_PARITY_LOG=<file>: one JSON line per case with every differing frame (flake-rate measurements)
			if (process.env.SOCIAL_PARITY_LOG)
				appendFileSync(process.env.SOCIAL_PARITY_LOG, `${JSON.stringify({ issues, parity: rows })}\n`);
			expect(issues, c.name).toEqual([]);
			// the stars fill: the frame in the middle of the tick differs from the rest frame
			expect(stills.get(30)!.equals(stills.get(60)!), c.name).toBe(false);
		}
	});

	it('clamps a long review to the store lines and shows all of it with truncate off', async () => {
		for (const variant of STORE) {
			const base = { ...socialDefaults(variant), text: LONG_REVIEW };
			const on = paintedBox(
				await still({ name: 'on', canvas: '1080x1920', params: { ...base, truncate: true } }, 100),
			);
			const off = paintedBox(
				await still({ name: 'off', canvas: '1080x1920', params: { ...base, truncate: false } }, 100),
			);
			const short = paintedBox(
				await still(
					{ name: 'short', canvas: '1080x1920', params: { ...base, text: 'Great', truncate: true } },
					100,
				),
			);
			expect(off.y1 - off.y0, variant).toBeGreaterThan(on.y1 - on.y0 + 50);
			expect(on.y1 - on.y0, variant).toBeGreaterThanOrEqual(short.y1 - short.y0);
		}
	});

	it('the card fits every canvas: long titles, names and reviews, clamp on and off', async () => {
		const longest = Array.from({ length: 5 }, () => LONG_REVIEW).join(' ');
		for (const canvas of ['1080x1920', '1920x1080', '1080x1080'])
			for (const variant of STORE)
				for (const truncate of [true, false]) {
					const params = {
						...socialDefaults(variant),
						text: longest,
						title: LONG_TITLE,
						displayName: 'W'.repeat(64),
						truncate,
						timeValue: 10000,
						timeUnit: 'month',
						edited: true,
					};
					const box = paintedBox(await still({ name: 'fit', canvas, params }, 100));
					const label = `${canvas} ${variant} truncate=${truncate}`;
					expect(box.x1, label).toBeGreaterThan(box.x0);
					expect(box.x0, label).toBeGreaterThan(0);
					expect(box.y0, label).toBeGreaterThan(0);
					expect(box.x1, label).toBeLessThan(box.width - 1);
					expect(box.y1, label).toBeLessThan(box.height - 1);
				}
	});

	it.runIf(!!process.env.SOCIAL_CALIBRATION_DIR)('writes the calibration stills', async () => {
		const out = process.env.SOCIAL_CALIBRATION_DIR!;
		mkdirSync(out, { recursive: true });
		const only = process.env.SOCIAL_CALIBRATION_FILTER
			? new RegExp(process.env.SOCIAL_CALIBRATION_FILTER)
			: null;
		const manifest: Record<string, ReturnType<typeof paintedBox>> = {};
		for (const c of CALIBRATION.filter((k) => !only || only.test(k.name))) {
			const variant = String(c.params.variant);
			const png = await still(c, c.frame ?? 100, c.scale ?? REF_SCALE[variant] ?? 2 / 1.8);
			writeFileSync(join(out, `${c.name}.png`), png);
			manifest[c.name] = paintedBox(png);
		}
		writeFileSync(join(out, 'boxes.json'), JSON.stringify(manifest, null, 2));
	});
});
