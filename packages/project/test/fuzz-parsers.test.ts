// FUZZ=1 runs 20× more cases; FUZZ_SEED=<n> selects a reproducible seed.
import { bytesTarget, describeFuzz, jsonTarget, textTarget } from '@jasper/testkit/fuzz';
import { parseTranscriptJson } from '../src/commands/handlers/captions.ts';
import {
	CaptionFormatError,
	CubeParseError,
	checkInvariants,
	createCounterIdSource,
	defaultRegistries,
	detectCaptionFormat,
	groupImageSequences,
	LottieParseError,
	loadProject,
	ModelParseError,
	migrate,
	OcioConfig,
	OcioError,
	ProjectLoadError,
	parse3dl,
	parseCaptionFile,
	parseCdlXml,
	parseClipboardPayload,
	parseCsp,
	parseCube,
	parseEffectPreset,
	parseLottie,
	parseLutFile,
	parseMcc,
	parseModel,
	parsePresetFile,
	parseScc,
	parseSourceSidecar,
	parseSpi1d,
	parseSpi3d,
	parseSrt,
	parseStl,
	parseSvgPath,
	parseTimecode,
	parseTtml,
	parseVtt,
	parseYaml,
	readCaptionFile,
	readEssentialSound,
	SvgImportError,
	SvgPathError,
	svgToShapeContents,
} from '../src/index.ts';
import {
	CDL,
	captionSeeds,
	IMAGE_SEQUENCE_NAMES,
	LOTTIE,
	lutSeeds,
	modelSeeds,
	OCIO,
	OCIO_FILES,
	presetSeeds,
	projectSeeds,
	SVG,
	SVG_PATHS,
	TRANSCRIPT_JSON,
	threeDlSeeds,
} from './fuzz-seeds.ts';
import { hostileModelSeeds, triangleDocument } from './three-d-hostile.ts';

const caption = captionSeeds();
const text = (k: string) => caption[k]!.filter((x): x is string => typeof x === 'string');
const enc = (s: string) => new TextEncoder().encode(s);
const isResult = (r: unknown) => {
	if (!r || typeof r !== 'object' || typeof (r as { ok?: unknown }).ok !== 'boolean')
		throw new Error(`not a result object: ${JSON.stringify(r)?.slice(0, 200)}`);
};
const registries = defaultRegistries();

/** A loaded project must satisfy every invariant after repair (the load pipeline's promise). */
function loadChecked(raw: unknown): void {
	const r = loadProject(raw, { ids: createCounterIdSource(1), effects: registries.effects });
	if (r.readOnly) return;
	if (r.issues.length)
		throw new Error(`loaded with invariant issues: ${JSON.stringify(r.issues.slice(0, 3))}`);
	const again = checkInvariants(r.document, { effects: registries.effects });
	if (again.length) throw new Error(`repair left issues: ${JSON.stringify(again.slice(0, 3))}`);
}

describeFuzz('@jasper/project captions', [
	textTarget('SRT', text('srt'), parseSrt, CaptionFormatError),
	textTarget('WebVTT', text('vtt'), parseVtt, CaptionFormatError),
	textTarget('SCC', text('scc'), parseScc, CaptionFormatError),
	textTarget('MCC', text('mcc'), parseMcc, CaptionFormatError),
	textTarget('TTML / DFXP', [...text('ttml'), ...text('dfxp')], parseTtml, CaptionFormatError),
	bytesTarget(
		'EBU STL',
		caption.stl!.map((x) => (typeof x === 'string' ? enc(x) : x)),
		parseStl,
		CaptionFormatError,
	),
	bytesTarget(
		'caption sniffing + readCaptionFile (result object)',
		Object.values(caption)
			.flat()
			.map((x) => (typeof x === 'string' ? enc(x) : x)),
		(b) => {
			detectCaptionFormat(b, 'srt');
			isResult(readCaptionFile(b, { ext: null, snapRate: { num: 25, den: 1 } }));
			isResult(parseCaptionFile(b, 'scc'));
		},
	),
]);

describeFuzz('@jasper/project LUTs and colour management', [
	textTarget('.cube', lutSeeds().slice(0, 2), parseCube, CubeParseError),
	textTarget('.3dl', threeDlSeeds(), parse3dl, CubeParseError),
	textTarget('.spi1d', [lutSeeds()[2]!], parseSpi1d, CubeParseError),
	textTarget('.spi3d', [lutSeeds()[3]!], parseSpi3d, CubeParseError),
	textTarget('.csp', [lutSeeds()[4]!], parseCsp, CubeParseError),
	textTarget(
		'LUT sniffing (parseLutFile)',
		[...lutSeeds(), ...threeDlSeeds()],
		(t) => parseLutFile(t, null),
		CubeParseError,
	),
	textTarget('OCIO YAML subset', [OCIO], parseYaml, RangeError),
	textTarget(
		'OCIO config: parse, list, convert',
		[OCIO],
		(t) => {
			const c = OcioConfig.parse(t, OCIO_FILES);
			const names = c.spaceNames();
			c.unsupported();
			for (const a of names.slice(0, 4))
				for (const b of names.slice(0, 4)) {
					const px: [number, number, number] = [0.18, 0.5, 1.2];
					c.convertFn(a, b)(px);
				}
		},
		[OcioError, RangeError],
		{ iterations: 200 },
	),
	textTarget('ASC CDL XML', [CDL], parseCdlXml, CubeParseError),
]);

describeFuzz('@jasper/project vector, Lottie, models, image sequences', [
	textTarget('SVG → shape layers', [SVG], svgToShapeContents, [SvgImportError, SvgPathError]),
	textTarget('SVG path data', SVG_PATHS, parseSvgPath, SvgPathError),
	textTarget('Lottie JSON text', [JSON.stringify(LOTTIE)], parseLottie, LottieParseError),
	jsonTarget('Lottie document', [LOTTIE], parseLottie, LottieParseError),
	// JSON-aware mutations target counts, offsets, strides and indices to exercise allocation and traversal limits.
	bytesTarget(
		'glTF (JSON)',
		[modelSeeds().gltf, ...hostileModelSeeds()],
		(b) => parseModel(b, 'gltf'),
		ModelParseError,
	),
	jsonTarget(
		'glTF document (fields)',
		[triangleDocument(), ...hostileModelSeeds().map((b) => JSON.parse(new TextDecoder().decode(b)))],
		(doc) => parseModel(new TextEncoder().encode(JSON.stringify(doc)), 'gltf'),
		ModelParseError,
	),
	bytesTarget('glTF binary (GLB)', [modelSeeds().glb], (b) => parseModel(b, 'glb'), ModelParseError),
	bytesTarget('OBJ', [modelSeeds().obj], (b) => parseModel(b, 'obj'), ModelParseError),
	textTarget('image-sequence grouping (one name per line)', [IMAGE_SEQUENCE_NAMES.join('\n')], (t) =>
		groupImageSequences(t.split('\n')),
	),
	textTarget('timecode entry', ['01:00:00:00', '00:00:10;02', '-00:00:00.15'], (t) => {
		parseTimecode(t, { num: 30000, den: 1001 }, { dropFrame: true });
		parseTimecode(t, { num: 25, den: 1 });
	}),
]);

describeFuzz('@jasper/project documents and libraries', [
	jsonTarget('project load / migrate / repair', projectSeeds, loadChecked, ProjectLoadError, {
		iterations: 150,
		properties: 60,
		slowMs: 5000,
	}),
	jsonTarget('migrate only', projectSeeds, migrate, ProjectLoadError, { iterations: 150 }),
	jsonTarget('effect preset (result object)', presetSeeds, (v) => isResult(parseEffectPreset(v))),
	jsonTarget(
		'effect preset file (result object)',
		() => [{ version: 1, presets: presetSeeds(), folders: [] }],
		(v) => isResult(parsePresetFile(v)),
	),
	jsonTarget('clipboard payload (result object)', [{ format: 'jasper-clipboard', version: 1 }], (v) =>
		isResult(parseClipboardPayload(v)),
	),
	textTarget('clipboard payload text (result object)', ['{"format":"jasper-clipboard"}'], (t) =>
		isResult(parseClipboardPayload(t)),
	),
	jsonTarget(
		'source-range sidecar',
		[{ source: 'a.mp4', firstFrame: 10, frames: 100, frameRate: { num: 24000, den: 1001 } }],
		(v) => parseSourceSidecar(v),
	),
	textTarget('transcript JSON (string on error)', [TRANSCRIPT_JSON], parseTranscriptJson, undefined, {
		iterations: 150,
	}),
	jsonTarget(
		'essential-sound settings',
		[{ type: 'dialogue', loudness: { enabled: true } }],
		readEssentialSound,
	),
]);
