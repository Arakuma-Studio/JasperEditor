// About / Licenses entry for OpenCV.js (S09:TRK-011): `@techstark/opencv-js` (Apache-2.0), shipped with the engine
// for the tracking jobs. Read from the installed package so the version and text are always the shipped ones.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LicenseComponent } from '@jasper/api';
import { openCvPath } from './worker.ts';

export async function openCvLicense(): Promise<LicenseComponent | null> {
	let dir: string;
	try {
		dir = dirname(openCvPath());
	} catch {
		return null;
	}
	// The resolved entry is <pkg>/dist/opencv.js; the package root holds package.json and LICENSE.
	for (const root of [dirname(dir), dir]) {
		const pkgText = await readFile(join(root, 'package.json'), 'utf8').catch(() => null);
		if (!pkgText) continue;
		const pkg = JSON.parse(pkgText) as { version?: string; name?: string };
		if (pkg.name !== '@techstark/opencv-js') continue;
		const text = await readFile(join(root, 'LICENSE'), 'utf8').catch(() => null);
		return {
			id: 'opencv-js',
			name: 'OpenCV.js (@techstark/opencv-js)',
			version: pkg.version ?? null,
			license: 'Apache-2.0',
			bundled: true,
			sourceUrl: 'https://github.com/TechStark/opencv-js',
			notice: 'Used by the point and planar trackers (motion tracking, screen replacement).',
			texts: text ? [{ title: 'Apache License, Version 2.0', text }] : [],
		};
	}
	return null;
}
