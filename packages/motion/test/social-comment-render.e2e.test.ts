// @vitest-environment node
// social-comment@1 in a real Chrome through Remotion (REMOTION_E2E=1, like determinism-render):
// - renderStill of a frame = the same frame of renderFrames, byte for byte, for every TikTok variant × theme with the
//   extras running (S11:ANM-014: seek order never changes a frame);
// - the card fits every canvas (long comment, huge counts, marks): its painted box stays inside the frame;
// Fonts: TikTok Sans from @fontsource/tiktok-sans, bundled for the engine (SOCIAL_FONT_DIR overrides its `files/` dir);
// Roboto (the YouTube cards) from @fontsource/roboto; emoji: Apple images from SOCIAL_EMOJI_DIR (`<codepoints>.png`;
// subdirectories `apple/`, `twemoji/`, `noto/` = that pack), else flat stand-in squares (EmojiImage fails a render
// without an image). X: Chirp from SOCIAL_CHIRP_DIR (the manifest's `Chirp-{Regular,Medium,Bold,Heavy}.<hash>.latin.woff2`
// files; it is not redistributed, so without it the X card draws in a fallback face), remote images from
// SOCIAL_IMAGE_DIR (`<manifest image id>.png`, e.g. `x-default-avatar.png`; without it the X default avatar is its
// vector twin).
// Instagram: SF Pro Text from SOCIAL_SF_PRO_DIR (the manifest's `SF-Pro-Text-{Regular,Semibold}.otf`; not
// redistributed, so without it the Instagram cards draw in a fallback face).
import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	emojiGraphemes,
	isSocialVariant,
	SOCIAL_DEFAULT_TEXT,
	SOCIAL_VARIANT_FONTS,
	socialDefaults,
} from '@jasper/mg-templates';
import type { HeadlessBrowser } from '@remotion/renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CardProps } from './social-comment-render/types.ts';
import { type ParityRow, parityIssue, parityRow, restWindow } from './social-parity.ts';

const enabled = process.env.REMOTION_E2E === '1';
const here = dirname(fileURLToPath(import.meta.url));
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const ffmpeg = process.env.JASPER_FFMPEG ?? 'ffmpeg';

/** The `files/` dir of a @fontsource package as installed for the engine (null when it is not installed). */
function fontsourceDir(pkg: string): string | null {
	try {
		const req = createRequire(join(here, '../../../apps/engine/package.json'));
		return join(dirname(req.resolve(`${pkg}/package.json`)), 'files');
	} catch {
		return null;
	}
}

/** The TikTok Sans files: SOCIAL_FONT_DIR, else @fontsource/tiktok-sans as installed for the engine. */
function fontDir(): string | null {
	if (process.env.SOCIAL_FONT_DIR) return process.env.SOCIAL_FONT_DIR;
	try {
		const req = createRequire(join(here, '../../../apps/engine/package.json'));
		return join(dirname(req.resolve('@fontsource/tiktok-sans/package.json')), 'files');
	} catch {
		return null;
	}
}

function rgba(png: Buffer): { data: Buffer; width: number; height: number } {
	const probe = spawnSync(
		ffmpeg,
		['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
		{
			input: png,
			maxBuffer: 1 << 30,
		},
	);
	if (probe.status !== 0) throw new Error(`ffmpeg: ${probe.stderr.toString()}`);
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	return { data: probe.stdout, width, height };
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

const LONG =
	'Okay this is honestly the best tutorial I have seen all week 😂 I tried it on my own videos and the engagement doubled overnight, can you please make a part two about editing? 🔥🙏 Thanks so much!';

type Case = {
	name: string;
	canvas: string;
	params: Record<string, unknown>;
};

describe.runIf(enabled)('social-comment@1 renders (REMOTION_E2E=1)', { timeout: 1_200_000 }, () => {
	let r: typeof import('@remotion/renderer');
	let browser: HeadlessBrowser | undefined;
	let serveUrl = '';
	const browserOpts = CHROME ? { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const } : {};
	const work = enabled ? mkdtempSync(join(tmpdir(), 'jasper-social-')) : '';
	const fonts: CardProps['fonts'] = [];
	const emojiFiles: Record<string, string> = {};
	const imageFiles: Record<string, string> = {};

	beforeAll(async () => {
		r = await import('@remotion/renderer');
		const { bundle } = await import('@remotion/bundler');
		const pub = join(work, 'public');
		mkdirSync(join(pub, 'fonts'), { recursive: true });
		mkdirSync(join(pub, 'emoji'), { recursive: true });
		const dir = fontDir();
		if (dir)
			for (const weight of [500, 600, 700]) {
				const file = `tiktok-sans-latin-${weight}-normal.woff2`;
				if (!existsSync(join(dir, file))) continue;
				copyFileSync(join(dir, file), join(pub, 'fonts', file));
				fonts.push({ family: 'TikTok Sans', weight, file: `fonts/${file}` });
			}
		// Roboto (the YouTube cards)
		const roboto = fontsourceDir('@fontsource/roboto');
		if (roboto)
			for (const weight of [400, 500]) {
				const file = `roboto-latin-${weight}-normal.woff2`;
				if (!existsSync(join(roboto, file))) continue;
				copyFileSync(join(roboto, file), join(pub, 'fonts', file));
				fonts.push({ family: 'Roboto', weight, file: `fonts/${file}` });
			}
		const sfPro = process.env.SOCIAL_SF_PRO_DIR;
		if (sfPro)
			for (const [weight, style] of [
				[400, 'Regular'],
				[600, 'Semibold'],
			] as const) {
				const file = `SF-Pro-Text-${style}.otf`;
				if (!existsSync(join(sfPro, file))) continue;
				copyFileSync(join(sfPro, file), join(pub, 'fonts', file));
				fonts.push({ family: 'SF Pro Text', weight, file: `fonts/${file}` });
			}
		// Chirp (the X card): the manifest's latin subset files, when SOCIAL_CHIRP_DIR holds them
		const chirp = process.env.SOCIAL_CHIRP_DIR;
		if (chirp && existsSync(chirp))
			for (const [name, weight] of [
				['Regular', 400],
				['Medium', 500],
				['Bold', 700],
				['Heavy', 800],
			] as const) {
				const file = readdirSync(chirp).find(
					(f) => f.startsWith(`Chirp-${name}.`) && f.endsWith('.latin.woff2'),
				);
				if (!file) continue;
				copyFileSync(join(chirp, file), join(pub, 'fonts', file));
				fonts.push({ family: 'Chirp', weight, file: `fonts/${file}` });
			}
		// remote manifest images by id (X's default avatar)
		const imageDir = process.env.SOCIAL_IMAGE_DIR;
		if (imageDir && existsSync(imageDir))
			for (const f of readdirSync(imageDir).filter((n) => /\.(png|jpe?g)$/.test(n))) {
				copyFileSync(join(imageDir, f), join(pub, f));
				imageFiles[f.replace(/\.[a-z]+$/, '')] = f;
			}
		const emojiDir = process.env.SOCIAL_EMOJI_DIR;
		const PACKS = ['apple', 'twemoji', 'noto'] as const;
		const addEmoji = (dir: string, pack: string) => {
			mkdirSync(join(pub, 'emoji', pack), { recursive: true });
			for (const f of readdirSync(dir).filter((n) => n.endsWith('.png'))) {
				copyFileSync(join(dir, f), join(pub, 'emoji', pack, f));
				const grapheme = String.fromCodePoint(
					...f
						.replace('.png', '')
						.split('-')
						.map((h) => Number.parseInt(h, 16)),
				);
				emojiFiles[`${pack}:${grapheme}`] = `emoji/${pack}/${f}`;
			}
		};
		if (emojiDir && existsSync(emojiDir)) {
			addEmoji(emojiDir, 'apple');
			for (const pack of PACKS) if (existsSync(join(emojiDir, pack))) addEmoji(join(emojiDir, pack), pack);
		}
		// Every emoji the cases draw needs an image (EmojiImage fails a render without one, like an export the planner
		// would block): without SOCIAL_EMOJI_DIR, flat stand-in squares keep the parity and fit checks self-contained.
		const texts = [SOCIAL_DEFAULT_TEXT, LONG, 'averyveryveryverylongusername_with_many_characters_123456 ✨'];
		for (const g of emojiGraphemes(texts.join('\n')))
			for (const pack of PACKS) {
				if (emojiFiles[`${pack}:${g}`]) continue;
				const name = `${[...g].map((ch) => ch.codePointAt(0)!.toString(16)).join('-')}.png`;
				mkdirSync(join(pub, 'emoji', 'stand-in'), { recursive: true });
				if (!existsSync(join(pub, 'emoji', 'stand-in', name)))
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
						join(pub, 'emoji', 'stand-in', name),
					]);
				emojiFiles[`${pack}:${g}`] = `emoji/stand-in/${name}`;
			}
		console.log(
			`[social-comment] fonts: ${fonts.length} faces, emoji: ${Object.keys(emojiFiles).length}, images: ${Object.keys(imageFiles).length}; artifacts ${work}`,
		);
		serveUrl = await bundle({ entryPoint: join(here, 'social-comment-render', 'entry.tsx'), publicDir: pub });
		browser = await r.openBrowser('chrome', { ...browserOpts });
	}, 900_000);
	afterAll(async () => {
		await browser?.close({ silent: true });
	});

	// a case's params over its variant's tokcomment defaults (the captures show each variant's own defaults); the page
	// loads only the variant's own font family, as `requiredAssets` does in the editor and the engine
	const variantOf = (c: Case) => (isSocialVariant(c.params.variant) ? c.params.variant : 'tiktok-reply');
	const propsOf = (c: Case): CardProps => ({
		params: { ...socialDefaults(variantOf(c)), ...c.params },
		fonts: fonts.filter((f) => f.family === SOCIAL_VARIANT_FONTS[variantOf(c)]?.family),
		mediaFiles: {},
		emojiFiles,
		imageFiles,
	});
	const still = async (c: Case, frame: number) => {
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
			inputProps: propsOf(c),
			imageFormat: 'png',
			output: null,
			puppeteerInstance: browser,
			...browserOpts,
		});
		return buffer!;
	};

	it('renderStill = renderFrames: byte-identical at rest, the parity standard while the entrance runs', async () => {
		const cases: Case[] = [
			{ name: 'reply-light', canvas: '1080x1920', params: { wordReveal: true, entrance: 'grow-from-tail' } },
			{
				name: 'comment-dark',
				canvas: '1920x1080',
				params: {
					variant: 'tiktok-comment',
					theme: 'dark',
					likeTick: true,
					wordReveal: true,
					entrance: 'drop-bounce',
				},
			},
			{
				name: 'reply-dark-pop',
				canvas: '1080x1080',
				params: { theme: 'dark', entrance: 'classic-pop', verified: true, text: 'so ==good== 😊 ||wow||' },
			},
			{
				name: 'comment-light-spring',
				canvas: '1080x1920',
				params: {
					variant: 'tiktok-comment',
					entrance: 'soft-spring',
					likeTick: true,
					avatar: { generated: 5 },
				},
			},
			{
				name: 'x-post-dark',
				canvas: '1080x1080',
				params: {
					...socialDefaults('x-post'),
					theme: 'dark',
					verified: true,
					likeTick: true,
					wordReveal: true,
					entrance: 'grow-from-tail',
				},
			},
			{
				name: 'youtube-comment-dark',
				canvas: '1080x1080',
				params: {
					...socialDefaults('youtube-comment'),
					theme: 'dark',
					likeTick: true,
					wordReveal: true,
					entrance: 'grow-from-tail',
					verified: true,
				},
			},
			{
				name: 'youtube-shorts-light',
				canvas: '1080x1920',
				params: { ...socialDefaults('youtube-shorts-reply'), wordReveal: true, entrance: 'classic-pop' },
			},
			{
				name: 'instagram-post-dark',
				canvas: '1080x1080',
				params: {
					variant: 'instagram-post',
					theme: 'dark',
					likeTick: true,
					wordReveal: true,
					verified: true,
					entrance: 'classic-pop',
				},
			},
			{
				name: 'instagram-reel-light',
				canvas: '1080x1920',
				params: { variant: 'instagram-reel-reply', wordReveal: true, entrance: 'soft-spring' },
			},
		];
		const issues: string[] = [];
		const parity: ParityRow[] = [];
		// SC_CASE=<name> runs one case (debugging)
		for (const c of cases.filter((x) => !process.env.SC_CASE || x.name === process.env.SC_CASE)) {
			const frames = [0, 2, 4, 6, 8, 10, 12, 14, 17, 22, 30, 45, 146];
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
			// the shared policy (social-parity.ts): byte-identical at rest, the project's parity standard while animating
			const rest = restWindow(c.params);
			for (const f of differing) {
				const row = parityRow(c.name, f, rgba(stills.get(f)!).data, rgba(out.get(f)!).data, rest);
				parity.push(row);
				const issue = parityIssue(row);
				if (issue) issues.push(issue);
			}
			expect(stills.get(0)!.equals(stills.get(45)!)).toBe(false);
		}
		writeFileSync(join(work, 'parity.json'), JSON.stringify(parity, null, 2));
		// SOCIAL_PARITY_LOG=<file>: one JSON line per run with every differing frame (flake-rate measurements)
		if (process.env.SOCIAL_PARITY_LOG)
			appendFileSync(process.env.SOCIAL_PARITY_LOG, `${JSON.stringify({ issues, parity })}\n`);
		expect(issues).toEqual([]);
	});

	it('the card fits every canvas: long comment, huge counts, marks (painted box inside the frame)', async () => {
		const longest = `${LONG} ==${LONG}== ||${LONG}|| ${LONG} ${LONG} ${LONG} ${LONG}`;
		for (const canvas of ['1080x1920', '1920x1080', '1080x1080'])
			for (const params of [
				{ text: longest },
				{ variant: 'tiktok-comment', text: longest, likes: 1e12, replies: 1e12 },
				{ variant: 'tiktok-comment', likes: 999_999_999_999, replies: 999_999, displayName: 'x'.repeat(64) },
				{ variant: 'instagram-post', text: longest, likes: 1e12, replies: 1e12, verified: true },
				{ variant: 'instagram-post', likes: 999_999_999_999, replies: 999_999, handle: 'x'.repeat(64) },
				{ variant: 'instagram-reel-reply', text: longest },
				{ variant: 'instagram-reel-reply', handle: 'x'.repeat(64), text: 'ok' },
				{
					variant: 'x-post',
					text: longest,
					likes: 1e12,
					replies: 1e12,
					reposts: 1e12,
					views: 1e12,
					verified: true,
				},
				{
					variant: 'x-post',
					likes: 999_999_999_999,
					replies: 999_999_999_999,
					reposts: 999_999_999_999,
					views: 999_999_999_999,
					timeValue: 10000,
					timeUnit: 'month',
					displayName: 'W'.repeat(64),
					handle: 'w'.repeat(64),
					verified: true,
				},
				{ variant: 'youtube-comment', text: longest, likes: 1e12, replies: 1e12, verified: true },
				{
					variant: 'youtube-comment',
					likes: 999_999_999_999,
					replies: 999_999_999_999,
					timeValue: 10000,
					timeUnit: 'month',
					handle: 'x'.repeat(64),
					verified: true,
				},
				{ variant: 'youtube-shorts-reply', text: longest },
				{ variant: 'youtube-shorts-reply', handle: 'x'.repeat(64), text: 'ok' },
			]) {
				const png = await still({ name: 'fit', canvas, params }, 100);
				const box = paintedBox(png);
				const label = `${canvas} ${JSON.stringify(params).slice(0, 60)}`;
				expect(box.x1, label).toBeGreaterThan(box.x0);
				// a margin all round (the comment card's soft shadow is part of the card)
				expect(box.x0, label).toBeGreaterThan(0);
				expect(box.y0, label).toBeGreaterThan(0);
				expect(box.x1, label).toBeLessThan(box.width - 1);
				expect(box.y1, label).toBeLessThan(box.height - 1);
			}
	});
});
