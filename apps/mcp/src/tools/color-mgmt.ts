// Colour management MCP tools (workstream color-mgmt, docs/wp-notes/color-mgmt.md): the colour space catalogue, a
// sequence's working space and colour settings, Interpret Footage ▸ Colour on media, clip colour overrides and custom
// OCIO configs. Every edit is one transaction of document commands (also available through apply_commands).
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
	COLOR_SPACES,
	colorSpace,
	type MediaAsset,
	OUTPUT_SPACE_IDS,
	type ProjectDocument,
	resolveInputSpace,
	type Sequence,
	sequenceColorInfo,
	WORKING_SPACE_CHOICES,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { mediaRegisterCommand } from '../media.ts';

export const COLOR_MGMT_GUIDE = `Colour management (working spaces, HDR, log footage, OCIO):
- Every sequence has a working colour space (get_color_settings): rec709 (default), srgb, rec2020, p3d65, displayp3, rec2100-pq, rec2100-hlg, or a linear variant ("rec709-linear": Linearize Working Space). The composite holds that space's signal; the Program monitor shows it through a display transform (Rec. 2020/P3 → Rec. 709 primaries, HDR tone mapped with BT.2390) and exports write it (or another space: start_export settings.video.colorSpace, bitDepth 8/10/12, hdrMetadata {maxCll, maxFall, masteringDisplay}). set_working_color_space changes it with blendLinear (Blend Using 1.0 Gamma: linear-light compositing, rendered on the Remotion path), autoToneMap (HDR/log media into SDR), sdrWhiteNits (HDR graphics white, 203 = BT.2408) and hdrPeakNits (PQ mastering peak). Blend Using 1.0 Gamma composites every layer on the GPU; with adjustment layers, other blend modes or 3D layers between the blended tracks the whole stack is drawn by one flat GPU compositor (any combination renders).
- Media are interpreted automatically from their stream tags (BT.709/601 → rec709, PQ → rec2100-pq, HLG → rec2100-hlg, BT.2020 → rec2020, P3 → p3d65). Camera log footage is usually tagged BT.709: set its space with interpret_footage_color (list_color_spaces: slog3-sgamut3cine, vlog-vgamut, logc3-awg3, logc4-awg4, clog3-cinemagamut, applelog, log3g10-rwg, bmdfilm5-bmdwg5, davinci-dwg, flog2-fgamut, nlog-bt2020, dlog-dgamut, acescct…). range (tv/pc) matters for log curves; toneMap and peakNits for HDR; inputLut applies a LUT item first (its output read as the space). set_clip_color_space overrides single clips.
- Text, shapes, solids and the background are SDR graphics: converted into wide-gamut / HDR working spaces with their white at the HDR graphics white.
- Lumetri (grade_clip basic.hdrWhite / hdrSpecular) grades HDR sequences on a signal normalised to HDR White; speculars above it follow HDR Specular.
- Custom OCIO configs: import_ocio_config (a .ocio path; its LUT files are bundled). Their spaces join colour management through the aces_interchange / cie_xyz_d65_interchange roles (interpret_footage_color {ocio: {configId, space}}), and S_OCIOTransform converts between any two of their spaces (params config: "custom", configFile: {mediaId}, fromSpace, toSpace). Transforms the config uses that cannot be applied (ACES output transforms) are refused, never passed through.
- LUT files: import_lut takes .cube (1D, 3D, shaper + 3D), .3dl, .spi1d, .spi3d and .csp; every path interpolates 3D LUTs tetrahedrally.
- render_frame of an HDR sequence returns the display rendition (tone mapped); exports keep the HDR signal.`;

const InterpretationPatch = z
	.strictObject({
		space: z
			.string()
			.nullable()
			.optional()
			.describe('A colour space id from list_color_spaces; null = automatic from the tags'),
		ocio: z
			.strictObject({ configId: z.string(), space: z.string().min(1) })
			.nullable()
			.optional()
			.describe('A space of an imported OCIO config (mediaId from import_ocio_config); null = none'),
		range: z
			.enum(['tv', 'pc'])
			.nullable()
			.optional()
			.describe('File range for log curves: tv = limited, pc = full; null = the file flag'),
		toneMap: z
			.boolean()
			.nullable()
			.optional()
			.describe('Tone map into an SDR working space; null = the sequence default'),
		peakNits: z
			.number()
			.min(203)
			.max(10000)
			.nullable()
			.optional()
			.describe('PQ content peak (cd/m²); null = from the file'),
		inputLut: z.string().nullable().optional().describe('mediaId of a LUT item applied first; null = none'),
	})
	.nullable();

function seqOf(doc: ProjectDocument, sequenceId?: string): Sequence {
	const seq = sequenceId ? doc.sequences[sequenceId] : Object.values(doc.sequences)[0];
	if (!seq)
		throw new ToolError(
			'E_NOT_FOUND',
			`Sequence not found: ${sequenceId ?? '(none)'}`,
			'Call list_sequences.',
		);
	return seq as Sequence;
}

async function run(
	ctx: ToolContext,
	projectId: string,
	label: string,
	commands: unknown[],
	extra: Parameters<typeof transact>[3],
) {
	const res = await transact(ctx, projectId, { label, commands }, extra);
	return jsonResult(txBody(res, requireOk(res)));
}

export function registerColorMgmtTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_color_spaces',
		{
			title: 'List colour spaces',
			description:
				"The colour spaces of Interpret Footage ▸ Colour (id, label, group, gamut, transfer, kind: sdr / pq / hlg / scene), the working space choices and the export output spaces. With projectId: also the project's custom OCIO configs and their spaces.",
			input: { projectId: ProjectIdArg.optional() },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const configs = projectId
				? Object.values((await loadDoc(ctx, projectId)).doc.media)
						.filter((m) => m.kind === 'color-config')
						.map((m) => ({
							mediaId: m.id,
							name: (m as MediaAsset).colorConfig?.name ?? m.originalName,
							spaces: (m as MediaAsset).colorConfig?.spaces ?? [],
							roles: (m as MediaAsset).colorConfig?.roles ?? [],
							unsupported: (m as MediaAsset).colorConfig?.unsupported ?? [],
							missingFiles: (m as MediaAsset).colorConfig?.missing ?? [],
						}))
				: undefined;
			return jsonResult({
				spaces: COLOR_SPACES.map((s) => ({
					id: s.id,
					label: s.label,
					group: s.group,
					gamut: s.gamut,
					transfer: s.curve,
					kind: s.kind,
				})),
				workingSpaces: WORKING_SPACE_CHOICES,
				outputSpaces: OUTPUT_SPACE_IDS,
				...(configs ? { ocioConfigs: configs } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'get_color_settings',
		{
			title: 'Get colour settings',
			description:
				"A sequence's working colour space and colour settings, and how each picture media item of the project is interpreted (automatic space from its tags, or its override; HDR metadata).",
			input: { projectId: ProjectIdArg, sequenceId: z.string().optional() },
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = seqOf(doc, sequenceId);
			const info = sequenceColorInfo(seq.settings);
			const media = Object.values(doc.media)
				.filter((m) => m.kind === 'video' || m.kind === 'image' || m.kind === 'animated-image')
				.map((m) => {
					const a = m as MediaAsset;
					const interp = a.interpretation?.color ?? {};
					const r = resolveInputSpace(a, interp, info.space);
					const vs = a.probe.streams.find((s) => s.type === 'video') as
						| { color?: unknown; hdr?: unknown }
						| undefined;
					return {
						mediaId: a.id,
						name: a.originalName,
						tags: vs?.color ?? null,
						...(vs?.hdr ? { hdr: vs.hdr } : {}),
						interpretation: interp,
						resolved: { space: r.space?.id ?? null, ocio: r.ocio, range: r.range, automatic: r.auto },
					};
				});
			return jsonResult({
				sequenceId: seq.id,
				workingColorSpace: info.space,
				label: colorSpace(info.space)?.label,
				...info,
				media,
			});
		},
	);

	defineTool(
		ctx,
		'set_working_color_space',
		{
			title: 'Set working colour space',
			description:
				'Sequence Settings ▸ Colour (sequence.updateSettings): workingColorSpace (rec709, srgb, rec2020, p3d65, displayp3, rec2100-pq, rec2100-hlg, or a "-linear" variant = Linearize Working Space), blendLinear (Blend Using 1.0 Gamma), autoToneMap, sdrWhiteNits (HDR graphics white 80–400), hdrPeakNits (PQ mastering peak 203–10000). null resets a setting.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: z.string().optional(),
				workingColorSpace: z.enum(WORKING_SPACE_CHOICES).optional(),
				linearize: z.boolean().nullable().optional(),
				blendLinear: z.boolean().nullable().optional(),
				autoToneMap: z.boolean().nullable().optional(),
				sdrWhiteNits: z.number().min(80).max(400).nullable().optional(),
				hdrPeakNits: z.number().min(203).max(10000).nullable().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, workingColorSpace, ...rest }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = seqOf(doc, sequenceId);
			const color = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
			return run(
				ctx,
				projectId,
				'Sequence Colour Settings',
				[
					{
						type: 'sequence.updateSettings',
						sequenceId: seq.id,
						settings: {
							...(workingColorSpace ? { workingColorSpace } : {}),
							...(Object.keys(color).length ? { color } : {}),
						},
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'interpret_footage_color',
		{
			title: 'Interpret Footage ▸ Colour',
			description:
				'How picture media are read (media.interpretColor): space override (list_color_spaces ids, e.g. slog3-sgamut3cine), an OCIO config space, range, toneMap, peakNits, inputLut. Absent fields stay, null resets one, color: null makes everything automatic again.',
			input: {
				projectId: ProjectIdArg,
				mediaIds: z.array(z.string().min(1)).min(1),
				color: InterpretationPatch,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, mediaIds, color }, extra) =>
			run(
				ctx,
				projectId,
				'Interpret Footage (Colour)',
				[{ type: 'media.interpretColor', mediaIds, color }],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_clip_color_space',
		{
			title: 'Clip colour space',
			description:
				"Overrides the colour interpretation of single clips (clip.setColorInterpretation), field by field over their media's. Same fields as interpret_footage_color; color: null removes the override.",
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1),
				color: InterpretationPatch,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds, color }, extra) =>
			run(
				ctx,
				projectId,
				'Clip Colour Space',
				[{ type: 'clip.setColorInterpretation', clipIds, color }],
				extra,
			),
	);

	defineTool(
		ctx,
		'import_ocio_config',
		{
			title: 'Import OCIO config',
			description:
				'Imports a custom OpenColorIO config (.ocio, OCIO v1 or v2) by absolute path: the engine bundles it with the LUT files it references (search_path). Returns its mediaId, colour spaces, roles, displays, transforms that cannot be applied and files that were not found.',
			input: { projectId: ProjectIdArg, path: z.string().min(1).describe('Absolute path of the .ocio file') },
			annotations: EDIT,
		},
		async ({ projectId, path }, extra) => {
			if (!isAbsolute(path))
				throw new ToolError(
					'NOT_ABSOLUTE',
					`Not an absolute path: ${path}`,
					'Pass the absolute path of the .ocio file.',
				);
			if (!existsSync(path) || !statSync(path).isFile())
				throw new ToolError('FILE_NOT_FOUND', `No such file on this machine: ${path}`, 'Check the path.');
			if (!/\.ocio$/i.test(path))
				throw new ToolError('NOT_OCIO', `${path} is not a .ocio file`, 'Use import_lut for LUT files.');
			const reg = await ctx.engine((c) => c.registerMedia({ projectId, paths: [path] }));
			const err = reg.errors[0];
			if (err)
				throw new ToolError(err.code, err.message, 'Check that the file is a readable OCIO config.', {
					path,
				});
			const item = reg.items[0];
			if (item?.kind !== 'color-config' || !item.colorConfig)
				throw new ToolError('INTERNAL', 'The engine did not register a colour config');
			const res = await transact(
				ctx,
				projectId,
				{ label: 'Import OCIO Config', commands: [mediaRegisterCommand(item, '$cfg', '$item')] },
				extra,
			);
			const r = requireOk(res);
			const out = r.results[0] as { mediaId?: string; itemId?: string } | undefined;
			return jsonResult({
				mediaId: out?.mediaId ?? r.refs.$cfg,
				itemId: out?.itemId ?? r.refs.$item,
				...item.colorConfig,
				revision: r.revision,
				appliedBy: res.appliedBy,
			});
		},
	);
}
