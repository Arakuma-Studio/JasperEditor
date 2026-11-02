import type { CamTrackResult, EngineJob } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	activeCameraAt,
	activeCameraClipAt,
	angleOfViewForZoom,
	BEVEL_POSITIONS,
	BEVEL_PROFILES,
	buildRenderSnapshot,
	CAMERA_PRESETS,
	type CameraClip,
	type ClipCameraTracker,
	cameraTrackerInputs,
	cameraTrackerSettingsOf,
	cameraTrackerSolveBody,
	clipContentTime,
	contentTimeAt,
	costClassOf,
	ENVIRONMENT_PRESETS,
	findCameraTracker,
	focalLengthForZoom,
	GEOMETRY_MODES,
	IRIS_SHAPES,
	isSolveStale,
	LIGHT_FALLOFFS,
	LIGHT_TYPES,
	layerWorldMatrix,
	lightsAt,
	mat4Apply,
	mediaFrameAt,
	PLATE_SHAPES,
	planeHomography,
	type Rational,
	RENDERERS_3D,
	runs3d,
	SHADOW_MODES,
	SURFACE_PRESETS,
	SurfaceValuesSchema,
	stackAt,
	TONE_MAPPINGS,
	trackPointsAt,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	findClip,
	isTerminal,
	jobBody,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper } from './editing.ts';

export const THREE_D_GUIDE = `3D layers, cameras and lights (After Effects' 3D in a Premiere timeline):
- set_3d_layer {clipIds, enabled} is the 3D Layer switch of visual clips (not adjustment layers or captions). A 3D layer keeps its 2D Motion (X/Y Position, Anchor, Scale, Rotation = Z rotation) and adds Z Position, Anchor Z, Z Scale, Orientation [x, y, z] and X/Y Rotation (set_3d_transform), plus Material Options (set_material: Casts Shadows off/on/only, Accepts Shadows, Accepts Lights, Ambient, Diffuse, Specular Intensity / Shininess, Metal, Light Transmission). World space = sequence pixels, y down, z away from the viewer; at the default camera a 3D layer with every 3D value at 0 sits exactly where its 2D Motion puts it. 3D layers take no transitions (animate Opacity).
- Consecutive 3D layers (bottom → top, no 2D layer between them: adjustment layers and transition spans are 2D) render together: per-pixel depth sorting with true intersections, lights (Blinn-Phong), ray-cast shadows, the camera's depth of field, each layer's blend mode applied in depth order. A 2D layer between them splits them into two runs.
- add_camera {at, preset | focalLength | zoom | angleOfView, cameraType one-node|two-node, position, pointOfInterest, depthOfField…} puts a camera clip on the top video track (a new one when it is busy); the topmost camera clip that is on is the active camera; without one the default 50 mm camera is used. camera_settings changes the lens / depth of field (fStop or aperture px, focusDistance, lockToZoom, irisShape, blurLevel); move_camera {op: orbit | pan | dolly} uses the camera tools (keys when Position is animated).
- add_light {lightType parallel|spot|point|ambient|environment, position, pointOfInterest, intensity, color, coneAngle, coneFeather, falloff none|smooth|inverse-square, radius, falloffDistance, castsShadows, shadowDarkness, shadowDiffusion}; light_settings edits one. Shadows need a light with castsShadows and layers with Casts Shadows on.
- set_3d_renderer {renderer classic|advanced, draft}: Classic 3D is After Effects' plane renderer. get_3d_scene {frame} reports the evaluated camera, lights, every 3D layer's placement and projected corners and the runs — check results with render_frame.
- Every property is also a param.set path: ["clip", id, "threeD", "positionZ" | "orientation" | "rotationX" | "material", "castsShadows" …], ["clip", id, "camera", "zoom" | "position" | "pointOfInterest" …], ["clip", id, "light", "intensity" | "color" …] (keyframe.add / expressions work on them too).
- Export: 3D layers render on the Remotion path (the planner routes them there and says so); preview and export use the same renderer. A missing HDR or 3D model refuses the export (THREE_D_ASSET_MISSING); physical surfaces, HDR, tone mapping, glints and supersampling refuse where the render browser has no float targets (THREE_D_NEEDS_FLOAT). Enum costClass of a 3D title: 3d, or 3d-heavy with transmission, glints, inflate or supersampling.
- 3D titles (Advanced 3D, text and shape layers): set_3d_geometry {mode extrude | inflate, bevelPosition, extrusionDepth, inflate}; edit_bevel_bands (up to 6 bands, each with width, depth, profile, curve and its own material); edit_backplates (up to 3 solids from contour, hull or box); set_3d_surface {surface base | face | side | back | band id | plate id.face | plate id.side, preset, values}: metal-roughness with clearcoat, flakes, procedural relief, iridescence, and transmission glass that refracts the sequence below it. Presets include gold, chrome, silver, copper, glass, diamond. Metal needs something to reflect: add_light {lightType environment, environmentPreset studio | sky | city | sunset | chromeBands | neon, or environmentMediaId with an image or a Radiance .hdr}; without one the neutral studio lights physical surfaces. set_3d_renderer {toneMapping aces | agx | neutral | hue, exposure, glint}. A title looks like metal with toneMapping aces, a bevel band, and an environment with bright bands. Look glass (the glass finish) refracts only its own fill: to refract the footage behind a title, use 3D transmission.
- 3D Camera Tracker: track_camera {clipId} analyses a video clip (features tracked through the shown media frames, then the camera and lens solved: Shot Type fixed | variable | specify with hfov, Solve Method auto | typical | flat | tripod, detailed, lensDistortion) and stores the solve (Method Used, Average Error in px, 3D track points); it takes about a second per frame. get_camera_tracker {clipId, frame} lists the track points seen at a sequence frame (id, media px, depth, error). create_tracked_camera {clipId, layer none|text|solid, pointIds, text} makes a one-node camera keyed on every frame that sees the footage as it was filmed, plus a 3D text or solid on the target of the points (3 or more points: their plane). set_tracker_ground {clipId, pointIds ≥ 3} makes their plane the ground (horizontal, through the frame centre) before creating the camera. delete_track_points {clipId, pointIds} drops bad points and solves again. The tracked clip must be drawn centred, unrotated, not animated (its Motion scale is used).`;

const Vec3Arg = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const FrameArg = z
	.number()
	.int()
	.min(0)
	.optional()
	.describe('Sequence frame for animated properties (a key is written there when the property has keys)');
const atOf = (frame?: number) => (frame === undefined ? {} : { at: { sequenceFrame: frame } });

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const rv = (v: readonly number[]) => v.map(r3);

export function registerThreeDTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'set_3d_layer',
		{
			title: 'Set 3D layer',
			description:
				'Turns the 3D Layer switch of visual clips on or off (one undoable edit). Off keeps the 3D values. Refused on adjustment layers, captions, cameras and lights, and on clips with transitions (3D layers take none).',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).describe('Clip ids ("clp_…")'),
				enabled: z.boolean(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds, enabled }, extra) =>
			applyHelper(ctx, projectId, '3D Layer', [{ type: 'clip.set3d', clipIds, enabled }], extra),
	);

	defineTool(
		ctx,
		'set_3d_transform',
		{
			title: 'Set 3D transform',
			description:
				"Sets a 3D layer's transform in one undoable edit: position [x, y] or [x, y, z], positionZ, anchorZ, scaleZ (%), orientation [x, y, z] (°), rotationX / rotationY / rotationZ (°; Z = the Motion Rotation), autoOrient off | path | camera. Animated properties get a key at `frame`.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				position: z.union([z.tuple([z.number(), z.number()]), Vec3Arg]).optional(),
				positionZ: z.number().finite().optional(),
				anchorZ: z.number().finite().optional(),
				scaleZ: z.number().finite().optional(),
				orientation: Vec3Arg.optional(),
				rotationX: z.number().finite().optional(),
				rotationY: z.number().finite().optional(),
				rotationZ: z.number().finite().optional(),
				autoOrient: z.enum(['off', 'path', 'camera']).optional(),
				frame: FrameArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipId, frame, position, positionZ, rotationZ, ...rest }, extra) => {
			const at = atOf(frame);
			const t = (path: string[], value: unknown) => ({
				type: 'param.set',
				target: ['clip', clipId, ...path],
				value,
				...at,
			});
			const cmds: unknown[] = [];
			if (position) cmds.push(t(['transform', 'position'], [position[0], position[1]]));
			const z = position && position.length === 3 ? position[2] : positionZ;
			if (z !== undefined) cmds.push(t(['threeD', 'positionZ'], z));
			if (rotationZ !== undefined) cmds.push(t(['transform', 'rotation'], rotationZ));
			for (const [k, v] of Object.entries(rest)) {
				if (v === undefined) continue;
				cmds.push(
					k === 'autoOrient'
						? { type: 'param.set', target: ['clip', clipId, 'threeD', k], value: v }
						: t(['threeD', k], v),
				);
			}
			if (cmds.length === 0)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to set', 'Pass at least one property.');
			return applyHelper(ctx, projectId, '3D Transform', cmds, extra);
		},
	);

	defineTool(
		ctx,
		'set_material',
		{
			title: 'Set material options',
			description:
				'Sets Material Options of 3D layers (one undoable edit): castsShadows / acceptsShadows off | on | only, acceptsLights, and percentages lightTransmission, ambient, diffuse, specularIntensity, specularShininess, metal, reflectionIntensity, reflectionSharpness (animated ones get a key at `frame`).',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1),
				castsShadows: z.enum(SHADOW_MODES).optional(),
				acceptsShadows: z.enum(SHADOW_MODES).optional(),
				acceptsLights: z.boolean().optional(),
				lightTransmission: z.number().finite().optional(),
				ambient: z.number().finite().optional(),
				diffuse: z.number().finite().optional(),
				specularIntensity: z.number().finite().optional(),
				specularShininess: z.number().finite().optional(),
				metal: z.number().finite().optional(),
				reflectionIntensity: z.number().finite().optional(),
				reflectionSharpness: z.number().finite().optional(),
				frame: FrameArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds, frame, ...props }, extra) => {
			const statics = new Set(['castsShadows', 'acceptsShadows', 'acceptsLights']);
			const cmds: unknown[] = [];
			for (const id of clipIds)
				for (const [k, v] of Object.entries(props)) {
					if (v === undefined) continue;
					cmds.push({
						type: 'param.set',
						target: ['clip', id, 'threeD', 'material', k],
						value: v,
						...(statics.has(k) ? {} : atOf(frame)),
					});
				}
			if (cmds.length === 0)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to set', 'Pass at least one option.');
			return applyHelper(ctx, projectId, 'Material Options', cmds, extra);
		},
	);

	const lensArgs = {
		preset: z
			.string()
			.optional()
			.describe(`Camera preset: ${CAMERA_PRESETS.map((p) => p.name).join(', ')}`),
		focalLength: z.number().positive().optional().describe('mm (with filmSize)'),
		zoom: z.number().positive().optional().describe('px: eye → image plane distance'),
		angleOfView: z.number().gt(0).lt(180).optional().describe('degrees along measureFilmSize'),
		filmSize: z.number().positive().optional().describe('mm (default 36)'),
		measureFilmSize: z.enum(['horizontal', 'vertical', 'diagonal']).optional(),
		depthOfField: z.boolean().optional(),
		focusDistance: z.number().min(0).optional().describe('px from the eye'),
		lockToZoom: z.boolean().optional().describe('focus distance = zoom'),
		aperture: z.number().min(0).optional().describe('px'),
		fStop: z.number().positive().optional(),
		blurLevel: z.number().min(0).max(1000).optional().describe('%'),
		irisShape: z.enum(IRIS_SHAPES).optional(),
	};

	defineTool(
		ctx,
		'add_camera',
		{
			title: 'Add camera',
			description:
				'Adds a camera clip (Layer ▸ New ▸ Camera; one undoable edit) at `at` (sequence frame) for `duration` frames (default: to the sequence end, ≥ 5 s) on `track` (default: the top video track when free, else a new one on top). Two-node by default, aimed at pointOfInterest (default: the frame centre) from position (default: framing the sequence like the default camera). The topmost camera that is on is the active camera.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: z.string().optional(),
				at: z.number().int().min(0),
				duration: z.number().int().min(1).optional(),
				track: z.string().optional(),
				name: z.string().optional(),
				cameraType: z.enum(['one-node', 'two-node']).optional(),
				position: Vec3Arg.optional(),
				pointOfInterest: Vec3Arg.optional(),
				...lensArgs,
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'New Camera',
				[{ type: 'clip.addCamera', ...args }],
				extra,
				sequenceId ? { sequenceId } : {},
			),
	);

	defineTool(
		ctx,
		'camera_settings',
		{
			title: 'Camera settings',
			description:
				'Changes a camera (Layer ▸ Camera Settings; one undoable edit): name, cameraType, lens (preset / focalLength / zoom / angleOfView, filmSize, measureFilmSize) and depth of field (depthOfField, focusDistance, lockToZoom, aperture or fStop, blurLevel, irisShape). Animated values get a key at `frame`.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				name: z.string().optional(),
				cameraType: z.enum(['one-node', 'two-node']).optional(),
				...lensArgs,
				frame: FrameArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, frame, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'Camera Settings',
				[{ type: 'camera.settings', ...args, ...atOf(frame) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'move_camera',
		{
			title: 'Move camera',
			description:
				'The camera tools on a camera clip (one undoable edit): orbit {yaw, pitch} (degrees, about the Point of Interest), pan {dx, dy} (frame px), dolly {amount} (px toward the Point of Interest; withPoi = Track Z). Writes Position / Point of Interest at `frame` (keys when animated).',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				op: z.enum(['orbit', 'pan', 'dolly']),
				yaw: z.number().finite().optional(),
				pitch: z.number().finite().optional(),
				dx: z.number().finite().optional(),
				dy: z.number().finite().optional(),
				amount: z.number().finite().optional(),
				withPoi: z.boolean().optional(),
				frame: FrameArg,
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, op, yaw, pitch, dx, dy, amount, withPoi, frame }, extra) => {
			const at = atOf(frame);
			const cmd =
				op === 'orbit'
					? { type: 'camera.orbit', clipId, yaw: yaw ?? 0, pitch: pitch ?? 0, ...at }
					: op === 'pan'
						? { type: 'camera.pan', clipId, dx: dx ?? 0, dy: dy ?? 0, ...at }
						: { type: 'camera.dolly', clipId, amount: amount ?? 0, ...(withPoi ? { withPoi } : {}), ...at };
			return applyHelper(
				ctx,
				projectId,
				op === 'orbit' ? 'Orbit Camera' : op === 'pan' ? 'Pan Camera' : 'Dolly Camera',
				[cmd],
				extra,
			);
		},
	);

	const lightArgs = {
		intensity: z.number().finite().optional().describe('%'),
		color: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('RGBA 0…1'),
		coneAngle: z.number().min(0).max(180).optional(),
		coneFeather: z.number().min(0).max(100).optional(),
		falloff: z.enum(LIGHT_FALLOFFS).optional(),
		radius: z.number().min(0).optional(),
		falloffDistance: z.number().min(0).optional(),
		castsShadows: z.boolean().optional(),
		shadowDarkness: z.number().min(0).max(100).optional(),
		shadowDiffusion: z.number().min(0).optional(),
		environmentMediaId: z
			.string()
			.nullable()
			.optional()
			.describe('An image, video or Radiance .hdr media id; null uses environmentPreset'),
		environmentBackground: z.boolean().optional(),
		environmentPreset: z.enum(ENVIRONMENT_PRESETS).optional().describe('Procedural environment, the look presets'),
		environmentRotation: z.number().finite().optional().describe('Degrees'),
	};

	defineTool(
		ctx,
		'add_light',
		{
			title: 'Add light',
			description:
				'Adds a light clip (Layer ▸ New ▸ Light; one undoable edit): lightType parallel | spot | point | ambient | environment, placed like add_camera. Parallel and spot lights aim at pointOfInterest. A sequence without lights shows 3D layers unlit.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: z.string().optional(),
				at: z.number().int().min(0),
				duration: z.number().int().min(1).optional(),
				track: z.string().optional(),
				name: z.string().optional(),
				lightType: z.enum(LIGHT_TYPES),
				position: Vec3Arg.optional(),
				pointOfInterest: Vec3Arg.optional(),
				...lightArgs,
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'New Light',
				[{ type: 'clip.addLight', ...args }],
				extra,
				sequenceId ? { sequenceId } : {},
			),
	);

	defineTool(
		ctx,
		'light_settings',
		{
			title: 'Light settings',
			description:
				'Changes a light (Layer ▸ Light Settings; one undoable edit). Animated values get a key at `frame`.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				name: z.string().optional(),
				lightType: z.enum(LIGHT_TYPES).optional(),
				...lightArgs,
				frame: FrameArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, frame, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'Light Settings',
				[{ type: 'light.settings', ...args, ...atOf(frame) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_3d_renderer',
		{
			title: 'Set 3D renderer',
			description:
				"Sets a sequence's 3D renderer (Composition Settings ▸ 3D Renderer; one undoable edit): renderer classic | advanced, draft (Draft 3D previews: no lights, shadows or depth of field; exports always render in full), and for Advanced 3D shadowMapSize, supersampling, toneMapping (none, aces, agx, neutral, hue), exposure (stops) and glint (HDR bloom and star rays). Values key at `frame` when animated; the same values animate through set_param at [\"scene3d\", sequenceId, prop], props exposure, glintThreshold, glintIntensity, glintRadius, glintLength, glintAngle, glintTint.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: z.string().optional(),
				renderer: z.enum(RENDERERS_3D).optional(),
				draft: z.boolean().optional(),
				shadowMapSize: z.number().int().min(256).max(8192).optional(),
				supersampling: z.number().int().min(1).max(4).optional(),
				toneMapping: z.enum(TONE_MAPPINGS).optional(),
				exposure: z.number().finite().min(-10).max(10).optional().describe('Stops'),
				glint: z
					.object({
						enabled: z.boolean().optional(),
						threshold: z.number().min(0).max(64).optional().describe('Scene-linear luminance'),
						intensity: z.number().min(0).max(800).optional().describe('%'),
						radius: z.number().min(0).max(400).optional().describe('Sequence px'),
						rays: z.number().int().min(0).max(8).optional().describe('0, 2, 4, 6 or 8'),
						length: z.number().min(0).max(2000).optional().describe('Sequence px'),
						angle: z.number().finite().optional().describe('Degrees'),
						tint: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
					})
					.optional(),
				frame: FrameArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, frame, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'3D Renderer',
				[{ type: 'sequence.set3dRenderer', ...args, ...atOf(frame) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_3d_surface',
		{
			title: 'Set 3D surface material',
			description:
				"Gives a surface of 3D layers a physically based material (one undoable edit): surface base (default, every surface), face, side, back, a band id, or plateId.face / plateId.side; preset, values (percent 0–100 unless noted: metalness, roughness, clearcoat, flakes, relief crumple | hammered | liquid, iridescence, transmission with ior and thickness in layer px, emissive) or clear. List surfaces and values with get_clip_properties. Numbers animate through set_param at threeD.surface.<surface>.<value>. Physical surfaces need the float scene target and render on the Remotion path.",
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1),
				surface: z.string().min(1).optional(),
				preset: z.enum(Object.keys(SURFACE_PRESETS) as [string, ...string[]]).optional(),
				values: SurfaceValuesSchema.optional(),
				clear: z.boolean().optional(),
				frame: FrameArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, frame, ...args }, extra) =>
			applyHelper(ctx, projectId, '3D Material', [{ type: 'threeD.setSurface', ...args, ...atOf(frame) }], extra),
	);

	defineTool(
		ctx,
		'set_3d_geometry',
		{
			title: 'Set 3D title geometry',
			description:
				'The solid of text and shape 3D layers (one undoable edit): mode extrude | inflate, bevelPosition inside | center | outside, extrusionDepth (layer px), inflate { height, smoothness, detail 1–4, curve: 2–16 points x, y in 0…1 from edge to ridge }. Numbers animate through set_param; a change of geometry rebuilds the solid, a change of camera, light or material does not.',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1),
				mode: z.enum(GEOMETRY_MODES).optional(),
				bevelPosition: z.enum(BEVEL_POSITIONS).optional(),
				extrusionDepth: z.number().min(0).max(10000).optional(),
				inflate: z
					.object({
						height: z.number().min(0).max(2000).optional(),
						smoothness: z.number().min(0).max(100).optional(),
						detail: z.number().min(1).max(4).optional(),
						curve: z
							.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), corner: z.boolean().optional() }))
							.min(2)
							.max(16)
							.optional(),
					})
					.optional(),
				frame: FrameArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, frame, ...args }, extra) =>
			applyHelper(ctx, projectId, '3D Geometry', [{ type: 'threeD.setGeometry', ...args, ...atOf(frame) }], extra),
	);

	defineTool(
		ctx,
		'edit_bevel_bands',
		{
			title: 'Edit bevel bands',
			description:
				'Adds, removes or reorders a bevel band of a text or shape 3D layer (one undoable edit; at most 6 per solid, a seventh is refused with E_LIMIT). Bands run from the face edge outwards: width and depth in layer px, profile flat | chamfer | round | cove | step | inset | tube, curve −100…100, segments 1–24, preset for a material of its own. Numbers animate at threeD.band.<bandId>.<value>.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				action: z.enum(['add', 'remove', 'reorder']),
				bandId: z.string().optional().describe('remove, reorder'),
				index: z.number().int().min(0).optional(),
				width: z.number().min(0).max(2000).optional(),
				depth: z.number().min(0).max(2000).optional(),
				profile: z.enum(BEVEL_PROFILES).optional(),
				curve: z.number().min(-100).max(100).optional(),
				segments: z.number().int().min(1).max(24).optional(),
				preset: z.enum(Object.keys(SURFACE_PRESETS) as [string, ...string[]]).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, action, clipId, bandId, index, ...band }, extra) => {
			if (action !== 'add' && !bandId) throw new ToolError('E_INVALID_PARAM', 'bandId is required to remove or reorder a band');
			const cmd =
				action === 'add'
					? { type: 'threeD.addBand' as const, clipId, ...band, ...(index !== undefined ? { index } : {}) }
					: action === 'remove'
						? { type: 'threeD.removeBand' as const, clipId, bandId: bandId! }
						: { type: 'threeD.reorderBand' as const, clipId, bandId: bandId!, index: index ?? 0 };
			return applyHelper(ctx, projectId, 'Bevel Band', [cmd], extra);
		},
	);

	defineTool(
		ctx,
		'edit_backplates',
		{
			title: 'Edit backplates',
			description:
				'Adds, removes or reorders a backplate of a text or shape 3D layer (one undoable edit; at most 3, a fourth is refused with E_LIMIT): a solid stacked behind the title, shape contour | hull | box, grow, depth, gap, corner, bevelWidth, bevelDepth in layer px, fillCounters, preset for its material. Plates grow cumulatively. Numbers animate at threeD.plate.<plateId>.<value>.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				action: z.enum(['add', 'remove', 'reorder']),
				plateId: z.string().optional().describe('remove, reorder'),
				index: z.number().int().min(0).optional(),
				shape: z.enum(PLATE_SHAPES).optional(),
				grow: z.number().min(0).max(2000).optional(),
				depth: z.number().min(0).max(2000).optional(),
				gap: z.number().min(-2000).max(2000).optional(),
				corner: z.number().min(0).max(2000).optional(),
				fillCounters: z.boolean().optional(),
				bevelWidth: z.number().min(0).max(2000).optional(),
				bevelDepth: z.number().min(0).max(2000).optional(),
				bevelProfile: z.enum(BEVEL_PROFILES).optional(),
				preset: z.enum(Object.keys(SURFACE_PRESETS) as [string, ...string[]]).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, action, clipId, plateId, index, ...plate }, extra) => {
			if (action !== 'add' && !plateId) throw new ToolError('E_INVALID_PARAM', 'plateId is required to remove or reorder a plate');
			const cmd =
				action === 'add'
					? { type: 'threeD.addBackplate' as const, clipId, ...plate, ...(index !== undefined ? { index } : {}) }
					: action === 'remove'
						? { type: 'threeD.removeBackplate' as const, clipId, plateId: plateId! }
						: { type: 'threeD.reorderBackplate' as const, clipId, plateId: plateId!, index: index ?? 0 };
			return applyHelper(ctx, projectId, 'Backplate', [cmd], extra);
		},
	);

	defineTool(
		ctx,
		'get_3d_scene',
		{
			title: 'Get 3D scene',
			description:
				'The evaluated 3D scene of a sequence at a frame (read-only): the active camera (clip or default, eye, forward, zoom px, focal length mm, horizontal angle of view, depth of field), the lights that are on (type, position, direction, colour × intensity, shadows), every 3D layer drawn there (world position of its anchor, normal, projected corners in frame pixels or null when edge-on / behind the camera) and the 3D runs (consecutive 3D layers drawn together).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: z.string().optional(),
				frame: z.number().int().min(0),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, frame }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = sequenceId ? doc.sequences[sequenceId] : Object.values(doc.sequences)[0];
			if (!seq)
				throw new ToolError('E_NOT_FOUND', `Sequence not found: ${sequenceId}`, 'Call get_project for ids.');
			const snap = buildRenderSnapshot(doc, seq.id, {
				range: { start: frame, end: frame + 1 },
				resolveMedia: () => null,
				resolveFont: () => null,
			});
			const { width: W, height: H, fps } = snap.settings;
			const cam = activeCameraAt(snap, frame);
			const camClip = activeCameraClipAt(snap.scene3d, frame);
			const fwd = [cam.view[8]!, cam.view[9]!, cam.view[10]!];
			const camData = camClip ? (findClip(doc, camClip.clipId).clip as CameraClip).camera : null;
			const frameSize = { width: W, height: H };
			const layers = snap.videoTracks
				.flatMap((t) => t.clips)
				.filter((c) => c.threeD && frame >= c.start && frame < c.start + c.duration)
				.map((c) => {
					const t = clipContentTime(c, frame, fps);
					const world = layerWorldMatrix(c, t, { cameraEye: cam.eye });
					const h = planeHomography(cam, W, H, world);
					const b = c.intrinsicBox;
					const anchor = c.transform
						? c.transform.anchor.keyframes.length
							? null
							: c.transform.anchor.value
						: [0, 0];
					const corners = h
						? (
								[
									[0, 0],
									[b.width, 0],
									[b.width, b.height],
									[0, b.height],
								] as [number, number][]
							).map(([x, y]) => {
								const w = h[6] * x + h[7] * y + h[8];
								return w > 0
									? [r3((h[0] * x + h[1] * y + h[2]) / w), r3((h[3] * x + h[4] * y + h[5]) / w)]
									: null;
							})
						: null;
					return {
						clipId: c.clipId,
						name: c.name,
						costClass: costClassOf(c.threeD, seq.threeD),
						worldCentre: rv(mat4Apply(world, [b.width / 2, b.height / 2, 0])),
						...(anchor ? { worldAnchor: rv(mat4Apply(world, [anchor[0]!, anchor[1]!, 0])) } : {}),
						normal: rv(
							(() => {
								const x = [world[0]!, world[4]!, world[8]!];
								const y = [world[1]!, world[5]!, world[9]!];
								const n = [
									x[1]! * y[2]! - x[2]! * y[1]!,
									x[2]! * y[0]! - x[0]! * y[2]!,
									x[0]! * y[1]! - x[1]! * y[0]!,
								];
								const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
								return n.map((v) => v / l);
							})(),
						),
						corners,
						blendMode: c.blendMode,
					};
				});
			const runs = runs3d(stackAt(snap.videoTracks, frame)).map((r) => ({
				members: r.members,
				bottomTrack: `V${r.bottomTrack + 1}`,
				topTrack: `V${r.topTrack + 1}`,
			}));
			return jsonResult({
				sequenceId: seq.id,
				frame,
				renderer: snap.scene3d?.renderer ?? 'classic',
				camera: {
					clipId: camClip?.clipId ?? null,
					name: camClip?.name ?? 'Default camera (50 mm)',
					eye: rv(cam.eye),
					forward: rv(fwd),
					zoom: r3(cam.zoom),
					focalLength: r3(
						focalLengthForZoom(cam.zoom, frameSize, camData?.filmSize, camData?.measureFilmSize),
					),
					angleOfView: r3(angleOfViewForZoom(cam.zoom, frameSize)),
					depthOfField: cam.dof
						? {
								focusDistance: r3(cam.dof.focus),
								aperture: r3(cam.dof.aperture),
								blurLevel: r3(cam.dof.blurLevel * 100),
							}
						: null,
				},
				lights: lightsAt(snap.scene3d, frame, fps, { environment: true }).map((l) => ({
					clipId: l.clipId,
					type: l.type,
					position: rv(l.pos),
					direction: rv(l.dir),
					color: rv(l.color),
					castsShadows: l.castsShadows,
				})),
				layers,
				runs,
			});
		},
	);

	defineTool(
		ctx,
		'track_camera',
		{
			title: 'Track camera (3D Camera Tracker)',
			description:
				'After Effects\' 3D Camera Tracker on a video clip: applies it (when missing) with the settings given, tracks features through the media frames the clip shows (span to change), solves the camera and lens, and stores the solve (History "Solve Camera"). With wait: false it returns the job; call again with the jobId to store the result. Returns Method Used, Average Error (px) and the number of 3D track points.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				shot: z
					.enum(['fixed', 'variable', 'specify'])
					.optional()
					.describe('Shot Type (default fixed: one focal length)'),
				hfov: z
					.number()
					.min(1)
					.max(170)
					.optional()
					.describe('Horizontal angle of view (°) for shot "specify"'),
				method: z.enum(['auto', 'typical', 'flat', 'tripod']).optional(),
				detailed: z.boolean().optional(),
				lensDistortion: z.boolean().optional(),
				span: z
					.tuple([z.number().int().min(0), z.number().int().min(0)])
					.optional()
					.describe('Media frames [first, last]'),
				wait: z.boolean().optional().describe('Wait for the solve (default true)'),
				jobId: z
					.string()
					.optional()
					.describe('A camtrack job started with wait: false, to wait for and store'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { projectId, clipId } = args;
			let job: EngineJob;
			let timedOut = false;
			if (args.jobId) ({ job, timedOut } = await waitJob(ctx, args.jobId, 3_600_000, extra));
			else {
				const { doc } = await loadDoc(ctx, projectId);
				const settings = {
					...(args.shot ? { shot: args.shot } : {}),
					...(args.hfov !== undefined ? { hfov: args.hfov } : {}),
					...(args.method ? { method: args.method } : {}),
					...(args.detailed !== undefined ? { detailed: args.detailed } : {}),
					...(args.lensDistortion !== undefined ? { lensDistortion: args.lensDistortion } : {}),
					...(args.span ? { span: args.span } : {}),
				};
				const has = !!findCameraTracker(doc, clipId);
				if (!has || Object.keys(settings).length) {
					const res = await transact(
						ctx,
						projectId,
						{
							label: has ? '3D Camera Tracker Settings' : 'Track Camera',
							commands: [{ type: has ? 'cameraTracker.settings' : 'cameraTracker.add', clipId, ...settings }],
						},
						extra,
					);
					requireOk(res);
				}
				const fresh = (await loadDoc(ctx, projectId)).doc;
				let body: ReturnType<typeof cameraTrackerSolveBody>;
				try {
					body = cameraTrackerSolveBody(fresh, clipId);
				} catch (e) {
					throw new ToolError('E_INVALID_PARAM', (e as Error).message);
				}
				const { inputs: _i, ...request } = body;
				job = (await ctx
					.engine((c) => c.call('camtrackSolve', { body: { ...request, projectId } }))
					.catch(camtrackErr)) as EngineJob;
				if (args.wait !== false) ({ job, timedOut } = await waitJob(ctx, job.id, 3_600_000, extra));
			}
			if (!isTerminal(job) || timedOut)
				return jsonResult({
					...jobBody(job, ctx.link.target?.url ?? ''),
					note: 'The camera solve is running. Call track_camera with this jobId (and the clipId) to store it when done.',
				});
			if (job.state !== 'succeeded')
				throw new ToolError(
					job.error?.code ?? 'CAMTRACK_FAILED',
					job.error?.message ?? `The camtrack job ${job.state}`,
				);
			const r = job.result as CamTrackResult;
			const { clipId: _c, trackerId: _t, mediaKey: _m, rate: _r, tracks: _n, ...solve } = r;
			const res = await transact(
				ctx,
				projectId,
				{ label: 'Solve Camera', commands: [{ type: 'cameraTracker.setResult', clipId, solve }] },
				extra,
			);
			const ok = requireOk(res);
			return jsonResult({
				...txBody(res, ok),
				jobId: job.id,
				methodUsed: r.methodUsed,
				averageErrorPx: r.averageError,
				trackPoints: r.points.length,
				featureTracks: r.tracks,
				focalLengthPx: (() => {
					const f = r.frames.filter((_, i) => i % 8 === 6).sort((a, b) => a - b);
					return r3(f[f.length >> 1] ?? 0);
				})(),
				...(r.distortion ? { distortion: r.distortion } : {}),
				next: 'Pick points with get_camera_tracker, then create_tracked_camera (layer text | solid | none).',
			});
		},
	);

	defineTool(
		ctx,
		'get_camera_tracker',
		{
			title: 'Get 3D Camera Tracker',
			description:
				"A clip's 3D Camera Tracker (read-only): settings, span, whether it is solved (and stale), Method Used, Average Error, the created camera, the ground plane, and the track points seen at a sequence frame (id, media px, depth from the camera in solve units, error px) — nearest first, at most `limit`.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				frame: z.number().int().min(0).optional().describe('Sequence frame (default: the clip start)'),
				limit: z.number().int().min(1).max(5000).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId, frame, limit }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip } = findClip(doc, clipId);
			const t = (clip as { cameraTracker?: ClipCameraTracker }).cameraTracker;
			if (!t)
				throw new ToolError(
					'E_INVALID_PARAM',
					`Clip ${clipId} has no 3D Camera Tracker`,
					'Call track_camera first.',
				);
			const f = frame ?? clip.start;
			const media = mediaFrameAt(
				contentTimeAt(clip, f, seq.settings.frameRate as Rational),
				t.rate as Rational,
			);
			const points = trackPointsAt(t, media)
				.sort((a, b) => a.depth - b.depth)
				.slice(0, limit ?? 200)
				.map((p) => ({ id: p.id, uv: rv(p.uv), depth: r3(p.depth), errorPx: r3(p.error) }));
			return jsonResult({
				trackerId: t.id,
				span: t.span,
				settings: cameraTrackerSettingsOf(t.settings),
				deletedPoints: t.deleted.length,
				solved: !!t.solve,
				stale: isSolveStale(t),
				inputs: cameraTrackerInputs(t),
				...(t.solve
					? {
							methodUsed: t.solve.methodUsed,
							averageErrorPx: t.solve.averageError,
							trackPoints: t.solve.points.length - t.deleted.length,
						}
					: {}),
				...(t.createdCameraId ? { cameraClipId: t.createdCameraId } : {}),
				ground: t.ground ?? null,
				mediaFrame: media,
				points,
			});
		},
	);

	defineTool(
		ctx,
		'create_tracked_camera',
		{
			title: 'Create camera from the 3D Camera Tracker',
			description:
				"Create Camera / Create Text and Camera / Create Solid and Camera: a one-node camera keyed on every frame of the tracked clip (position, orientation, zoom for variable zoom) that sees the footage as filmed, and with layer text | solid a 3D layer on the target of pointIds (three or more points: lying in their plane, facing the camera; fewer: facing the camera). replaceCamera rewrites the tracker's camera instead of adding one.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				layer: z.enum(['none', 'text', 'solid']).optional(),
				pointIds: z.array(z.number().int().min(0)).optional(),
				frame: z.number().int().min(0).optional().describe('Media frame the target is seen at'),
				text: z.string().optional(),
				color: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
				replaceCamera: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				args.layer === 'text'
					? 'Create Text and Camera'
					: args.layer === 'solid'
						? 'Create Solid and Camera'
						: 'Create Camera',
				[{ type: 'cameraTracker.create', ...args }],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_tracker_ground',
		{
			title: 'Set ground plane and origin',
			description:
				"Set Ground Plane and Origin: the plane of three or more track points becomes the world's ground (horizontal, y down, through the frame centre at z 0). pointIds [] resets it. Create the camera afterwards (create_tracked_camera with replaceCamera).",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				pointIds: z.array(z.number().int().min(0)),
				frame: z.number().int().min(0).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'Set Ground Plane and Origin',
				[{ type: 'cameraTracker.setGround', ...args }],
				extra,
			),
	);

	defineTool(
		ctx,
		'delete_track_points',
		{
			title: 'Delete track points',
			description:
				'Deletes 3D Camera Tracker track points (bad ones: on moving objects, high error) — they stay out of the next solve. Call track_camera again to re-solve without them (the feature tracks are cached, so it is faster).',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				pointIds: z.array(z.number().int().min(0)).min(1),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, ...args }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'Delete Track Points',
				[{ type: 'cameraTracker.deletePoints', ...args }],
				extra,
			),
	);
}

function camtrackErr(e: unknown): never {
	if (e instanceof EngineError) {
		const code = (e.detail as { code?: string } | undefined)?.code ?? e.code;
		throw new ToolError(code ?? 'ENGINE_ERROR', e.message);
	}
	throw e;
}
