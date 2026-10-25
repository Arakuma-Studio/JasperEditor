// @vitest-environment node
// social-comment@1 in a real Chrome through Remotion (REMOTION_E2E=1, like determinism-render):
// - renderStill of a frame = the same frame of renderFrames, byte for byte, for every TikTok variant × theme with the
//   extras running (S11:ANM-014: seek order never changes a frame);
// - the card fits every canvas (long comment, huge counts, marks): its painted box stays inside the frame;
// - with SOCIAL_CALIBRATION_DIR set, writes the calibration stills (hold frame, card at 2× tokcomment's CSS px).
// Fonts: TikTok Sans from @fontsource/tiktok-sans (SOCIAL_FONT_DIR overrides its `files/` dir), Roboto from
// @fontsource/roboto; emoji: images from SOCIAL_EMOJI_DIR (`<codepoints>.png` = Apple; subdirectories `apple/`,
// `twemoji/`, `noto/` = that pack), else the emoji draw as text.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socialDefaults } from '@jasper/mg-templates';
import type { HeadlessBrowser } from '@remotion/renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CardProps } from './social-comment-render/types.ts';

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
	return fontsourceDir('@fontsource/tiktok-sans');
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
	frame?: number;
	media?: boolean;
};

/** The calibration matrix (design §8 "visual calibration"), named after the tokcomment captures it pairs with. */
const CALIBRATION: Case[] = [];
for (const variant of ['tiktok-reply', 'tiktok-comment'])
	for (const theme of ['light', 'dark'])
		for (const verified of [false, true])
			CALIBRATION.push({
				name: `${variant}_${theme}_verified-${verified ? 'on' : 'off'}`,
				canvas: '1080x1920',
				params: { variant, theme, verified },
			});
for (const variant of ['tiktok-reply', 'tiktok-comment']) {
	// tokcomment's edit and avatar captures were taken with the time left at 3 years
	const y3 = variant === 'tiktok-comment' ? { timeValue: 3, timeUnit: 'year' } : {};
	CALIBRATION.push(
		{ name: `${variant}_light_text-short`, canvas: '1080x1920', params: { variant, text: 'Love this! 🔥' } },
		{ name: `${variant}_light_text-long`, canvas: '1080x1920', params: { variant, text: LONG } },
		{
			name: `${variant}_light_highlight`,
			canvas: '1080x1920',
			params: { variant, ...y3, text: 'Write any ==comment== and see what happens 😊' },
		},
		{
			name: `${variant}_light_blur`,
			canvas: '1080x1920',
			params: { variant, ...y3, text: 'Write any ||comment|| and see what happens 😊' },
		},
		{
			name: `${variant}_light_remove`,
			canvas: '1080x1920',
			params: { variant, ...y3, text: 'Write any ~~comment~~ and see what happens 😊' },
		},
		{
			name: `${variant}_light_avatar-uploaded`,
			canvas: '1080x1920',
			params: { variant, ...y3, avatar: { mediaId: 'med_avatar' } },
			media: true,
		},
		{
			name: `${variant}_light_avatar-generated`,
			canvas: '1080x1920',
			params: { variant, avatar: { generated: 42 }, displayName: 'Luna Park' },
		},
		{
			name: `${variant}_dark_mentions`,
			canvas: '1080x1920',
			params: { variant, theme: 'dark', text: 'Write any comment @friend and see what happens #fyp 😊' },
		},
	);
}
CALIBRATION.push(
	{
		name: 'tiktok-comment_light_counts-huge',
		canvas: '1080x1920',
		params: {
			variant: 'tiktok-comment',
			likes: 987_654_321_000,
			replies: 4_812_345,
			timeValue: 3,
			timeUnit: 'year',
		},
	},
	{
		name: 'tiktok-comment_light_no-profile',
		canvas: '1080x1920',
		params: { variant: 'tiktok-comment', showProfile: false },
	},
	{
		name: 'tiktok-reply_light_long-name',
		canvas: '1080x1920',
		params: {
			displayName: 'averyveryveryverylongusername_with_many_characters_123456 ✨',
			text: 'Short reply text here',
		},
	},
);

// YouTube: the comment (tokcomment `youtube-video` captures) and the Shorts card (`youtube-shorts`; no verified, time
// or counts); Noto emoji (YouTube's default pack)
for (const theme of ['light', 'dark'])
	for (const verified of [false, true])
		CALIBRATION.push({
			name: `youtube-comment_${theme}_verified-${verified ? 'on' : 'off'}`,
			canvas: '1080x1920',
			params: { variant: 'youtube-comment', theme, verified },
		});
for (const [unit, label] of [
	['minute', 'mins'],
	['hour', 'hrs'],
	['day', 'days'],
	['week', 'wks'],
	['month', 'mth'],
	['year', 'yrs'],
] as const)
	CALIBRATION.push({
		name: `youtube-comment_light_time-3-${label}`,
		canvas: '1080x1920',
		params: { variant: 'youtube-comment', timeValue: 3, timeUnit: unit },
	});
for (const [variant, prefix] of [
	['youtube-comment', 'youtube-comment'],
	['youtube-shorts-reply', 'youtube-shorts-reply'],
] as const)
	CALIBRATION.push(
		{ name: `${prefix}_light_text-short`, canvas: '1080x1920', params: { variant, text: 'Love this! 🔥' } },
		{ name: `${prefix}_light_text-long`, canvas: '1080x1920', params: { variant, text: LONG } },
		{
			name: `${prefix}_light_highlight`,
			canvas: '1080x1920',
			params: { variant, text: 'Write any ==comment== and see what happens 😊' },
		},
		{
			name: `${prefix}_light_blur`,
			canvas: '1080x1920',
			params: { variant, text: 'Write any ||comment|| and see what happens 😊' },
		},
		{
			name: `${prefix}_light_remove`,
			canvas: '1080x1920',
			params: { variant, text: 'Write any ~~comment~~ and see what happens 😊' },
		},
		{
			name: `${prefix}_light_avatar-uploaded`,
			canvas: '1080x1920',
			params: { variant, avatar: { mediaId: 'med_avatar' } },
			media: true,
		},
		{
			name: `${prefix}_light_avatar-generated`,
			canvas: '1080x1920',
			params: { variant, avatar: { generated: 42 }, handle: 'lunapark' },
		},
		{
			name: `${prefix}_dark_mentions`,
			canvas: '1080x1920',
			params: { variant, theme: 'dark', text: 'Write any comment @friend and see what happens #shorts 😊' },
		},
		{
			name: `${prefix}_light_mentions`,
			canvas: '1080x1920',
			params: { variant, text: 'Write any comment @friend and see what happens #shorts 😊' },
		},
		{
			name: `${prefix}_light_no-profile`,
			canvas: '1080x1920',
			params: { variant, showProfile: false },
		},
		{
			name: `${prefix}_light_long-name`,
			canvas: '1080x1920',
			params: {
				variant,
				handle: 'averyveryveryverylongusername_with_many_characters_123456',
				verified: true,
			},
		},
	);
CALIBRATION.push(
	{
		name: 'youtube-shorts-reply_light_default',
		canvas: '1080x1920',
		params: { variant: 'youtube-shorts-reply' },
	},
	{
		name: 'youtube-shorts-reply_dark_default',
		canvas: '1080x1920',
		params: { variant: 'youtube-shorts-reply', theme: 'dark' },
	},
	{
		name: 'youtube-comment_light_counts-raw',
		canvas: '1080x1920',
		params: { variant: 'youtube-comment', likes: 1_234_567, replies: 1_234_567 },
	},
	{
		name: 'youtube-comment_light_counts-huge',
		canvas: '1080x1920',
		params: { variant: 'youtube-comment', likes: 987_654_321_000, replies: 4_812_345, verified: true },
	},
	{
		name: 'youtube-comment_light_no-replies',
		canvas: '1080x1920',
		params: { variant: 'youtube-comment', replies: 0 },
	},
	{
		name: 'youtube-comment_dark_one-reply',
		canvas: '1080x1920',
		params: { variant: 'youtube-comment', theme: 'dark', replies: 1, timeValue: 1, timeUnit: 'month' },
	},
	{
		name: 'youtube-comment_dark_liked',
		canvas: '1080x1920',
		params: { variant: 'youtube-comment', theme: 'dark', likeTick: true },
	},
);
for (const frame of [16, 22, 30, 40, 48])
	CALIBRATION.push({
		name: `anim_youtube-extras_f${String(frame).padStart(3, '0')}`,
		canvas: '1080x1920',
		params: { variant: 'youtube-comment', wordReveal: true, likeTick: true },
		frame,
	});
for (const frame of [3, 6, 9, 13])
	CALIBRATION.push({
		name: `anim_youtube-shorts-grow_f${String(frame).padStart(3, '0')}`,
		canvas: '1080x1920',
		params: { variant: 'youtube-shorts-reply', entrance: 'grow-from-tail' },
		frame,
	});

// the YouTube cases start from the variant's tokcomment defaults ("Username", 10 months ago, 72 likes, 2 replies)
for (const c of CALIBRATION) {
	const variant = c.params.variant;
	if (typeof variant === 'string' && variant.startsWith('youtube-'))
		c.params = { ...socialDefaults(variant as 'youtube-comment'), ...c.params };
}

// animation frames (filmstrips on the calibration page): each entrance, the extras, the exit
for (const [entrance, frames] of [
	['classic-pop', [2, 4, 6, 8]],
	['soft-spring', [2, 5, 8, 12]],
	['grow-from-tail', [3, 6, 9, 13]],
	['drop-bounce', [4, 8, 12, 16]],
] as const)
	for (const frame of frames)
		CALIBRATION.push({
			name: `anim_${entrance}_f${String(frame).padStart(3, '0')}`,
			canvas: '1080x1920',
			params: { entrance },
			frame,
		});
for (const frame of [16, 22, 30, 40, 48, 146, 148])
	CALIBRATION.push({
		name: `anim_extras_f${String(frame).padStart(3, '0')}`,
		canvas: '1080x1920',
		params: { variant: 'tiktok-comment', wordReveal: true, likeTick: true },
		frame,
	});

describe.runIf(enabled)('social-comment@1 renders (REMOTION_E2E=1)', { timeout: 1_200_000 }, () => {
	let r: typeof import('@remotion/renderer');
	let browser: HeadlessBrowser | undefined;
	let serveUrl = '';
	const browserOpts = CHROME ? { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const } : {};
	const work = enabled ? mkdtempSync(join(tmpdir(), 'jasper-social-')) : '';
	const fonts: CardProps['fonts'] = [];
	const emojiFiles: Record<string, string> = {};

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
		const emojiDir = process.env.SOCIAL_EMOJI_DIR;
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
			for (const pack of ['apple', 'twemoji', 'noto'])
				if (existsSync(join(emojiDir, pack))) addEmoji(join(emojiDir, pack), pack);
		}
		// a 256 px gradient picture as the uploaded avatar (no personal data)
		spawnSync(ffmpeg, [
			'-v',
			'error',
			'-y',
			'-f',
			'lavfi',
			'-i',
			'gradients=s=256x256:c0=0xff6b6b:c1=0x4d96ff:x0=0:y0=0:x1=256:y1=256:nb_colors=2',
			'-frames:v',
			'1',
			join(pub, 'avatar.png'),
		]);
		console.log(
			`[social-comment] fonts: ${fonts.length} faces, emoji: ${Object.keys(emojiFiles).length}; artifacts ${work}`,
		);
		serveUrl = await bundle({ entryPoint: join(here, 'social-comment-render', 'entry.tsx'), publicDir: pub });
		browser = await r.openBrowser('chrome', { ...browserOpts });
	}, 900_000);
	afterAll(async () => {
		await browser?.close({ silent: true });
	});

	const propsOf = (c: Case): CardProps => ({
		params: c.params,
		fonts,
		mediaFiles: c.media ? { med_avatar: 'avatar.png' } : {},
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

	it('renderStill = renderFrames, frame for frame, while the entrance and the extras run (byte-identical)', async () => {
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
				name: 'youtube-comment-dark',
				canvas: '1080x1080',
				params: {
					variant: 'youtube-comment',
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
				params: { variant: 'youtube-shorts-reply', wordReveal: true, entrance: 'classic-pop' },
			},
		];
		for (const c of cases) {
			const frames = [0, 6, 14, 22, 30, 45, 146];
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
			expect(differing, c.name).toEqual([]);
			expect(stills.get(0)!.equals(stills.get(45)!)).toBe(false);
		}
	});

	it('the card fits every canvas: long comment, huge counts, marks (painted box inside the frame)', async () => {
		const longest = `${LONG} ==${LONG}== ||${LONG}|| ${LONG} ${LONG} ${LONG} ${LONG}`;
		for (const canvas of ['1080x1920', '1920x1080', '1080x1080'])
			for (const params of [
				{ text: longest },
				{ variant: 'tiktok-comment', text: longest, likes: 1e12, replies: 1e12 },
				{ variant: 'tiktok-comment', likes: 999_999_999_999, replies: 999_999, displayName: 'x'.repeat(64) },
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

	it.runIf(!!process.env.SOCIAL_CALIBRATION_DIR)('writes the calibration stills', async () => {
		const out = process.env.SOCIAL_CALIBRATION_DIR!;
		mkdirSync(out, { recursive: true });
		const manifest: Record<string, ReturnType<typeof paintedBox>> = {};
		// SOCIAL_CALIBRATION_FILTER: a regular expression of the case names to render (e.g. "^youtube-")
		const only = process.env.SOCIAL_CALIBRATION_FILTER
			? new RegExp(process.env.SOCIAL_CALIBRATION_FILTER)
			: null;
		for (const c of CALIBRATION.filter((k) => !only || only.test(k.name))) {
			// the hold frame; 9:16 zooms the 420 px card by 1.8 → scale 2 / 1.8 draws it at tokcomment's 2× (840 px)
			const png = await still(c, c.frame ?? 100, 2 / 1.8);
			writeFileSync(join(out, `${c.name}.png`), png);
			manifest[c.name] = paintedBox(png);
		}
		writeFileSync(join(out, 'boxes.json'), JSON.stringify(manifest, null, 2));
	});
});
