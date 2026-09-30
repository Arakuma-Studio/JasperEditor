// Third-party license information for the About / Licenses dialog (ARCHITECTURE D-13): FFmpeg's license
// text and the link to its exact source must be offered with the app. The LGPL binaries directory written
// by `pnpm ffmpeg:lgpl` carries LICENSE-FFmpeg.txt, NOTICE-FFmpeg.txt, BUILDINFO.json (and COPYING.GPLv3.txt
// for LGPL 3 builds, which the LGPL 3 requires to accompany it); an ffmpeg found elsewhere (env, PATH) is
// the user's own build and is reported as not bundled.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LicenseComponent, LicensesResponse } from '@jasper/api';

export const FFMPEG_SOURCE_FALLBACK = 'https://ffmpeg.org/download.html';

type BuildInfo = {
	ffmpeg?: {
		version?: string | null;
		license?: string;
		sourceUrl?: string;
		origin?: { kind?: string; release?: string; url?: string };
	};
};

const read = (file: string) => readFile(file, 'utf8').catch(() => null);

const DESCRIPTIONS: Record<string, string> = {
	lgpl: 'LGPL build found on this system (not distributed with JasperEditor)',
	gpl: 'GPL build found on this system (not distributed with JasperEditor)',
	nonfree: 'Non-free build found on this system (not distributed with JasperEditor)',
	unknown: 'Unknown build found on this system (not distributed with JasperEditor)',
};

/** The FFmpeg entry: from the LGPL binaries directory next to `ffmpegPath`, or a "system build" note. */
export async function ffmpegLicense(input: {
	ffmpegPath: string | null;
	ffmpegVersion: string | null;
	/** Build license from the self-check (`-version` configuration). */
	license: 'lgpl' | 'gpl' | 'nonfree' | 'unknown';
}): Promise<LicenseComponent | null> {
	if (!input.ffmpegPath) return null;
	const dir = dirname(await realpath(input.ffmpegPath).catch(() => input.ffmpegPath!));
	const [infoText, text, notice, gpl3] = await Promise.all([
		read(join(dir, 'BUILDINFO.json')),
		read(join(dir, 'LICENSE-FFmpeg.txt')),
		read(join(dir, 'NOTICE-FFmpeg.txt')),
		read(join(dir, 'COPYING.GPLv3.txt')),
	]);
	let info: BuildInfo | null = null;
	try {
		info = infoText ? (JSON.parse(infoText) as BuildInfo) : null;
	} catch {
		info = null;
	}
	// Only a directory with the license text and a build that really is LGPL counts as our bundled build.
	if (!info?.ffmpeg || !text || input.license !== 'lgpl') {
		return {
			id: 'ffmpeg',
			name: 'FFmpeg',
			version: input.ffmpegVersion,
			license: DESCRIPTIONS[input.license] ?? DESCRIPTIONS.unknown!,
			bundled: false,
			sourceUrl: FFMPEG_SOURCE_FALLBACK,
			texts: [],
		};
	}
	const spdx = info.ffmpeg.license ?? 'LGPL-2.1-or-later';
	const origin = info.ffmpeg.origin;
	return {
		id: 'ffmpeg',
		name: 'FFmpeg',
		version: input.ffmpegVersion ?? info.ffmpeg.version ?? null,
		license: spdx,
		bundled: true,
		sourceUrl: info.ffmpeg.sourceUrl ?? FFMPEG_SOURCE_FALLBACK,
		...(origin?.kind === 'btbn' && origin.release
			? { buildUrl: `https://github.com/BtbN/FFmpeg-Builds/releases/tag/${origin.release}` }
			: {}),
		...(notice ? { notice } : {}),
		texts: [
			{
				title: spdx.startsWith('LGPL-3')
					? 'GNU Lesser General Public License, version 3'
					: 'GNU Lesser General Public License, version 2.1',
				text,
			},
			...(gpl3
				? [
						{
							title:
								'GNU General Public License, version 3 (the LGPL 3 refers to it; FFmpeg here is LGPL, not GPL)',
							text: gpl3,
						},
					]
				: []),
		],
	};
}

/**
 * M2 (additive): packages that ship third-party runtimes or model weights (wp-m2-process: vid.stab WASM,
 * ONNX Runtime, OpenCV.js, the SPAN weights) contribute their entries to Help ▸ About ▸ Licenses.
 */
export type LicenseProvider = () => Promise<LicenseComponent[]> | LicenseComponent[];
const licenseProviders = new Set<LicenseProvider>();
export function registerLicenseProvider(fn: LicenseProvider): () => void {
	licenseProviders.add(fn);
	return () => licenseProviders.delete(fn);
}

export async function thirdPartyLicenses(
	input: Parameters<typeof ffmpegLicense>[0],
): Promise<LicensesResponse> {
	const ffmpeg = await ffmpegLicense(input);
	const extra: LicenseComponent[] = [];
	for (const p of licenseProviders) {
		try {
			extra.push(...(await p()));
		} catch {
			// a broken provider never hides the FFmpeg entry
		}
	}
	const seen = new Set<string>();
	const components = [...(ffmpeg ? [ffmpeg] : []), ...extra].filter(
		(c) => !seen.has(c.id) && !!seen.add(c.id),
	);
	return { components };
}
