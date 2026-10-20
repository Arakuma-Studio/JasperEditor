// Engine-composed export warnings in the UI language (final carry-over cleanup, item 6; WP6.5a 7l): the engine sends
// `code` + `params` with its English `message`; the editor says the known codes in its language — in English exactly
// the engine's words — and falls back to the message for anything it cannot read.
import type { ExportWarningParams } from '@jasper/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanSummary } from '../src/export/PlanSummary.tsx';
import { exportWarningText } from '../src/export/warning-text.ts';
import { exportResultDetail } from '../src/home/ProjectLifecycle.tsx';
import { setLanguage } from '../src/i18n/runtime.ts';

/** What the engine sends (its messages verbatim from apps/engine/test/{sound-export-credits,export-container}). */
const ENGINE: { code: string; message: string; params: ExportWarningParams }[] = [
	{
		code: 'W_SOUND_CREDITS',
		message:
			'2 sounds heard in this export need a credit (CC-BY-4.0, CC-BY-SA-4.0: "Rain", "Wind") and no credits file is written: choose a Credits format or credit them yourself',
		params: { count: 2, licences: 'CC-BY-4.0, CC-BY-SA-4.0', titles: '"Rain", "Wind"', more: false },
	},
	{
		code: 'W_SOUND_CREDITS',
		message:
			'1 sound heard in this export needs a credit (CC-BY-4.0: "Rain") and no credits file is written: choose a Credits format or credit it yourself',
		params: { count: 1, licences: 'CC-BY-4.0', titles: '"Rain"', more: false },
	},
	{
		code: 'W_SOUND_LICENSE_NC',
		message: '3 sounds heard in this export are licensed for non-commercial use only (CC-BY-NC-4.0)',
		params: { count: 3, licences: 'CC-BY-NC-4.0' },
	},
	{
		code: 'W_SOUND_SHARE_ALIKE',
		message:
			'4 sounds heard in this export are ShareAlike (CC-BY-SA-4.0: "A", "B", "C"…): the video must be shared under CC BY-SA or a compatible licence',
		params: { count: 4, licences: 'CC-BY-SA-4.0', titles: '"A", "B", "C"', more: true },
	},
	{
		code: 'W_SOUND_CHECK_STALE',
		message:
			'The last Sound Check of this sequence is out of date (the mix changed since): run it again to check what you deliver',
		params: { state: 'stale', reason: 'mix' },
	},
	{
		code: 'W_SOUND_CHECK_STALE',
		message: 'The last Sound Check of this sequence failed (2 errors): review its findings before delivering',
		params: { state: 'failed', errors: 2 },
	},
	{
		code: 'OUTPUT_CONTAINER_CHANGED',
		message:
			'MP4 was requested but MP4 does not carry ProRes (MP4 takes H.264, HEVC, AV1, VP9): the file is MOV',
		params: {
			requested: 'MP4',
			written: 'MOV',
			why: 'codec',
			codec: 'ProRes',
			accepts: 'H.264, HEVC, AV1, VP9',
		},
	},
	{
		code: 'OUTPUT_CONTAINER_CHANGED',
		message: 'WEBM was requested but WebM needs Opus audio, which this ffmpeg build lacks: the file is MP4',
		params: { requested: 'WEBM', written: 'MP4', why: 'opus', codec: 'VP9' },
	},
	{
		code: 'AUDIO_CODEC_CHANGED',
		message: 'AAC audio was requested but ProRes masters carry PCM audio: the audio is PCM',
		params: { requested: 'AAC', written: 'PCM', container: 'MOV', why: 'prores' },
	},
	{
		code: 'AUDIO_CODEC_CHANGED',
		message: 'PCM audio was requested but MP4 does not carry PCM audio (PCM needs MOV): the audio is AAC',
		params: { requested: 'PCM', written: 'AAC', container: 'MP4', why: 'container' },
	},
	// the delivered audio missed its target (apps/engine/src/export/service.ts `deliveryWarnings`)
	{
		code: 'AUDIO_TRUE_PEAK_OVER',
		message:
			'The delivered audio peaks at -0.7 dBTP, over the -1 dBTP target: lower the loudest moments or use a higher audio bit rate',
		params: { truePeakDbtp: -0.7, targetDbtp: -1 },
	},
	{
		code: 'AUDIO_LOUDNESS_CEILING',
		message:
			'The delivered audio measures -6.7 LUFS, not the -2 LUFS target: the true-peak limiter cannot make it louder under its -6.0 dBTP ceiling',
		params: { integratedLufs: -6.7, targetLufs: -2, ceilingDbtp: -6, why: 'ceiling' },
	},
	{
		code: 'AUDIO_LOUDNESS_CEILING',
		message: 'The delivered audio measures -14.8 LUFS, not the -14 LUFS target',
		params: { integratedLufs: -14.8, targetLufs: -14, ceilingDbtp: -1.5, why: 'converge' },
	},
];

afterEach(async () => {
	cleanup();
	await setLanguage('en');
});

describe('export warnings in the UI language', () => {
	it('in English: exactly the engine’s words, from code + params', () => {
		for (const w of ENGINE) expect(exportWarningText(w), w.code).toBe(w.message);
	});

	it('in Spanish: every code with params is translated, its values kept', async () => {
		await setLanguage('es');
		for (const w of ENGINE) {
			const text = exportWarningText(w);
			expect(text, w.message).not.toBe(w.message);
			// the values the English says (licences, titles, containers, codecs, counts) are in the Spanish too
			for (const [k, v] of Object.entries(w.params))
				if (!['why', 'reason', 'state', 'more'].includes(k) && w.message.includes(String(v)))
					expect(text, `${w.code}: ${v}`).toContain(String(v));
		}
		expect(exportWarningText(ENGINE[0]!)).toContain('2 sonidos');
	});

	it('falls back to the engine’s message: an unknown code, no params, malformed params', async () => {
		await setLanguage('es');
		expect(exportWarningText({ code: 'W_SOMETHING_NEW', message: 'New thing', params: { a: 1 } })).toBe(
			'New thing',
		);
		expect(exportWarningText({ code: 'W_SOUND_CREDITS', message: 'Old engine' })).toBe('Old engine');
		expect(
			exportWarningText({ code: 'W_SOUND_CREDITS', message: 'Bad', params: { count: 'two', licences: 3 } }),
		).toBe('Bad');
		expect(
			exportWarningText({
				code: 'AUDIO_CODEC_CHANGED',
				message: 'Bad',
				params: { requested: 'PCM', why: 'x' },
			}),
		).toBe('Bad');
		expect(exportWarningText({ code: 'W_SOUND_CHECK_STALE', message: 'Bad', params: { state: 'odd' } })).toBe(
			'Bad',
		);
	});

	it('the Export dialog’s plan summary and the finished-export notice say them in Spanish', async () => {
		await setLanguage('es');
		const w = ENGINE[9]!;
		render(
			<PlanSummary
				engine="auto"
				state={{
					status: 'ok',
					plan: {
						planId: 'p',
						path: 'native',
						segments: [],
						audio: { mode: 'mixdown' },
						blockers: [],
						warnings: [w],
						estimate: { seconds: 1, bytes: 1 },
					} as never,
				}}
			/>,
		);
		const li = screen.getByTestId('plan-warnings').querySelector(`[data-code="${w.code}"]`)!;
		expect(li.textContent).toContain(exportWarningText(w));
		expect(li.textContent).not.toContain(w.message);
		const detail = exportResultDetail({
			credits: { name: 'output.credits.md', count: 2 },
			warnings: [w, ENGINE[4]],
		})!;
		expect(detail).toContain(exportWarningText(w));
		expect(detail).toContain(exportWarningText(ENGINE[4]!));
		expect(detail).not.toContain('Sound credits file written');
	});
});

describe('delivered audio that misses its target', () => {
	it('the finished-export notice repeats AUDIO_TRUE_PEAK_OVER / AUDIO_LOUDNESS_CEILING in the UI language', async () => {
		const over = ENGINE.find((w) => w.code === 'AUDIO_TRUE_PEAK_OVER')!;
		const ceiling = ENGINE.find((w) => w.code === 'AUDIO_LOUDNESS_CEILING')!;
		expect(exportResultDetail({ warnings: [over, ceiling] })).toBe(`${over.message} ${ceiling.message}`);
		await setLanguage('es');
		const detail = exportResultDetail({ warnings: [over] })!;
		expect(detail).toContain('El audio entregado alcanza -0.7 dBTP');
		expect(
			exportWarningText({ code: 'AUDIO_TRUE_PEAK_OVER', message: 'Old', params: { truePeakDbtp: 'x' } }),
		).toBe('Old');
	});
});
