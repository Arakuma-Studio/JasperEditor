// spec 18 AF-EXP-003: Export mode ▸ Export As — Video, Animated GIF (rate, width, loop, dither, palette; no sound
// fields, no codec / colour / smart render) or Audio Only WAV / FLAC / M4A (bit depth or bit rate with the channels,
// rate and loudness; no picture fields, no engine). The choice reaches the plan and the export, names the file's
// extension, and is remembered per sequence.
import type { EngineJob, ExportSettings, RenderPlan } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportMode } from '../src/export/ExportMode.tsx';
import { exportMode, takeTrackedExport } from '../src/export/mode.ts';
import { exportAudioOf } from '../src/export/SoundCheckGate.tsx';
import {
	buildExportSettings,
	DEFAULT_GIF_CHOICE,
	exportExtension,
	lastExportAudio,
	loadExportChoice,
	outputDescription,
	sanitizeFileName,
	saveExportChoice,
	validateExport,
} from '../src/export/settings.ts';
import { notices } from '../src/home/notices.tsx';
import { buildMediaAsset } from '../src/import/assets.ts';
import { EngineProvider } from '../src/state/engine.tsx';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	for (const n of notices.getAll()) notices.dismiss(n.id);
	exportMode.close();
	localStorage.clear();
});

function wrap(engine: ScriptedEngine, session: EditorSession, children: ReactNode) {
	return (
		<EngineProvider client={engine.client()}>
			<MemoryRouter initialEntries={['/']}>
				<SessionProvider session={session}>{children}</SessionProvider>
			</MemoryRouter>
		</EngineProvider>
	);
}

const planOf = (s: ExportSettings): RenderPlan => ({
	planId: 'plan_1',
	documentRevision: 0,
	path: s.container === 'wav' || s.container === 'flac' || s.container === 'm4a' ? 'audio' : 'native',
	segments: [],
	audio: { mode: 'native-mix' },
	blockers: [],
	warnings:
		s.container === 'gif'
			? [{ code: 'GIF_NO_AUDIO', message: "GIF files have no sound: the sequence's audio is not exported" }]
			: [],
	estimate: { seconds: 2, bytes: 1000 },
	...(s.container === 'gif'
		? {
				deliverable: {
					kind: 'gif' as const,
					fps: s.gif?.fps ?? 15,
					width: s.gif?.width ?? 1080,
					height: Math.round(((s.gif?.width ?? 1080) * 9) / 16 / 2) * 2,
					frames: 30,
					loop: s.gif?.loop ?? 0,
					dither: s.gif?.dither ?? 'sierra2_4a',
					palette: s.gif?.palette ?? 'full',
				},
			}
		: {}),
});

async function setup() {
	const { session } = await memorySession();
	const seqId = Object.keys(session.getCommitted().sequences)[0]!;
	const reg = registered('clip.mp4', { key: 'mk_CLIP00001', kind: 'video', seconds: 2 });
	const r = session.apply({
		label: 'Insert clip',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: buildMediaAsset(reg, { id: session.ctx.ids.next('med'), now: 't' }),
				ref: '$m',
			},
			{ type: 'clip.place', sequenceId: seqId, source: { mediaId: '$m' }, at: 0 },
		],
	});
	if (!r.ok) throw new Error(r.errors[0]!.message);
	const engine = new ScriptedEngine();
	const planned: { settings: ExportSettings }[] = [];
	const started: { settings: ExportSettings }[] = [];
	engine.on((q) => {
		if (q.path === '/api/exports/plan') {
			const body = q.body as { settings: ExportSettings };
			planned.push(body);
			return { body: planOf(body.settings) };
		}
		if (q.path === '/api/exports') {
			started.push(q.body as { settings: ExportSettings });
			const job: EngineJob = {
				id: 'exp1',
				kind: 'export',
				state: 'queued',
				title: 'export job',
				origin: { type: 'user' },
				progress: null,
				createdAt: '2026-10-31T10:00:00.000Z',
				priority: 'user',
				cpuSlots: 1,
			};
			return { body: job };
		}
		return undefined;
	});
	exportMode.open(seqId);
	render(wrap(engine, session, <ExportMode sequenceId={seqId} />));
	return { session, seqId, planned, started };
}

const settle = async () => {
	await act(async () => {});
	await act(async () => vi.advanceTimersByTimeAsync(1000));
};

describe('buildExportSettings for GIF and audio-only files', () => {
	it('a GIF has gif options and no video / audio; audio-only files carry their codec and depth or rate', async () => {
		const { session } = await memorySession();
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		const gif = buildExportSettings(seq, {
			range: 'entire',
			engine: 'native',
			format: 'gif',
			gif: { fps: 12, width: 480, loop: 1, dither: 'bayer', palette: 'single' },
			credits: 'md',
		});
		expect(gif).toMatchObject({
			container: 'gif',
			engine: 'native',
			gif: { fps: 12, width: 480, loop: 1, dither: 'bayer', palette: 'single' },
		});
		expect(gif.video).toBeUndefined();
		expect(gif.audio).toBeUndefined();
		expect(gif.credits).toBeUndefined();
		// the automatic width is the engine's (sequence width capped at 1080)
		expect(buildExportSettings(seq, { range: 'entire', engine: 'auto', format: 'gif' }).gif).toEqual({
			fps: 15,
			loop: 0,
			dither: 'sierra2_4a',
			palette: 'full',
		});
		const wav = buildExportSettings(seq, {
			range: 'entire',
			engine: 'remotion',
			format: 'wav',
			audioFile: { bitDepth: 16, bitrateKbps: 256 },
			audio: { channels: 1, sampleRate: 44100, loudness: -16 },
		});
		expect(wav).toMatchObject({
			container: 'wav',
			engine: 'auto',
			audio: {
				codec: 'pcm',
				bitDepth: 16,
				channels: 1,
				sampleRate: 44100,
				normalize: { targetLufs: -16, truePeakDb: -1 },
			},
		});
		expect(wav.video).toBeUndefined();
		expect(wav.audio?.bitrateKbps).toBeUndefined();
		expect(buildExportSettings(seq, { range: 'entire', engine: 'auto', format: 'flac' }).audio).toMatchObject(
			{
				codec: 'flac',
				bitDepth: 24,
			},
		);
		const m4a = buildExportSettings(seq, {
			range: 'entire',
			engine: 'auto',
			format: 'm4a',
			audioFile: { bitDepth: 24, bitrateKbps: 128 },
		});
		expect(m4a.audio).toMatchObject({ codec: 'aac', bitrateKbps: 128 });
		expect(m4a.audio?.bitDepth).toBeUndefined();
	});

	it('extensions, descriptions, validation, Sound Check encodings and remembered choices', async () => {
		const { session } = await memorySession();
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		expect(exportExtension(null, 'gif')).toBe('gif');
		expect(exportExtension({ container: 'mov' } as never, 'gif')).toBe('gif');
		expect(exportExtension(null, 'flac')).toBe('flac');
		expect(exportExtension({ container: 'webm' } as never, 'mp4')).toBe('webm');
		expect(sanitizeFileName('loop.gif', 'gif')).toBe('loop');
		expect(sanitizeFileName('loop.gif', 'wav')).toBe('loop.gif');
		const gif = buildExportSettings(seq, { range: 'entire', engine: 'auto', format: 'gif' });
		expect(outputDescription(seq, 60, null, false, { settings: gif })).toBe(
			'1080×608 · 15 fps · GIF · loops forever · no audio · 2s',
		);
		const wav = buildExportSettings(seq, { range: 'entire', engine: 'auto', format: 'wav' });
		expect(outputDescription(seq, 60, null, false, { settings: wav })).toBe(
			'WAV · PCM 24-bit · 48 kHz stereo · no picture · 2s',
		);
		// odd frame sizes block H.264 only
		const odd = { ...seq, settings: { ...seq.settings, width: 1081 } };
		expect(validateExport(odd, { start: 0, end: 10 })).toHaveLength(1);
		expect(validateExport(odd, { start: 0, end: 10 }, 'gif')).toEqual([]);
		expect(validateExport(odd, { start: 0, end: 10 }, 'wav')).toEqual([]);
		expect(exportAudioOf('flac', { sampleRate: 48000 })).toEqual({ codec: 'pcm', sampleRate: 48000 });
		saveExportChoice(session.projectId, seq.id, {
			range: 'entire',
			engine: 'auto',
			format: 'm4a',
			audioFile: { bitDepth: 24, bitrateKbps: 128 },
		});
		expect(lastExportAudio(session.projectId, seq)).toEqual({
			audio: { codec: 'aac', bitrateKbps: 128 },
		});
		saveExportChoice(session.projectId, seq.id, { range: 'entire', engine: 'auto', format: 'gif' });
		expect(lastExportAudio(session.projectId, seq)).toBeNull();
		// hostile storage falls back to the defaults
		localStorage.setItem(
			`jasper.export.${session.projectId}.${seq.id}`,
			JSON.stringify({
				format: 'avi',
				gif: { fps: 500, width: 3, loop: -2, dither: 'x', palette: 7 },
				audioFile: { bitDepth: 32, bitrateKbps: 1 },
			}),
		);
		const r = loadExportChoice(session.projectId, seq.id)!;
		expect(r.format).toBeUndefined();
		expect(r.gif).toEqual(DEFAULT_GIF_CHOICE);
		expect(r.audioFile).toEqual({ bitDepth: 24, bitrateKbps: 256 });
	});
});

describe('Export mode ▸ Export As (AF-EXP-003)', () => {
	it('Animated GIF: its fields replace the codec, colour and sound fields; the choice reaches the export', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { session, seqId, planned, started } = await setup();
		await settle();
		expect(planned.at(-1)!.settings.container).toBe('mp4');
		expect(screen.queryByTestId('export-gif')).toBeNull();
		fireEvent.change(screen.getByTestId('export-format'), { target: { value: 'gif' } });
		await settle();
		expect(screen.getByTestId('export-gif')).toBeTruthy();
		for (const id of ['export-codec', 'export-color-space', 'export-audio-channels', 'export-smart-render'])
			expect(screen.queryByTestId(id), id).toBeNull();
		expect(screen.getByTestId('export-engine')).toBeTruthy();
		fireEvent.change(screen.getByTestId('export-gif-fps'), { target: { value: '10' } });
		fireEvent.change(screen.getByTestId('export-gif-width'), { target: { value: '480' } });
		fireEvent.change(screen.getByTestId('export-gif-loop'), { target: { value: 'count' } });
		fireEvent.change(screen.getByTestId('export-gif-plays'), { target: { value: '4' } });
		fireEvent.change(screen.getByTestId('export-gif-dither'), { target: { value: 'bayer' } });
		fireEvent.change(screen.getByTestId('export-gif-palette'), { target: { value: 'diff' } });
		await settle();
		expect(planned.at(-1)!.settings).toMatchObject({
			container: 'gif',
			gif: { fps: 10, width: 480, loop: 4, dither: 'bayer', palette: 'diff' },
		});
		expect(screen.getByText(/480×270 · 10 fps · GIF · 30 frames · plays 4 times · no audio/)).toBeTruthy();
		expect(screen.getByText(/GIF files have no sound: the sequence's audio is not exported/)).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByTestId('export-start'));
		});
		expect(started).toHaveLength(1);
		expect(started[0]!.settings.container).toBe('gif');
		expect(takeTrackedExport('exp1')).toMatch(/\.gif$/);
		expect(loadExportChoice(session.projectId, seqId)).toMatchObject({
			format: 'gif',
			gif: { fps: 10, width: 480, loop: 4, dither: 'bayer', palette: 'diff' },
		});
	});

	it('Audio Only: bit depth or bit rate with the sound fields; no picture fields; the file is .wav / .m4a', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { planned, started } = await setup();
		fireEvent.change(screen.getByTestId('export-format'), { target: { value: 'wav' } });
		await settle();
		for (const id of ['export-codec', 'export-engine', 'export-use-previews', 'export-gif'])
			expect(screen.queryByTestId(id), id).toBeNull();
		expect(screen.getByTestId('export-audio-channels')).toBeTruthy();
		fireEvent.change(screen.getByTestId('export-audio-bit-depth'), { target: { value: '16' } });
		fireEvent.change(screen.getByTestId('export-audio-channels'), { target: { value: '1' } });
		await settle();
		expect(planned.at(-1)!.settings).toMatchObject({
			container: 'wav',
			audio: { codec: 'pcm', bitDepth: 16, channels: 1 },
		});
		expect(planned.at(-1)!.settings.video).toBeUndefined();
		fireEvent.change(screen.getByTestId('export-format'), { target: { value: 'm4a' } });
		await settle();
		expect(screen.queryByTestId('export-audio-bit-depth')).toBeNull();
		fireEvent.change(screen.getByTestId('export-audio-bitrate'), { target: { value: '320' } });
		await settle();
		expect(planned.at(-1)!.settings).toMatchObject({
			container: 'm4a',
			audio: { codec: 'aac', bitrateKbps: 320, channels: 1 },
		});
		expect(screen.getByText(/M4A · AAC 320 kb\/s · 48 kHz mono · no picture/)).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByTestId('export-start'));
		});
		expect(started.at(-1)!.settings.container).toBe('m4a');
		expect(takeTrackedExport('exp1')).toMatch(/\.m4a$/);
	});
});
