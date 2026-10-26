// Licence entries of the processing runtimes and model weights (S07:PST-003/030/032, acceptance "shown in
// About/Licenses"): vid.stab (LGPL-2.1-or-later, WASM module + optional FFmpeg filters), ONNX Runtime (MIT),
// OpenCV.js (Apache-2.0) and the installed/bundled super-resolution weights (e.g. CC BY 4.0 with attribution).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LicenseComponent } from '@jasper/api';
import { ORT_CUDA_PACKAGE } from '../speech/cuda.ts';
import type { ProcessingService } from './service.ts';
import { VIDSTAB_PIN } from './vidstab-pin.ts';

const here = dirname(fileURLToPath(import.meta.url));

function readFirst(paths: string[]): string | null {
	for (const p of paths) if (existsSync(p)) return readFileSync(p, 'utf8');
	return null;
}

function packageFile(pkg: string, file: string): string | null {
	try {
		const req = createRequire(join(here, 'x.js'));
		return readFirst([join(dirname(req.resolve(`${pkg}/package.json`)), file)]);
	} catch {
		return null;
	}
}

function packageVersion(pkg: string): string | null {
	const t = packageFile(pkg, 'package.json');
	try {
		return t ? (JSON.parse(t).version as string) : null;
	} catch {
		return null;
	}
}

export async function processingLicenses(svc: ProcessingService): Promise<LicenseComponent[]> {
	const out: LicenseComponent[] = [];
	const vsDirs = [join(here, 'proc', 'vidstab'), here];
	const vsText = readFirst(vsDirs.map((d) => join(d, 'LICENSE-vidstab.txt')));
	const vsNotice = readFirst(vsDirs.map((d) => join(d, 'NOTICE-vidstab.txt')));
	out.push({
		id: 'libvidstab',
		name: 'vid.stab (libvidstab)',
		version: `${VIDSTAB_PIN.version} (${VIDSTAB_PIN.commit.slice(0, 12)})`,
		license: VIDSTAB_PIN.license,
		bundled: true,
		sourceUrl: `${VIDSTAB_PIN.repository}/tree/${VIDSTAB_PIN.commit}`,
		buildUrl: VIDSTAB_PIN.relicenseRecord,
		notice:
			vsNotice ??
			`vid.stab, relicensed to LGPL-2.1-or-later in August 2026 (${VIDSTAB_PIN.relicenseIssue}); shipped as a separate WebAssembly module (vidstab.wasm) built from the pinned commit.`,
		texts: vsText ? [{ title: 'GNU Lesser General Public License, version 2.1', text: vsText }] : [],
	});
	// The npm package ships no licence file: ours is the upstream LICENSE of the pinned release (v1.30.0).
	const ortLicense =
		packageFile('onnxruntime-node', 'LICENSE') ??
		readFirst([join(here, 'third-party', 'LICENSE-onnxruntime.txt'), join(here, 'LICENSE-onnxruntime.txt')]);
	out.push({
		id: 'onnxruntime-node',
		name: 'ONNX Runtime (onnxruntime-node)',
		version: packageVersion('onnxruntime-node'),
		license: 'MIT',
		bundled: true,
		sourceUrl: 'https://github.com/microsoft/onnxruntime',
		texts: ortLicense ? [{ title: 'MIT License', text: ortLicense }] : [],
	});
	const cvLicense = packageFile('@techstark/opencv-js', 'LICENSE');
	out.push({
		id: 'opencv-js',
		name: 'OpenCV.js (@techstark/opencv-js)',
		version: packageVersion('@techstark/opencv-js'),
		license: 'Apache-2.0',
		bundled: true,
		sourceUrl: 'https://github.com/opencv/opencv',
		buildUrl: 'https://github.com/TechStark/opencv-js',
		texts: cvLicense ? [{ title: 'Apache License 2.0', text: cvLicense }] : [],
	});
	for (const m of await svc.models.list()) {
		const e = svc.models.entry(m.id);
		if (!e) continue;
		const dir = dirname(svc.models.pathOf(e));
		const text = /^CC-BY-4\.0$/i.test(m.license) ? readFirst([join(dir, 'LICENSE-CC-BY-4.0.txt')]) : null;
		out.push({
			id: `model:${m.id}`,
			name: `${m.name} — model weights${m.installed ? '' : ' (not installed)'}`,
			version: m.sha256.slice(0, 12),
			license: m.license,
			bundled: !!e.bundled,
			sourceUrl: m.sourceUrl,
			...(m.attribution ? { notice: `Attribution: ${m.attribution}` } : {}),
			texts: text ? [{ title: 'Creative Commons Attribution 4.0 International', text }] : [],
		});
	}
	for (const m of await svc.speechModels.list()) {
		out.push({
			id: `model:${m.id}`,
			name: `${m.name} — speech model weights${m.installed ? '' : ' (not installed)'}`,
			version: m.revision.slice(0, 12),
			license: m.license,
			bundled: false,
			sourceUrl: m.sourceUrl,
			notice: `Attribution: ${m.attribution}. Licence: ${m.licenseUrl}`,
			texts: [],
		});
	}
	// spec 16 SG-006: the downloaded ONNX Runtime CUDA provider (Linux x64), with the licence and notices it ships with
	const speech = (await svc.cudaRuntimeInfo?.().catch(() => null)) ?? null;
	if (speech?.installed) {
		const lic = readFirst([join(speech.dir, 'LICENSE-onnxruntime-gpu.txt')]);
		out.push({
			id: 'runtime:onnxruntime-cuda',
			name: 'ONNX Runtime CUDA execution provider (downloaded)',
			version: ORT_CUDA_PACKAGE.ortVersion,
			license: 'MIT',
			bundled: false,
			sourceUrl: ORT_CUDA_PACKAGE.url,
			notice: `${ORT_CUDA_PACKAGE.name} ${ORT_CUDA_PACKAGE.ortVersion}, sha256 ${ORT_CUDA_PACKAGE.sha256}. Third-party notices: ThirdPartyNotices-onnxruntime-gpu.txt in ${speech.dir}. The NVIDIA CUDA and cuDNN libraries it loads are installed separately and are not part of JasperEditor.`,
			texts: lic ? [{ title: 'MIT License (ONNX Runtime)', text: lic }] : [],
		});
	}
	// WP-E9: the Describe-it search model (CLAP), with its Apache-2.0 text
	const apache = readFirst([
		join(here, 'models', 'clap', 'LICENSE-Apache-2.0.txt'),
		join(here, '..', '..', 'models', 'clap', 'LICENSE-Apache-2.0.txt'),
	]);
	for (const m of await svc.soundModels.list()) {
		out.push({
			id: `model:${m.id}`,
			name: `${m.name} — Describe-it search model weights${m.installed ? '' : ' (not installed)'}`,
			version: m.revision.slice(0, 12),
			license: m.license,
			bundled: false,
			sourceUrl: m.sourceUrl,
			notice: `Attribution: ${m.attribution}. Licence: ${m.licenseUrl}`,
			texts:
				apache && /^Apache-2\.0$/i.test(m.license) ? [{ title: 'Apache License 2.0', text: apache }] : [],
		});
	}
	for (const m of await svc.visionModels.list()) {
		out.push({
			id: `model:${m.id}`,
			name: `${m.name} — ${m.task === 'face' ? 'face tracking' : 'segmentation'} model weights${m.installed ? '' : ' (not installed)'}`,
			version: m.revision.slice(0, 12),
			license: m.license,
			bundled: false,
			sourceUrl: m.sourceUrl,
			notice: `Attribution: ${m.attribution}. Licence: ${m.licenseUrl}`,
			texts: [],
		});
	}
	return out;
}
