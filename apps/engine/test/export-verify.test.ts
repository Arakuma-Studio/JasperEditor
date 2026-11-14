// Export verification (spec 18 AF-VER-001…003; docs/wp-notes/agent-footage-verify.md): small exports with known
// defects built with ffmpeg lavfi (LGPL encoders: MPEG-4 Part 2 + AAC in MP4) are measured and judged against a
// recorded verification context; each defect yields its exact row, a clean file verifies.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { VerifyRow } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import {
	cutPictureFindings,
	detectCutClick,
	pixFmtMatches,
	summarizeRows,
	VERIFY_THRESHOLDS,
} from '../src/export/verify.ts';
import type { ExportVerifyContext } from '../src/export/verify-context.ts';
import { verifyExportFile } from '../src/export/verify-job.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './fixtures.ts';
import { tempAppdir } from './temp.ts';

const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
const dir = tempAppdir('jasper-verify-');
const FPS = 30;
const CUT = 45; // 1.5 s

/** Grey shot A (Y≈0.45) for 1.5 s, grey shot B (Y≈0.6) for 1.5 s; `mid` replaces frames from the cut on. */
function video(mid?: { color: string; frames: number }): string[] {
	const a = `color=c=0x707070:s=320x180:r=${FPS}:d=1.5`;
	const b = `color=c=0x909090:s=320x180:r=${FPS}:d=1.5`;
	if (!mid) return ['-f', 'lavfi', '-i', `${a}[a];${b}[b];[a][b]concat=n=2:v=1:a=0`];
	const m = `color=c=${mid.color}:s=320x180:r=${FPS}:d=${mid.frames / FPS}`;
	const rest = `color=c=0x909090:s=320x180:r=${FPS}:d=${1.5 - mid.frames / FPS}`;
	return ['-f', 'lavfi', '-i', `${a}[a];${m}[m];${rest}[b];[a][m][b]concat=n=3:v=1:a=0`];
}

function make(name: string, v: string[], audioExpr: string, audioSec = 3): string {
	const out = join(dir, name);
	execFileSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-y',
		...v,
		'-f',
		'lavfi',
		'-i',
		`aevalsrc=${audioExpr}|${audioExpr}:s=48000:d=${audioSec}`,
		'-map',
		'0:v',
		'-map',
		'1:a',
		'-c:v',
		'mpeg4',
		'-q:v',
		'3',
		'-pix_fmt',
		'yuv420p',
		'-c:a',
		'aac',
		'-b:a',
		'256k',
		out,
	]);
	return out;
}

const SINE = '0.1*sin(2*PI*440*t)';

function context(over: Partial<ExportVerifyContext> = {}): ExportVerifyContext {
	return {
		version: 1,
		sequenceId: 'seq_1',
		range: { start: 0, end: 90 },
		fps: { num: FPS, den: 1 },
		dropFrame: false,
		startTimecodeFrames: 0,
		expected: {
			container: 'mp4',
			video: {
				codec: 'mpeg4',
				width: 320,
				height: 180,
				frameRate: { num: FPS, den: 1 },
				pixFmt: 'yuv420p',
				alpha: false,
			},
			audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
		},
		normalize: { targetLufs: -21, truePeakDb: -1 },
		cuts: [{ frame: CUT, kind: 'cut', blackBefore: false, blackAfter: false, effect: false }],
		uncovered: [],
		...over,
	};
}

const rowsOf = (rows: VerifyRow[], id: VerifyRow['id']) => rows.filter((r) => r.id === id);
const failing = (rows: VerifyRow[]) => rows.filter((r) => r.status === 'fail').map((r) => r.id);

describe('verify_export on fixture exports with known defects', () => {
	it('verifies a clean export: every row passes', { timeout: 60_000 }, async () => {
		const file = make('clean.mp4', video(), SINE);
		const r = await verifyExportFile({ ff, file, context: context(), target: null, checks: 'full' });
		expect(r.rows.map((x) => [x.id, x.kind, x.status])).toEqual([
			['decode', 'format', 'pass'],
			['streams', 'format', 'pass'],
			['duration', 'format', 'pass'],
			['av-skew', 'format', 'pass'],
			['uncovered-video', 'judgement', 'pass'],
			['cut-black', 'judgement', 'pass'],
			['cut-flash', 'judgement', 'pass'],
			['cut-click', 'judgement', 'pass'],
			['loudness', 'judgement', 'pass'],
			['true-peak', 'format', 'pass'],
			['silence', 'judgement', 'pass'],
		]);
		expect(r.verified).toBe(true);
		expect(r.counts).toEqual({ pass: 11, warn: 0, fail: 0, unverified: 0 });
		expect(r.output).toMatchObject({ durationSec: expect.any(Number), sizeBytes: expect.any(Number) });
		expect(r.output.streams.map((s) => s.type)).toEqual(['video', 'audio']);
		const loud = rowsOf(r.rows, 'loudness')[0]!;
		expect(loud.measured as number).toBeGreaterThan(-22);
		expect(loud.measured as number).toBeLessThan(-20);
		expect(loud).toMatchObject({ expected: -21, tolerance: 1 });
	});

	it("the fast checks probe only: streams, duration, A/V skew (and the timeline's uncovered frames)", {
		timeout: 30_000,
	}, async () => {
		const file = join(dir, 'clean.mp4');
		const r = await verifyExportFile({ ff, file, context: context(), target: null, checks: 'fast' });
		expect(r.rows.map((x) => x.id)).toEqual(['streams', 'duration', 'av-skew', 'uncovered-video']);
		expect(r.verified).toBe(true);
	});

	it('lists frames with no picture: fail under audio (black under the sound), warn when silent', {
		timeout: 30_000,
	}, async () => {
		// reported: two 7-frame V1 holes under kept audio exported as the subtitle over black and passed the checks
		const file = join(dir, 'clean.mp4');
		const uncovered = [
			{ start: 20, end: 27, audible: true },
			{ start: 70, end: 75, audible: false },
		];
		const r = await verifyExportFile({
			ff,
			file,
			context: context({ uncovered }),
			target: null,
			checks: 'fast',
		});
		expect(rowsOf(r.rows, 'uncovered-video')).toMatchObject([
			{ status: 'fail', kind: 'judgement', measured: 7, at: { frame: 20, timecode: '00:00:00:20' } },
			{ status: 'warn', measured: 5, at: { frame: 70 } },
		]);
		expect(rowsOf(r.rows, 'uncovered-video')[0]!.message).toMatch(
			/Frames 20–27 \(7 frames.*while audio plays/,
		);
		expect(r.verified).toBe(false);
	});

	it('finds black frames at a cut where the timeline shows a picture', { timeout: 60_000 }, async () => {
		const file = make('black.mp4', video({ color: 'black', frames: 4 }), SINE);
		const r = await verifyExportFile({ ff, file, context: context(), target: null, checks: 'full' });
		const black = rowsOf(r.rows, 'cut-black');
		expect(black).toEqual([
			{
				id: 'cut-black',
				kind: 'judgement',
				status: 'fail',
				measured: 133,
				expected: 0,
				tolerance: 'luma < 0.0627 in every 4×4 cell for ≥ 100 ms',
				at: { sec: 1.5, frame: 45, timecode: '00:00:01:15' },
				message: expect.stringContaining('4 black frames (133 ms) at the cut'),
			},
		]);
		expect(failing(r.rows)).toEqual(['cut-black']);
		expect(r.verified).toBe(false);
		// the same black after a cut to a gap is intended
		const intended = await verifyExportFile({
			ff,
			file,
			context: context({
				cuts: [{ frame: CUT, kind: 'cut', blackBefore: false, blackAfter: true, effect: false }],
			}),
			target: null,
			checks: 'full',
		});
		expect(rowsOf(intended.rows, 'cut-black')[0]!.status).toBe('pass');
	});

	it('finds a single-frame flash at a cut (warn under a transition or effect)', {
		timeout: 60_000,
	}, async () => {
		const file = make('flash.mp4', video({ color: 'white', frames: 1 }), SINE);
		const r = await verifyExportFile({ ff, file, context: context(), target: null, checks: 'full' });
		const flash = rowsOf(r.rows, 'cut-flash');
		expect(flash).toHaveLength(1);
		expect(flash[0]).toMatchObject({
			id: 'cut-flash',
			kind: 'judgement',
			status: 'fail',
			expected: 0,
			tolerance: 0.25,
			at: { frame: 45, timecode: '00:00:01:15' },
		});
		expect(flash[0]!.measured as number).toBeGreaterThan(0.25);
		expect(failing(r.rows)).toEqual(['cut-flash']);
		const designed = await verifyExportFile({
			ff,
			file,
			context: context({
				cuts: [{ frame: CUT, kind: 'cut', blackBefore: false, blackAfter: false, effect: true }],
			}),
			target: null,
			checks: 'full',
		});
		expect(rowsOf(designed.rows, 'cut-flash')[0]!.status).toBe('warn');
		expect(designed.verified).toBe(true);
	});

	it('finds a click injected at a cut', { timeout: 60_000 }, async () => {
		// a 2-sample spike 3 ms after the cut
		const file = make('click.mp4', video(), `${SINE}+if(between(t\\,1.503\\,1.503+1.5/48000)\\,0.6\\,0)`);
		const r = await verifyExportFile({ ff, file, context: context(), target: null, checks: 'full' });
		const click = rowsOf(r.rows, 'cut-click');
		expect(click).toHaveLength(1);
		expect(click[0]).toMatchObject({ id: 'cut-click', kind: 'judgement', status: 'fail', expected: null });
		expect(click[0]!.measured as number).toBeGreaterThan(VERIFY_THRESHOLDS.clickOverRmsDb);
		expect(Math.abs(click[0]!.at!.sec - 1.503)).toBeLessThan(0.003);
		expect(failing(r.rows)).toEqual(['cut-click']);
	});

	it('finds an audio stream that ends early (A/V skew)', { timeout: 60_000 }, async () => {
		const file = make('short-audio.mp4', video(), SINE, 2.5);
		const r = await verifyExportFile({ ff, file, context: context(), target: null, checks: 'full' });
		const skew = rowsOf(r.rows, 'av-skew')[0]!;
		expect(skew).toMatchObject({
			id: 'av-skew',
			kind: 'format',
			status: 'fail',
			expected: 0,
			tolerance: 0.25,
		});
		expect(skew.measured as number).toBeCloseTo(-0.5, 1);
		expect(skew.message).toContain('before the video');
		expect(failing(r.rows)).toEqual(['av-skew']);
	});

	it('finds wrong loudness and a true peak over the ceiling', { timeout: 60_000 }, async () => {
		const quiet = make('quiet.mp4', video(), '0.02*sin(2*PI*440*t)');
		const q = await verifyExportFile({ ff, file: quiet, context: context(), target: null, checks: 'full' });
		const loud = rowsOf(q.rows, 'loudness')[0]!;
		expect(loud).toMatchObject({ kind: 'judgement', status: 'fail', expected: -21, tolerance: 1 });
		expect(loud.measured as number).toBeLessThan(-30);
		expect(failing(q.rows)).toEqual(['loudness']);
		const hot = make('hot.mp4', video(), '0.99*sin(2*PI*440*t)');
		const h = await verifyExportFile({
			ff,
			file: hot,
			context: context({ normalize: { targetLufs: -1, truePeakDb: -3 } }),
			target: null,
			checks: 'full',
		});
		expect(rowsOf(h.rows, 'true-peak')[0]).toMatchObject({ kind: 'format', status: 'fail', expected: -3 });
	});

	it('lists digital silence longer than 2 s (warn)', { timeout: 60_000 }, async () => {
		const file = make('silent.mp4', video(), `if(between(t\\,0.3\\,2.6)\\,0\\,${SINE})`);
		const r = await verifyExportFile({ ff, file, context: context(), target: null, checks: 'full' });
		const s = rowsOf(r.rows, 'silence');
		expect(s).toHaveLength(1);
		expect(s[0]).toMatchObject({ kind: 'judgement', status: 'warn', tolerance: 2 });
		expect(s[0]!.measured as number).toBeGreaterThan(2);
		expect(s[0]!.at!.sec).toBeGreaterThan(0.25);
		expect(s[0]!.at!.sec).toBeLessThan(0.36);
	});

	it('finds streams that do not match the export settings', { timeout: 30_000 }, async () => {
		const file = join(dir, 'clean.mp4');
		const r = await verifyExportFile({
			ff,
			file,
			context: context({
				expected: { ...context().expected, audio: { codec: 'opus', sampleRate: 44100, channels: 6 } },
			}),
			target: null,
			checks: 'fast',
		});
		const s = rowsOf(r.rows, 'streams')[0]!;
		expect(s.status).toBe('fail');
		expect(s.message).toContain('audio codec aac, expected opus');
		expect(s.message).toContain('sample rate 48000 Hz, expected 44100 Hz');
		expect(s.message).toContain('2 channels, expected 6');
		// an export of an older build (no context): format rows are unverified, so it is not verified
		const old = await verifyExportFile({ ff, file, context: null, target: null, checks: 'fast' });
		expect(old.rows.map((x) => [x.id, x.status])).toEqual([
			['streams', 'unverified'],
			['duration', 'unverified'],
			['av-skew', 'pass'],
			['uncovered-video', 'unverified'],
		]);
		expect(old.verified).toBe(false);
	});

	it('adds the delivery target rows', { timeout: 60_000 }, async () => {
		const file = join(dir, 'clean.mp4');
		const yt = await verifyExportFile({ ff, file, context: context(), target: 'youtube', checks: 'full' });
		expect(yt.rows.filter((x) => x.id.startsWith('target-')).map((x) => [x.id, x.kind, x.status])).toEqual([
			['target-container', 'format', 'pass'],
			['target-aspect', 'judgement', 'pass'],
			['target-resolution', 'judgement', 'warn'],
			['target-duration', 'format', 'pass'],
			['target-frame-rate', 'judgement', 'pass'],
			['target-size', 'format', 'pass'],
			['target-loudness', 'judgement', 'warn'],
		]);
		expect(yt.verified).toBe(true);
		const shorts = await verifyExportFile({
			ff,
			file,
			context: context(),
			target: 'youtube-shorts',
			checks: 'fast',
		});
		const aspect = rowsOf(shorts.rows, 'target-aspect')[0]!;
		expect(aspect).toMatchObject({ kind: 'format', status: 'fail', measured: '320:180', expected: '9:16' });
		expect(aspect.message).toContain('auto_reframe_sequence');
		expect(rowsOf(shorts.rows, 'target-loudness')[0]!.status).toBe('unverified');
		expect(shorts.verified).toBe(false);
		const ig = await verifyExportFile({
			ff,
			file,
			context: context(),
			target: 'instagram-reels',
			checks: 'fast',
		});
		expect(rowsOf(ig.rows, 'target-loudness')[0]).toMatchObject({ status: 'unverified', expected: null });
	});
});

describe('detectors', () => {
	it('a hard step in a low-frequency signal is a click; broadband noise and a clean tone are not', () => {
		const sr = 48_000;
		const n = 4800;
		const tone = new Float32Array(n).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 200 * i) / sr));
		expect(detectCutClick([tone], sr, 2400)).toBeNull();
		// an edit without a fade: the tone jumps from its peak (+0.2) to −0.2
		const jump = tone.map((v, i) => (i >= 2460 ? -v : v));
		expect(detectCutClick([jump], sr, 2460)).toMatchObject({ sample: 2460, channel: 0 });
		let seed = 7;
		const noise = new Float32Array(n).map(() => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return 0.2 * (seed / 2 ** 31 - 0.5);
		});
		expect(detectCutClick([noise], sr, 2400)).toBeNull();
		expect(detectCutClick([new Float32Array(n)], sr, 2400)).toBeNull();
	});

	it('black runs are counted only where the timeline intends a picture, flashes against both neighbours', () => {
		const luma = (dark: number[]) => (f: number) =>
			dark.includes(f) ? { mean: 0, peakCell: 0 } : { mean: 0.5, peakCell: 0.5 };
		const cut = { fileFrame: 45, blackBefore: false, blackAfter: false };
		expect(cutPictureFindings(luma([45, 46, 47]), cut, 30, 90)).toEqual([
			{ kind: 'black', startFrame: 45, frames: 3 },
		]);
		// 2 frames = 67 ms: not a black run, the second frame is no single-frame flash either
		expect(cutPictureFindings(luma([45, 46]), cut, 30, 90)).toEqual([]);
		expect(cutPictureFindings(luma([45]), cut, 30, 90)).toEqual([{ kind: 'flash', frame: 45, jump: 0.5 }]);
		expect(cutPictureFindings(luma([42, 43, 44]), { ...cut, blackBefore: true }, 30, 90)).toEqual([]);
		expect(cutPictureFindings(luma([45, 46, 47]), { ...cut, blackAfter: true }, 30, 90)).toEqual([]);
		// a small picture on black: dark on average, one bright cell — not black
		const small = () => ({ mean: 0.04, peakCell: 0.45 });
		expect(cutPictureFindings(small, cut, 30, 90)).toEqual([]);
	});

	it('pixel formats match by subsampling, depth and alpha', () => {
		expect(pixFmtMatches('nv12', 'yuv420p', false)).toBe(true);
		expect(pixFmtMatches('p010le', 'yuv420p10le', false)).toBe(true);
		expect(pixFmtMatches('yuv444p10le', 'yuv444p12le', false)).toBe(true);
		expect(pixFmtMatches('yuva444p10le', 'yuv444p12le', true)).toBe(false);
		expect(pixFmtMatches('yuv422p10le', 'yuv420p10le', false)).toBe(false);
		expect(pixFmtMatches('yuv420p10le', 'yuv420p', false)).toBe(false);
	});

	it('verified = no fail and no unverified format row', () => {
		const row = (status: VerifyRow['status'], kind: VerifyRow['kind']): VerifyRow => ({
			id: 'streams',
			kind,
			status,
			measured: null,
			expected: null,
			tolerance: null,
			message: '',
		});
		expect(
			summarizeRows([row('pass', 'format'), row('unverified', 'judgement'), row('warn', 'judgement')])
				.verified,
		).toBe(true);
		expect(summarizeRows([row('unverified', 'format')]).verified).toBe(false);
		expect(summarizeRows([row('fail', 'judgement')]).verified).toBe(false);
	});
});
