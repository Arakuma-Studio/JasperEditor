// three-d dialogs: Camera Settings and Light Settings (After Effects' Layer ▸ New ▸ Camera… / Light… and
// Layer ▸ Camera Settings… / Light Settings…). New = `clip.addCamera` / `clip.addLight` at the playhead on the top
// track; edit = `camera.settings` / `light.settings` (keys at the playhead for animated values). One undoable
// transaction each.
import {
	type Animatable,
	angleOfViewForZoom,
	apertureMm,
	CAMERA_PRESETS,
	type CommandInput,
	DEFAULT_FILM_SIZE,
	defaultAperture,
	defaultCameraZoom,
	evaluate,
	focalLengthForZoom,
	fStopOf,
	IRIS_SHAPE_LABELS,
	IRIS_SHAPES,
	type IrisShape,
	LIGHT_FALLOFFS,
	LIGHT_TYPE_LABELS,
	LIGHT_TYPES,
	type LightType,
	type RGBA,
	zoomForAngleOfView,
	zoomForFocalLength,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Checkbox,
	ColorPicker,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
} from '@jasper/ui';
import { useMemo, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';

export const CAMERA_DIALOG = 'threeD.cameraSettings';
export const LIGHT_DIALOG = 'threeD.lightSettings';

let registered = false;
export function registerThreeDDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(CAMERA_DIALOG, CameraSettingsDialog);
	registerDialog(LIGHT_DIALOG, LightSettingsDialog);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-[150px] shrink-0 text-pr-muted">{label}</span>
			{children}
		</div>
	);
}

/** A number field that keeps the text while typing and reports finite numbers. */
export function NumberInput(props: {
	value: number;
	onChange(v: number): void;
	label: string;
	step?: number;
	unit?: string;
	testId?: string;
}) {
	const [text, setText] = useState<string | null>(null);
	const shown = text ?? String(Math.round(props.value * 1000) / 1000);
	return (
		<span className="flex items-center gap-1">
			<TextField
				className="w-[110px]"
				value={shown}
				aria-label={props.label}
				data-testid={props.testId}
				inputMode="decimal"
				onChange={(e) => {
					setText(e.target.value);
					const v = Number(e.target.value);
					if (e.target.value.trim() !== '' && Number.isFinite(v)) props.onChange(v);
				}}
				onBlur={() => setText(null)}
			/>
			{props.unit ? <span className="text-pr-small text-pr-dim">{props.unit}</span> : null}
		</span>
	);
}

type Frame = { width: number; height: number };

type CameraProps = {
	session: EditorSession;
	sequenceId: string;
	/** Edit this camera; absent = a new camera at `playhead`. */
	clipId?: string;
	playhead: number;
};

export function CameraSettingsDialog(props: HostedDialogProps<CameraProps>) {
	const { session, sequenceId, clipId, playhead } = props;
	const { open, finish } = useDialogClose(props.close);
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	const frame: Frame = { width: seq?.settings.width ?? 1920, height: seq?.settings.height ?? 1080 };
	const clip = clipId ? seq?.clips[clipId] : undefined;
	const existing = clip?.kind === 'camera' ? clip : undefined;
	const initial = useMemo(() => {
		const c = existing?.camera;
		const t = 0;
		const zoom = c ? Number(evaluate(c.zoom, t)) : defaultCameraZoom(frame.width);
		return {
			name:
				existing?.name ??
				`Camera ${Object.values(seq?.clips ?? {}).filter((x) => x.kind === 'camera').length + 1}`,
			type: (c?.transform.autoOrient ?? 'poi') === 'poi' ? ('two-node' as const) : ('one-node' as const),
			zoom,
			filmSize: c?.filmSize ?? DEFAULT_FILM_SIZE,
			measure: c?.measureFilmSize ?? 'horizontal',
			dof: c?.depthOfField ?? false,
			focus: c ? Number(evaluate(c.focusDistance, t)) : zoom,
			aperture: c ? Number(evaluate(c.aperture, t)) : defaultAperture(frame.width),
			blur: c ? Number(evaluate(c.blurLevel, t)) : 100,
			iris: c?.irisShape ?? ('fast-rectangle' as IrisShape),
		};
	}, [existing, frame.width, seq]);
	const [s, setS] = useState(initial);
	const [lock, setLock] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const set = (patch: Partial<typeof s>) =>
		setS((cur) => {
			const next = { ...cur, ...patch };
			if (lock && patch.zoom !== undefined) next.focus = patch.zoom;
			return next;
		});
	const focal = focalLengthForZoom(s.zoom, frame, s.filmSize, s.measure);
	const aov = angleOfViewForZoom(s.zoom, frame, s.measure);
	const preset = CAMERA_PRESETS.find(
		(p) =>
			Math.abs(zoomForFocalLength(p.focalLength, frame) - s.zoom) < 0.01 && s.filmSize === DEFAULT_FILM_SIZE,
	);
	const apply = () => {
		const lens = {
			zoom: s.zoom,
			filmSize: s.filmSize,
			measureFilmSize: s.measure,
			depthOfField: s.dof,
			focusDistance: s.focus,
			aperture: s.aperture,
			blurLevel: s.blur,
			irisShape: s.iris,
		};
		const command: CommandInput = existing
			? {
					type: 'camera.settings',
					clipId: existing.id,
					name: s.name,
					cameraType: s.type,
					...lens,
					at: { sequenceFrame: playhead },
				}
			: { type: 'clip.addCamera', at: playhead, name: s.name, cameraType: s.type, ...lens };
		const r = session.apply({
			label: existing ? 'Camera Settings' : 'New Camera',
			origin: 'user',
			sequenceId,
			commands: [command],
			...(existing
				? {}
				: {
						selectAfter: (res) => ({
							timeline: [(res.results[0] as { clipId: string }).clipId],
						}),
					}),
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Not possible');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Camera Settings"
			size="medium"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="camera-settings-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<Row label="Type">
					<Select
						value={s.type}
						onValueChange={(v) => set({ type: v as 'one-node' | 'two-node' })}
						label="Camera type"
						options={[
							{ value: 'two-node', label: 'Two-Node Camera' },
							{ value: 'one-node', label: 'One-Node Camera' },
						]}
					/>
				</Row>
				<Row label="Name">
					<TextField
						value={s.name}
						onChange={(e) => set({ name: e.target.value })}
						aria-label="Camera name"
					/>
				</Row>
				<Row label="Preset">
					<Select
						value={preset?.name ?? 'custom'}
						onValueChange={(v) => {
							const p = CAMERA_PRESETS.find((x) => x.name === v);
							if (p)
								set({
									zoom: zoomForFocalLength(p.focalLength, frame),
									filmSize: DEFAULT_FILM_SIZE,
									measure: 'horizontal',
								});
						}}
						label="Camera preset"
						options={[
							{ value: 'custom', label: 'Custom' },
							...CAMERA_PRESETS.map((p) => ({ value: p.name, label: p.name })),
						]}
					/>
				</Row>
				<Row label="Zoom">
					<NumberInput
						value={s.zoom}
						onChange={(v) => v > 0 && set({ zoom: v })}
						label="Zoom"
						unit="px"
						testId="camera-zoom"
					/>
				</Row>
				<Row label="Angle of View">
					<NumberInput
						value={aov}
						onChange={(v) => v > 0 && v < 180 && set({ zoom: zoomForAngleOfView(v, frame, s.measure) })}
						label="Angle of view"
						unit="°"
					/>
				</Row>
				<Row label="Focal Length">
					<NumberInput
						value={focal}
						onChange={(v) => v > 0 && set({ zoom: zoomForFocalLength(v, frame, s.filmSize, s.measure) })}
						label="Focal length"
						unit="mm"
						testId="camera-focal"
					/>
				</Row>
				<Row label="Film Size">
					<NumberInput
						value={s.filmSize}
						onChange={(v) => v > 0 && set({ filmSize: v })}
						label="Film size"
						unit="mm"
					/>
					<Select
						value={s.measure}
						onValueChange={(v) => set({ measure: v as typeof s.measure })}
						label="Measure film size"
						options={[
							{ value: 'horizontal', label: 'Horizontally' },
							{ value: 'vertical', label: 'Vertically' },
							{ value: 'diagonal', label: 'Diagonally' },
						]}
					/>
				</Row>
				<Checkbox checked={s.dof} onCheckedChange={(v) => set({ dof: v })} label="Enable Depth of Field" />
				<Row label="Focus Distance">
					<NumberInput
						value={s.focus}
						onChange={(v) => v >= 0 && setS({ ...s, focus: v })}
						label="Focus distance"
						unit="px"
					/>
					<Checkbox checked={lock} onCheckedChange={(v) => setLock(v)} label="Lock to Zoom" />
				</Row>
				<Row label="Aperture">
					<NumberInput
						value={apertureMm(s.aperture, frame.width)}
						onChange={(v) => v >= 0 && set({ aperture: (v * frame.width) / 1920 })}
						label="Aperture"
						unit="mm"
					/>
					<span className="text-pr-small text-pr-dim">F-Stop</span>
					<NumberInput
						value={fStopOf(focal, s.aperture, frame.width)}
						onChange={(v) => v > 0 && set({ aperture: ((focal / v) * frame.width) / 1920 })}
						label="F-Stop"
					/>
				</Row>
				<Row label="Blur Level">
					<NumberInput
						value={s.blur}
						onChange={(v) => v >= 0 && set({ blur: v })}
						label="Blur level"
						unit="%"
					/>
				</Row>
				<Row label="Iris Shape">
					<Select
						value={s.iris}
						onValueChange={(v) => set({ iris: v as IrisShape })}
						label="Iris shape"
						options={IRIS_SHAPES.map((x) => ({ value: x, label: IRIS_SHAPE_LABELS[x] }))}
					/>
				</Row>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

type LightProps = { session: EditorSession; sequenceId: string; clipId?: string; playhead: number };

export function LightSettingsDialog(props: HostedDialogProps<LightProps>) {
	const { session, sequenceId, clipId, playhead } = props;
	const { open, finish } = useDialogClose(props.close);
	const seq = session.getCommitted().sequences[sequenceId];
	const clip = clipId ? seq?.clips[clipId] : undefined;
	const existing = clip?.kind === 'light' ? clip : undefined;
	const [s, setS] = useState(() => {
		const l = existing?.light;
		const v = (a: Animatable<number> | undefined, defaultValue: number) =>
			a ? evaluate(a, 0) : defaultValue;
		return {
			name:
				existing?.name ??
				`Light ${Object.values(seq?.clips ?? {}).filter((x) => x.kind === 'light').length + 1}`,
			type: (l?.type ?? 'spot') as LightType,
			color: (l ? (evaluate(l.color, 0) as RGBA) : [1, 1, 1, 1]) as RGBA,
			intensity: v(l?.intensity, 100),
			coneAngle: v(l?.coneAngle, 90),
			coneFeather: v(l?.coneFeather, 50),
			falloff: l?.falloff ?? 'none',
			radius: v(l?.radius, 500),
			falloffDistance: v(l?.falloffDistance, 500),
			castsShadows: l?.castsShadows ?? false,
			shadowDarkness: v(l?.shadowDarkness, 100),
			shadowDiffusion: v(l?.shadowDiffusion, 0),
		};
	});
	const [error, setError] = useState<string | null>(null);
	const set = (p: Partial<typeof s>) => setS((cur) => ({ ...cur, ...p }));
	const placed = s.type === 'parallel' || s.type === 'spot' || s.type === 'point';
	const apply = () => {
		const opts = {
			intensity: s.intensity,
			color: s.color,
			...(s.type === 'spot' ? { coneAngle: s.coneAngle, coneFeather: s.coneFeather } : {}),
			...(s.type === 'spot' || s.type === 'point'
				? { falloff: s.falloff, radius: s.radius, falloffDistance: s.falloffDistance }
				: {}),
			...(placed
				? {
						castsShadows: s.castsShadows,
						shadowDarkness: s.shadowDarkness,
						shadowDiffusion: s.shadowDiffusion,
					}
				: {}),
		};
		const command: CommandInput = existing
			? {
					type: 'light.settings',
					clipId: existing.id,
					name: s.name,
					lightType: s.type,
					...opts,
					at: { sequenceFrame: playhead },
				}
			: { type: 'clip.addLight', at: playhead, name: s.name, lightType: s.type, ...opts };
		const r = session.apply({
			label: existing ? 'Light Settings' : 'New Light',
			origin: 'user',
			sequenceId,
			commands: [command],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Not possible');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Light Settings"
			size="medium"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="light-settings-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<Row label="Name">
					<TextField value={s.name} onChange={(e) => set({ name: e.target.value })} aria-label="Light name" />
				</Row>
				<Row label="Light Type">
					<Select
						value={s.type}
						onValueChange={(v) => set({ type: v as LightType })}
						label="Light type"
						options={LIGHT_TYPES.map((t) => ({ value: t, label: LIGHT_TYPE_LABELS[t] }))}
					/>
				</Row>
				<Row label="Color">
					<ColorPicker value={s.color} onChange={(c) => set({ color: c as RGBA })} alpha={false} />
				</Row>
				<Row label="Intensity">
					<NumberInput
						value={s.intensity}
						onChange={(v) => set({ intensity: v })}
						label="Intensity"
						unit="%"
					/>
				</Row>
				{s.type === 'spot' ? (
					<>
						<Row label="Cone Angle">
							<NumberInput
								value={s.coneAngle}
								onChange={(v) => set({ coneAngle: v })}
								label="Cone angle"
								unit="°"
							/>
						</Row>
						<Row label="Cone Feather">
							<NumberInput
								value={s.coneFeather}
								onChange={(v) => set({ coneFeather: v })}
								label="Cone feather"
								unit="%"
							/>
						</Row>
					</>
				) : null}
				{s.type === 'spot' || s.type === 'point' ? (
					<>
						<Row label="Falloff">
							<Select
								value={s.falloff}
								onValueChange={(v) => set({ falloff: v as typeof s.falloff })}
								label="Falloff"
								options={LIGHT_FALLOFFS.map((f) => ({
									value: f,
									label: f === 'none' ? 'None' : f === 'smooth' ? 'Smooth' : 'Inverse Square Clamped',
								}))}
							/>
						</Row>
						<Row label="Radius">
							<NumberInput
								value={s.radius}
								onChange={(v) => v >= 0 && set({ radius: v })}
								label="Radius"
								unit="px"
							/>
						</Row>
						<Row label="Falloff Distance">
							<NumberInput
								value={s.falloffDistance}
								onChange={(v) => v >= 0 && set({ falloffDistance: v })}
								label="Falloff distance"
								unit="px"
							/>
						</Row>
					</>
				) : null}
				{placed ? (
					<>
						<Checkbox
							checked={s.castsShadows}
							onCheckedChange={(v) => set({ castsShadows: v })}
							label="Casts Shadows"
						/>
						<Row label="Shadow Darkness">
							<NumberInput
								value={s.shadowDarkness}
								onChange={(v) => v >= 0 && v <= 100 && set({ shadowDarkness: v })}
								label="Shadow darkness"
								unit="%"
							/>
						</Row>
						<Row label="Shadow Diffusion">
							<NumberInput
								value={s.shadowDiffusion}
								onChange={(v) => v >= 0 && set({ shadowDiffusion: v })}
								label="Shadow diffusion"
								unit="px"
							/>
						</Row>
						<p className="text-pr-small text-pr-dim">Only layers with Casts Shadows on cast shadows.</p>
					</>
				) : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}
