import { EngineClient } from '@jasper/engine-client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThirdPartyLicenses } from '../src/shell/licenses.tsx';
import { EngineProvider } from '../src/state/engine.tsx';

const BUNDLED = {
	id: 'ffmpeg',
	name: 'FFmpeg',
	version: 'n7.1.5-12-g1fdbca85aa',
	license: 'LGPL-3.0-or-later',
	bundled: true,
	sourceUrl: 'https://github.com/FFmpeg/FFmpeg/tree/1fdbca85aa',
	buildUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-31-14-10',
	notice: 'FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/1fdbca85aa',
	texts: [
		{ title: 'GNU Lesser General Public License, version 3', text: 'GNU LESSER GENERAL PUBLIC LICENSE' },
	],
};

function fakeEngine(opts: { licenses?: unknown; remotionMessage?: string }) {
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
	const fetchImpl = (async (url: string) => {
		if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
		if (url === '/api/licenses')
			return opts.licenses ? json(opts.licenses) : json({ code: 'NOT_FOUND', message: 'x' }, 404);
		if (url === '/api/capabilities')
			return json({
				engine: { version: '0.1.0', apiVersion: 1, mode: 'dev', pathRegistration: true },
				media: { ffmpegVersion: '7.1.5', ffprobeVersion: '7.1.5', encoders: ['aac'], filters: [] },
				render: {
					native: true,
					remotionLocal: 'ready',
					remotionBinaries: {
						source: opts.remotionMessage ? 'bundled' : 'vendor',
						lgpl: !opts.remotionMessage,
						license: opts.remotionMessage ? null : 'lgpl',
						ffmpegVersion: null,
						...(opts.remotionMessage ? { message: opts.remotionMessage } : {}),
					},
					fframes: 'unavailable',
				},
				fonts: { bundledCatalog: true, systemFonts: false, customUpload: false },
				limits: { maxUploadBytes: null, freeDiskBytes: 1, cpuCount: 12, maxJsonBodyBytes: 20_971_520 },
			});
		return json({ code: 'NOT_FOUND', message: url }, 404);
	}) as unknown as typeof fetch;
	return new EngineClient({ baseUrl: '', fetch: fetchImpl });
}

describe('ThirdPartyLicenses', () => {
	afterEach(cleanup);

	it('shows the bundled FFmpeg license, its text and the source and build links', async () => {
		render(
			<EngineProvider client={fakeEngine({ licenses: { components: [BUNDLED] } })}>
				<ThirdPartyLicenses />
			</EngineProvider>,
		);
		await waitFor(() => expect(screen.getByTestId('license-ffmpeg')).toBeTruthy());
		expect(screen.getByTestId('license-ffmpeg-name').textContent).toBe('LGPL-3.0-or-later');
		expect(screen.getByTestId('license-ffmpeg-text').textContent).toContain(
			'GNU LESSER GENERAL PUBLIC LICENSE',
		);
		const source = screen.getByText('Source code') as HTMLAnchorElement;
		expect(source.href).toBe('https://github.com/FFmpeg/FFmpeg/tree/1fdbca85aa');
		expect((screen.getByText('Build') as HTMLAnchorElement).href).toContain('BtbN/FFmpeg-Builds');
		expect(screen.queryByTestId('licenses-warning')).toBeNull();
	});

	it('falls back to the static LGPL notice and shows the bundled-GPL capability warning', async () => {
		const message = 'Remotion is using its bundled GPL FFmpeg (dev only). Run `pnpm ffmpeg:lgpl`.';
		render(
			<EngineProvider client={fakeEngine({ remotionMessage: message })}>
				<ThirdPartyLicenses />
			</EngineProvider>,
		);
		await waitFor(() => expect(screen.getByTestId('licenses-warning').textContent).toBe(message));
		expect(screen.queryByTestId('license-ffmpeg')).toBeNull();
		expect((screen.getByText('FFmpeg') as HTMLAnchorElement).href).toBe('https://ffmpeg.org/');
		expect(screen.getByText('GNU Lesser General Public License')).toBeTruthy();
	});
});
