// @vitest-environment node
// social-comment@1 in a real Chrome through Remotion (REMOTION_E2E=1, like determinism-render):
// - renderStill of a frame = the same frame of renderFrames, byte for byte, for every TikTok variant × theme with the
//   extras running (S11:ANM-014: seek order never changes a frame);
// - the card fits every canvas (long comment, huge counts, marks): its painted box stays inside the frame;
// - with SOCIAL_CALIBRATION_DIR set, writes the calibration stills (hold frame, card at 2× tokcomment's CSS px).
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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	animeTemplateTiming,
	emojiGraphemes,
	isSocialVariant,
	SOCIAL_DEFAULT_TEXT,
	SOCIAL_VARIANT_FONTS,
	socialComment,
	socialCommentParamsSchema,
	socialCommentSchedule,
	socialDefaults,
} from '@jasper/mg-templates';
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

/** The clip's schedule (to know when its entrance ends), as the implementation builds it. */
function schedule(c: { params: Record<string, unknown> }) {
	const p = socialCommentParamsSchema.parse(c.params);
	const t = animeTemplateTiming(socialComment, { fps: 30, localFrame: 0, durationFrames: 150 });
	return socialCommentSchedule({ ...t, entrance: p.entrance, units: 0, tick: false });
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
for (const variant of ['tiktok-reply', 'tiktok-comment', 'instagram-post'])
	for (const theme of ['light', 'dark'])
		for (const verified of [false, true])
			CALIBRATION.push({
				name: `${variant}_${theme}_verified-${verified ? 'on' : 'off'}`,
				canvas: '1080x1920',
				params: { variant, theme, verified },
			});
for (const theme of ['light', 'dark'])
	CALIBRATION.push({
		name: `instagram-reel-reply_${theme}_default`,
		canvas: '1080x1920',
		params: { variant: 'instagram-reel-reply', theme },
	});
for (const variant of ['tiktok-reply', 'tiktok-comment', 'instagram-post', 'instagram-reel-reply']) {
	// tokcomment's edit and avatar captures were taken with the time left at 3 years
	const y3 =
		variant === 'tiktok-comment' || variant === 'instagram-post' ? { timeValue: 3, timeUnit: 'year' } : {};
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
			params: { variant, avatar: { generated: 42 }, displayName: 'Luna Park', handle: 'luna.park' },
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
		name: 'instagram-post_light_counts-huge',
		canvas: '1080x1920',
		params: {
			variant: 'instagram-post',
			likes: 987_654_321_000,
			replies: 4_812_345,
			timeValue: 3,
			timeUnit: 'year',
		},
	},
	...(
		[
			['minute', 'mins'],
			['hour', 'hrs'],
			['day', 'days'],
			['week', 'wks'],
			['month', 'mth'],
			['year', 'yrs'],
		] as const
	).map(([timeUnit, label]) => ({
		name: `instagram-post_light_time-3-${label}`,
		canvas: '1080x1920',
		params: { variant: 'instagram-post', timeValue: 3, timeUnit },
	})),
	{
		name: 'instagram-post_light_liked',
		canvas: '1080x1920',
		params: { variant: 'instagram-post', likeTick: true, likes: 1234 },
	},
	{
		name: 'instagram-post_dark_liked',
		canvas: '1080x1920',
		params: { variant: 'instagram-post', theme: 'dark', likeTick: true, likes: 1234, verified: true },
	},
	{
		name: 'instagram-post_light_no-likes-no-replies',
		canvas: '1080x1920',
		params: { variant: 'instagram-post', likes: 0, replies: 0 },
	},
	{
		name: 'instagram-post_light_long-name',
		canvas: '1080x1920',
		params: {
			variant: 'instagram-post',
			handle: 'averyveryveryverylongusername_with_many_characters_123456789',
			verified: true,
			timeValue: 3,
			timeUnit: 'year',
		},
	},
	{
		name: 'instagram-reel-reply_light_long-name',
		canvas: '1080x1920',
		params: {
			variant: 'instagram-reel-reply',
			handle: 'averyveryveryverylongusername_with_many_characters_123456789',
		},
	},
	{
		name: 'instagram-post_light_no-profile',
		canvas: '1080x1920',
		params: { variant: 'instagram-post', showProfile: false },
	},
	{
		name: 'instagram-reel-reply_dark_no-profile',
		canvas: '1080x1920',
		params: { variant: 'instagram-reel-reply', theme: 'dark', showProfile: false },
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

// X: the post card (tokcomment `x-post` captures, named after them), from X's tokcomment defaults ("Display Name",
// @username, 2h, 45 / 12 / 1.2K / 12K)
const X_CASES: Case[] = [];
for (const theme of ['light', 'dark'])
	for (const verified of [false, true])
		X_CASES.push({
			name: `x-post_${theme}_verified-${verified ? 'on' : 'off'}`,
			canvas: '1080x1920',
			params: { theme, verified },
		});
for (const [unit, label] of [
	['minute', 'mins'],
	['hour', 'hrs'],
	['day', 'days'],
	['week', 'wks'],
	['month', 'mth'],
	['year', 'yrs'],
] as const)
	X_CASES.push({
		name: `x-post_light_time-3-${label}`,
		canvas: '1080x1920',
		params: { timeValue: 3, timeUnit: unit },
	});
X_CASES.push(
	{ name: 'x-post_light_text-short', canvas: '1080x1920', params: { text: 'Love this! 🔥' } },
	{ name: 'x-post_light_text-long', canvas: '1080x1920', params: { text: LONG } },
	{
		name: 'x-post_light_counts-raw',
		canvas: '1080x1920',
		params: { likes: 1_234_567, replies: 1_234_567, reposts: 1_234_567, views: 1_234_567 },
	},
	{
		name: 'x-post_light_counts-KM',
		canvas: '1080x1920',
		params: { replies: 12_300, reposts: 45_600, likes: 1_200_000, views: 9_800_000 },
	},
	{
		name: 'x-post_light_counts-huge',
		canvas: '1080x1920',
		params: { replies: 999_999_999_999, reposts: 1e12, likes: 987_654_321_000, views: 1e12, verified: true },
	},
	{
		name: 'x-post_light_counts-zero',
		canvas: '1080x1920',
		params: { replies: 0, reposts: 0, likes: 0, views: 0 },
	},
	{
		name: 'x-post_light_highlight',
		canvas: '1080x1920',
		params: { timeValue: 3, timeUnit: 'year', text: 'Write any ==comment== and see what happens 😊' },
	},
	{
		name: 'x-post_light_blur',
		canvas: '1080x1920',
		params: { timeValue: 3, timeUnit: 'year', text: 'Write any ||comment|| and see what happens 😊' },
	},
	{
		name: 'x-post_light_remove',
		canvas: '1080x1920',
		params: { timeValue: 3, timeUnit: 'year', text: 'Write any ~~comment~~ and see what happens 😊' },
	},
	{
		name: 'x-post_light_avatar-uploaded',
		canvas: '1080x1920',
		params: { timeValue: 3, timeUnit: 'year', avatar: { mediaId: 'med_avatar' } },
		media: true,
	},
	{
		name: 'x-post_light_avatar-generated',
		canvas: '1080x1920',
		params: { avatar: { generated: 42 }, displayName: 'Luna Park', handle: 'lunapark' },
	},
	{
		name: 'x-post_light_mentions',
		canvas: '1080x1920',
		params: { text: 'Write any comment @friend and see what happens #fyp 😊' },
	},
	{
		name: 'x-post_dark_mentions',
		canvas: '1080x1920',
		params: { theme: 'dark', text: 'Write any comment @friend and see what happens #fyp 😊' },
	},
	{ name: 'x-post_light_no-profile', canvas: '1080x1920', params: { showProfile: false } },
	{
		name: 'x-post_light_no-reposts-views',
		canvas: '1080x1920',
		params: { showReposts: false, showViews: false },
	},
	{
		name: 'x-post_light_long-name',
		canvas: '1080x1920',
		params: {
			displayName: 'A very very long display name that goes on ✨',
			handle: 'averyveryverylonghandle_123456',
			verified: true,
		},
	},
	{ name: 'x-post_light_liked', canvas: '1080x1920', params: { likeTick: true } },
	{ name: 'x-post_dark_liked', canvas: '1080x1920', params: { theme: 'dark', likeTick: true } },
);
for (const [entrance, frames] of [
	['classic-pop', [2, 4, 6, 8]],
	['soft-spring', [2, 5, 8, 12]],
	['grow-from-tail', [3, 6, 9, 13]],
	['drop-bounce', [4, 8, 12, 16]],
] as const)
	for (const frame of frames)
		X_CASES.push({
			name: `anim_x-${entrance}_f${String(frame).padStart(3, '0')}`,
			canvas: '1080x1920',
			params: { entrance },
			frame,
		});
for (const frame of [16, 22, 30, 40, 48, 146, 148])
	X_CASES.push({
		name: `anim_x-extras_f${String(frame).padStart(3, '0')}`,
		canvas: '1080x1920',
		params: { wordReveal: true, likeTick: true },
		frame,
	});
for (const c of X_CASES) c.params = { ...socialDefaults('x-post'), ...c.params };
CALIBRATION.push(...X_CASES);

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
] as const) {
	// tokcomment's edit and avatar captures of the comment were taken with the time left at 3 years
	const y3 = variant === 'youtube-comment' ? { timeValue: 3, timeUnit: 'year' } : {};
	CALIBRATION.push(
		{ name: `${prefix}_light_text-short`, canvas: '1080x1920', params: { variant, text: 'Love this! 🔥' } },
		{ name: `${prefix}_light_text-long`, canvas: '1080x1920', params: { variant, text: LONG } },
		{
			name: `${prefix}_light_highlight`,
			canvas: '1080x1920',
			params: { variant, ...y3, text: 'Write any ==comment== and see what happens 😊' },
		},
		{
			name: `${prefix}_light_blur`,
			canvas: '1080x1920',
			params: { variant, ...y3, text: 'Write any ||comment|| and see what happens 😊' },
		},
		{
			name: `${prefix}_light_remove`,
			canvas: '1080x1920',
			params: { variant, ...y3, text: 'Write any ~~comment~~ and see what happens 😊' },
		},
		{
			name: `${prefix}_light_avatar-uploaded`,
			canvas: '1080x1920',
			params: { variant, ...y3, avatar: { mediaId: 'med_avatar' } },
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
}
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
for (const [entrance, frames] of [
	['classic-pop', [2, 4, 6, 8]],
	['soft-spring', [2, 5, 8, 12]],
	['grow-from-tail', [3, 6, 9, 13]],
	['drop-bounce', [4, 8, 12, 16]],
] as const)
	for (const frame of frames)
		CALIBRATION.push({
			name: `anim_youtube-${entrance}_f${String(frame).padStart(3, '0')}`,
			canvas: '1080x1920',
			params: { variant: 'youtube-comment', entrance },
			frame,
		});
for (const frame of [16, 22, 30, 40, 48, 146, 148])
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
for (const frame of [3, 6, 9, 13, 16, 22, 30, 40, 48, 146, 148])
	CALIBRATION.push({
		name: `anim_instagram_f${String(frame).padStart(3, '0')}`,
		canvas: '1080x1920',
		params: { variant: 'instagram-post', entrance: 'grow-from-tail', wordReveal: true, likeTick: true },
		frame,
	});
for (const frame of [3, 6, 9, 13, 22, 40])
	CALIBRATION.push({
		name: `anim_instagram-reel_f${String(frame).padStart(3, '0')}`,
		canvas: '1080x1920',
		params: { variant: 'instagram-reel-reply', entrance: 'grow-from-tail', wordReveal: true },
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
		for (const c of CALIBRATION) texts.push(String(c.params.text ?? ''), String(c.params.displayName ?? ''));
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
		mediaFiles: c.media ? { med_avatar: 'avatar.png' } : {},
		emojiFiles,
		imageFiles,
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
			// At rest (after the entrance) a frame is the same bytes however it is reached. While the entrance scales
			// the card, Chrome's path cache may anti-alias an SVG icon edge 1/255 differently after other frames (a
			// handful of pixels, measured: ≤ 5); anything more is a failure.
			const rest = schedule(c).entranceEnd;
			for (const f of differing) {
				const a = rgba(stills.get(f)!).data;
				const b = rgba(out.get(f)!).data;
				let n = 0;
				let max = 0;
				for (let i = 0; i < a.length; i++)
					if (a[i] !== b[i]) {
						n++;
						max = Math.max(max, Math.abs(a[i]! - b[i]!));
					}
				expect((f * 1000) / 30, `${c.name} frame ${f} differs at rest`).toBeLessThan(rest);
				expect({ frame: f, max: Math.min(max, 2), few: n <= 64 }, c.name).toEqual({
					frame: f,
					max: 1,
					few: true,
				});
			}
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

	it.runIf(!!process.env.SOCIAL_CALIBRATION_DIR)('writes the calibration stills', async () => {
		const out = process.env.SOCIAL_CALIBRATION_DIR!;
		mkdirSync(out, { recursive: true });
		const manifest: Record<string, ReturnType<typeof paintedBox>> = {};
		// SOCIAL_CALIBRATION_FILTER: a regular expression of the case names to render (e.g. "^(x-post|anim_x-)")
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
