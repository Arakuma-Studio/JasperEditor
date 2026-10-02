// Properties ▸ Composition (M2, S08:MGU-003): bundle + composition, status (live / preview ready / rendering
// master n %), the props form generated from the composition's JSON Schema (`props.*` property specs: text,
// textarea, colour, number, toggle, select, JSON for arrays and free-form values), Reset to defaults, Edit as
// JSON, Rebuild bundle (project folders) and Render master now. Edits are `param.set` on
// `["clip", id, "props", …]` (one History entry each; scrubs are one gesture), validated by the model.
// M3 (wp-m3-mgtext, S08:MGU-006): the composition's texts come first with their own editors (CompositionTexts);
// the generic form lists the remaining props.
import {
	type Clip,
	type Command,
	type CompositionClip,
	compositionFpsMismatch,
	compositionOfClip,
	compositionPropsPropertySpecs,
	compositionTextLayers,
	effectiveCompositionProps,
	getPropAt,
	type MediaAsset,
	type PropertySpec,
	propertyKeyToParamPath,
	textLayerPropertyKeys,
	unsetPropOverride,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { Button, cx } from '@jasper/ui';
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ClipSectionProps } from '../extensions/index.ts';
import {
	CheckboxField,
	ColorField,
	MiniButton,
	SelectField,
	TextField,
} from '../panels/properties/controls/fields.tsx';
import { ResetGlyph } from '../panels/properties/controls/glyphs.tsx';
import { ScrubbyNumber } from '../panels/properties/controls/ScrubbyNumber.tsx';
import { createScrub } from '../panels/properties/lib/ops.ts';
import { CompositionTexts } from './CompositionTexts.tsx';
import { bundleErrorText, rebuildBundle } from './import.ts';
import { useMgRuntimeAttach } from './RuntimeHost.tsx';
import { type ClipMgStatus, currentMgRuntime, type MgRuntime } from './runtime.ts';

const ROW = 'flex min-h-[var(--pr-row-h)] items-center gap-2 pl-2 pr-1';
const LABEL = 'w-[34%] shrink-0 truncate text-pr-ui text-pr-muted';

// ---------------------------------------------------------------- CSS colour strings ↔ RGBA

type RGBA = [number, number, number, number];

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` (0..1 floats). */ // tokens-allow: prop value (CSS colour string), not a UI colour
function parseCssColor(s: string): RGBA | null {
	const v = s.trim();
	let m = /^#([0-9a-f]{3,4})$/i.exec(v);
	if (m) {
		const d = m[1]!.split('').map((c) => Number.parseInt(c + c, 16) / 255);
		return [d[0]!, d[1]!, d[2]!, d[3] ?? 1];
	}
	m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
	if (m) {
		const n = (i: number) => Number.parseInt(m![1]!.slice(i, i + 2), 16) / 255;
		return [n(0), n(2), n(4), m[2] ? Number.parseInt(m[2], 16) / 255 : 1];
	}
	m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
	if (m)
		return [
			Number(m[1]) / 255,
			Number(m[2]) / 255,
			Number(m[3]) / 255,
			m[4] !== undefined ? Number(m[4]) : 1,
		];
	return null;
}

/** Formats `c` in the notation of `like` (`#rrggbb`, `#rrggbbaa`, `rgba()`), so schema patterns keep matching. */ // tokens-allow: prop value (CSS colour string), not a UI colour
function formatCssColor(c: RGBA, like: string): string {
	const h = (x: number) =>
		Math.round(Math.min(1, Math.max(0, x)) * 255)
			.toString(16)
			.padStart(2, '0');
	const t = like.trim();
	if (/^rgba?\(/i.test(t)) {
		const b = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
		return c[3] < 1 || /^rgba/i.test(t)
			? `rgba(${b(c[0])}, ${b(c[1])}, ${b(c[2])}, ${Math.round(c[3] * 1000) / 1000})` // tokens-allow: prop value (CSS colour string), not a UI colour
			: `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`; // tokens-allow: prop value (CSS colour string), not a UI colour
	}
	const upper = /[A-F]/.test(t) && !/[a-f]/.test(t);
	const hex = `#${h(c[0])}${h(c[1])}${h(c[2])}${/^#([0-9a-f]{8}|[0-9a-f]{4})$/i.test(t) ? h(c[3]) : ''}`;
	return upper ? hex.toUpperCase() : hex;
}

/** Overrides = the parts of `value` that differ from `defaults` (objects compared key by key). */
function diffOverrides(
	defaults: Record<string, unknown>,
	value: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		const d = defaults[k];
		if (JSON.stringify(d) === JSON.stringify(v)) continue;
		if (v && d && typeof v === 'object' && typeof d === 'object' && !Array.isArray(v) && !Array.isArray(d)) {
			const sub = diffOverrides(d as Record<string, unknown>, v as Record<string, unknown>);
			if (Object.keys(sub).length) out[k] = sub;
		} else out[k] = v;
	}
	return out;
}

// ---------------------------------------------------------------- status

function useMgStatus(runtime: MgRuntime | null, clipId: string): ClipMgStatus | null {
	const sub = useMemo(() => (cb: () => void) => runtime?.subscribe(cb) ?? (() => undefined), [runtime]);
	const version = useSyncExternalStore(sub, () => runtime?.version() ?? 0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version drives the recomputation
	return useMemo(() => runtime?.status(clipId) ?? null, [runtime, clipId, version]);
}

function statusText(s: ClipMgStatus | null): { text: string; tone: 'ok' | 'busy' | 'warn' | 'idle' } {
	if (!s) return { text: 'Live preview', tone: 'idle' };
	const pct = (p?: number) => (p !== undefined ? ` ${Math.round(p * 100)} %` : '');
	if (s.master.state === 'rendering' || s.master.state === 'queued')
		return { text: `Rendering master${pct(s.master.progress)}`, tone: 'busy' };
	if (s.master.state === 'failed') return { text: `Master failed: ${s.master.error ?? ''}`, tone: 'warn' };
	if (s.preview.state === 'rendering' || s.preview.state === 'queued')
		return { text: `Rendering preview${pct(s.preview.progress)}`, tone: 'busy' };
	if (s.master.state === 'ready')
		return {
			text: s.preview.state === 'ready' ? 'Preview ready · master cached' : 'Master cached',
			tone: 'ok',
		};
	if (s.preview.state === 'ready') return { text: 'Preview ready', tone: 'ok' };
	if (s.host?.state === 'error') return { text: `Live preview error: ${s.host.message ?? ''}`, tone: 'warn' };
	if (s.preview.state === 'failed') return { text: `Preview failed: ${s.preview.error ?? ''}`, tone: 'warn' };
	return {
		text: s.preview.state === 'scheduled' ? 'Live preview · preview pending' : 'Live preview',
		tone: 'idle',
	};
}

// ---------------------------------------------------------------- the section

export function CompositionSection(props: ClipSectionProps) {
	const { session, clips } = props;
	const runtime = useMgRuntimeAttach(session);
	const doc = useSessionState((s) => s.transient ?? s.document);
	const comps = clips.filter((c): c is CompositionClip => c.kind === 'composition');
	if (comps.length !== 1) {
		return (
			<p className="px-2 py-1 text-pr-small text-pr-muted" data-testid="composition-section">
				{comps.length} composition clips selected — select one to edit its props.
			</p>
		);
	}
	const clip =
		(doc.sequences[props.sequenceId]?.clips[comps[0]!.id] as CompositionClip | undefined) ?? comps[0]!;
	return <OneComposition session={session} clip={clip} runtime={runtime} sequenceId={props.sequenceId} />;
}

function OneComposition(props: {
	session: EditorSession;
	clip: CompositionClip;
	runtime: MgRuntime | null;
	sequenceId: string;
}) {
	const { session, clip, runtime } = props;
	const doc = useSessionState((s) => s.transient ?? s.document);
	const seq = doc.sequences[props.sequenceId];
	const found = compositionOfClip(doc, clip);
	const asset = clip.composition.mediaId
		? (doc.media[clip.composition.mediaId] as MediaAsset | undefined)
		: undefined;
	const status = useMgStatus(runtime, clip.id);
	const [jsonOpen, setJsonOpen] = useState(false);
	const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
	const info = found?.info;
	const textLayers = useMemo(() => (info ? compositionTextLayers(info) : []), [info]);
	const specs = useMemo(() => {
		if (!info) return [];
		const owned = textLayerPropertyKeys(textLayers);
		return compositionPropsPropertySpecs(info).filter((s) => !owned.has(s.key));
	}, [info, textLayers]);
	const effective = useMemo(() => effectiveCompositionProps(doc, clip), [doc, clip]);
	const st = statusText(status);
	const readOnly = useSessionState((s) => s.readOnly);

	const apply = (label: string, commands: Command[]) => {
		const r = session.apply({ label, origin: 'user', commands });
		if (!r.ok) setMessage({ kind: 'error', text: r.errors.map((e) => e.message).join('; ') });
		else setMessage(null);
		return r;
	};
	const setProp = (spec: PropertySpec, value: unknown) =>
		apply(spec.label, [
			{ type: 'param.set', target: propertyKeyToParamPath({ clipId: clip.id }, spec.key), value } as Command,
		]);
	const resetProp = (spec: PropertySpec) =>
		apply(`Reset ${spec.label}`, [
			{
				type: 'clip.update',
				clipId: clip.id,
				patch: { props: unsetPropOverride(clip.props, spec.storagePath.slice(1)) },
			} as Command,
		]);

	if (!found)
		return (
			<div className="px-2 py-1 text-pr-small" data-testid="composition-section">
				<p className="text-pr-danger">
					Composition {clip.composition.id} is not in {asset ? `bundle ${asset.originalName}` : 'the project'}
					.
				</p>
				<p className="text-pr-muted">Rebuild or re-import the Remotion project, or delete the clip.</p>
			</div>
		);
	const fpsMismatch = seq ? compositionFpsMismatch(found.info, seq.settings.frameRate) : false;
	const projectDir = asset?.mgBundle?.source.type === 'project-dir' ? asset.mgBundle.source.path : null;

	return (
		<div data-testid="composition-section" data-clip-id={clip.id}>
			<div className={ROW}>
				<span className={LABEL}>Bundle</span>
				<span className="min-w-0 truncate text-pr-ui text-pr-text" title={projectDir ?? asset?.originalName}>
					{asset?.mgBundle?.source.name ?? asset?.originalName} · {found.info.id}
				</span>
			</div>
			<div className={ROW}>
				<span className={LABEL}>Status</span>
				<span
					className={cx(
						'min-w-0 truncate text-pr-ui',
						st.tone === 'ok'
							? 'text-pr-success'
							: st.tone === 'warn'
								? 'text-pr-warning'
								: st.tone === 'busy'
									? 'text-pr-text'
									: 'text-pr-muted',
					)}
					data-testid="composition-status"
					data-status={st.tone}
					title={st.text}
				>
					{st.text}
				</span>
			</div>
			{fpsMismatch ? (
				<p className="px-2 py-[2px] text-pr-small text-pr-warning" data-testid="composition-fps-warning">
					Composition is {found.info.fps} fps, sequence{' '}
					{+(seq!.settings.frameRate.num / seq!.settings.frameRate.den).toFixed(3)} fps: it renders at the
					sequence rate.
				</p>
			) : null}
			{textLayers.length ? (
				<>
					<SubHeading>Text</SubHeading>
					<CompositionTexts
						session={session}
						clip={clip}
						info={found.info}
						layers={textLayers}
						effective={effective}
						seq={
							seq
								? { width: seq.settings.width, height: seq.settings.height, rate: seq.settings.frameRate }
								: null
						}
						disabled={readOnly}
						onMessage={setMessage}
					/>
					{specs.length ? <SubHeading>Props</SubHeading> : null}
				</>
			) : null}
			<div className="pt-1" data-testid="composition-props">
				{specs.length === 0 ? (
					textLayers.length ? null : (
						<p className="px-2 text-pr-small text-pr-muted">This composition has no props.</p>
					)
				) : (
					specs.map((spec) => (
						<PropRow
							key={spec.key}
							session={session}
							clip={clip}
							spec={spec}
							value={getPropAt(effective, spec.storagePath.slice(1))}
							overridden={getPropAt(clip.props, spec.storagePath.slice(1)) !== undefined}
							disabled={readOnly}
							onSet={(v) => setProp(spec, v)}
							onReset={() => resetProp(spec)}
						/>
					))
				)}
			</div>
			{jsonOpen ? (
				<JsonEditor
					value={effective}
					onCancel={() => setJsonOpen(false)}
					onApply={(v) => {
						const r = apply('Edit Props', [
							{
								type: 'clip.update',
								clipId: clip.id,
								patch: { props: diffOverrides(found.info.defaultProps, v) },
							} as Command,
						]);
						if (r.ok) setJsonOpen(false);
					}}
				/>
			) : null}
			{message ? (
				<p
					className={cx(
						'px-2 py-1 text-pr-small',
						message.kind === 'error' ? 'text-pr-danger' : 'text-pr-muted',
					)}
					role={message.kind === 'error' ? 'alert' : 'status'}
					data-testid="composition-message"
				>
					{message.text}
				</p>
			) : null}
			<div className="flex flex-wrap gap-1 px-2 pt-1">
				<Button
					variant="secondary"
					disabled={readOnly || Object.keys(clip.props).length === 0}
					onClick={() =>
						apply('Reset Props', [{ type: 'clip.update', clipId: clip.id, patch: { props: {} } } as Command])
					}
					data-testid="composition-reset"
				>
					Reset to defaults
				</Button>
				<Button
					variant="secondary"
					disabled={readOnly}
					onClick={() => setJsonOpen((o) => !o)}
					data-testid="composition-json"
				>
					Edit as JSON
				</Button>
				{projectDir ? (
					<Button
						variant="secondary"
						onClick={() => {
							if (!asset || !session.engine) return;
							setMessage({ kind: 'info', text: 'Rebuilding the bundle…' });
							rebuildBundle(session.engine, asset, session.projectId).then(
								() =>
									setMessage({ kind: 'info', text: 'Rebuilding the bundle… (progress in the Jobs panel)' }),
								(e) => setMessage({ kind: 'error', text: bundleErrorText(e) }),
							);
						}}
						data-testid="composition-rebuild"
					>
						Rebuild bundle
					</Button>
				) : null}
				<Button
					variant="secondary"
					onClick={() => {
						const rt = runtime ?? currentMgRuntime();
						if (!rt) return;
						void rt
							.renderMaster(clip.id)
							.then((job) =>
								setMessage(job ? null : { kind: 'error', text: 'The master could not be queued' }),
							);
					}}
					data-testid="composition-render-master"
				>
					Render master now
				</Button>
			</div>
		</div>
	);
}

function SubHeading(props: { children: ReactNode }) {
	return (
		<div className="mt-2 flex items-center gap-2 px-2 text-pr-small text-pr-muted uppercase tracking-wide">
			<span>{props.children}</span>
			<span className="h-px flex-1 bg-pr-border" />
		</div>
	);
}

function PropRow(props: {
	session: EditorSession;
	clip: Clip;
	spec: PropertySpec;
	value: unknown;
	overridden: boolean;
	disabled: boolean;
	onSet(v: unknown): void;
	onReset(): void;
}) {
	const { spec, value } = props;
	const depth = spec.storagePath.length - 2;
	return (
		<div className={ROW} data-prop={spec.key}>
			<span
				className={cx(LABEL, props.overridden && 'text-pr-text')}
				style={depth > 0 ? { paddingLeft: depth * 10 } : undefined}
				title={spec.description ?? spec.key}
			>
				{spec.label}
			</span>
			<div className="flex min-w-0 flex-1 items-center gap-1">
				<PropEditor {...props} />
			</div>
			<MiniButton
				label={`Reset ${spec.label}`}
				disabled={props.disabled || !props.overridden}
				onClick={props.onReset}
				data-testid={`prop-reset-${spec.key}`}
			>
				<ResetGlyph size={12} />
			</MiniButton>
			{value === undefined ? <span className="sr-only">unset</span> : null}
		</div>
	);
}

export function PropEditor(props: {
	session: EditorSession;
	clip: Clip;
	spec: PropertySpec;
	value: unknown;
	disabled: boolean;
	onSet(v: unknown): void;
}): ReactNode {
	const { spec, value, disabled } = props;
	const testId = `prop-${spec.key}`;
	switch (spec.kind) {
		case 'number':
			return <NumberEditor {...props} />;
		case 'boolean':
			return (
				<CheckboxField
					value={typeof value === 'boolean' ? value : null}
					label={spec.label}
					disabled={disabled}
					onChange={props.onSet}
				/>
			);
		case 'enum':
			return (
				<SelectField
					value={typeof value === 'string' ? value : null}
					options={spec.options ?? []}
					label={spec.label}
					disabled={disabled}
					onChange={props.onSet}
					data-testid={testId}
				/>
			);
		case 'string': {
			const text = typeof value === 'string' ? value : value === undefined ? '' : String(value);
			if (spec.ui.control === 'color') {
				const rgba = parseCssColor(text);
				const alpha = /^#([0-9a-f]{8}|[0-9a-f]{4})$/i.test(text.trim()) || /^rgba/i.test(text.trim());
				return (
					<>
						<ColorField
							value={rgba}
							label={spec.label}
							alpha={alpha}
							disabled={disabled}
							onChange={(c) => props.onSet(formatCssColor(c, text || '#000000'))} // tokens-allow: prop value (CSS colour string), not a UI colour
							data-testid={`${testId}-swatch`}
						/>
						<TextField
							value={text}
							label={`${spec.label} value`}
							disabled={disabled}
							onCommit={props.onSet}
							data-testid={testId}
						/>
					</>
				);
			}
			return (
				<TextField
					value={text}
					label={spec.label}
					multiline={!!spec.ui.multiline}
					disabled={disabled}
					onCommit={props.onSet}
					data-testid={testId}
				/>
			);
		}
		default:
			return <JsonValueEditor {...props} />;
	}
}

function NumberEditor(props: {
	session: EditorSession;
	clip: Clip;
	spec: PropertySpec;
	value: unknown;
	disabled: boolean;
	onSet(v: unknown): void;
}) {
	const { spec, session, clip } = props;
	const value = typeof props.value === 'number' ? props.value : null;
	const scrub = useMemo(() => createScrub(session), [session]);
	const [base, setBase] = useState(0);
	const clamp = (x: number) => {
		const lo = spec.range?.min ?? Number.NEGATIVE_INFINITY;
		const hi = spec.range?.max ?? Number.POSITIVE_INFINITY;
		const v = Math.min(hi, Math.max(lo, x));
		return spec.range?.step === 1 ? Math.round(v) : v;
	};
	const cmd = (v: number) =>
		({
			type: 'param.set',
			target: propertyKeyToParamPath({ clipId: clip.id }, spec.key),
			value: v,
		}) as Command;
	return (
		<ScrubbyNumber
			value={value}
			label={spec.label}
			step={spec.range?.step ?? 1}
			precision={spec.ui.precision ?? (spec.range?.step === 1 ? 0 : 2)}
			{...(spec.range?.min !== undefined ? { min: spec.range.min } : {})}
			{...(spec.range?.max !== undefined ? { max: spec.range.max } : {})}
			disabled={props.disabled}
			onScrubStart={() => {
				setBase(value ?? 0);
				scrub.start(spec.label);
			}}
			onScrub={(d) => scrub.update([cmd(clamp(base + d))])}
			onScrubEnd={(cancelled) => scrub.end(cancelled)}
			onCommit={(fn) => props.onSet(clamp(fn(value ?? 0)))}
			data-testid={`prop-${spec.key}`}
		/>
	);
}

/** Arrays and free-form values: a one-line JSON field (S08:MGC-011 "everything stays editable as JSON"). */
function JsonValueEditor(props: {
	spec: PropertySpec;
	value: unknown;
	disabled: boolean;
	onSet(v: unknown): void;
}) {
	const text = props.value === undefined ? '' : JSON.stringify(props.value);
	const [error, setError] = useState(false);
	return (
		<span className={cx('min-w-0 flex-1', error && 'outline outline-1 outline-pr-danger')}>
			<TextField
				value={text}
				label={`${props.spec.label} (JSON)`}
				disabled={props.disabled}
				onCommit={(t) => {
					try {
						props.onSet(JSON.parse(t));
						setError(false);
					} catch {
						setError(true);
					}
				}}
				data-testid={`prop-${props.spec.key}`}
			/>
		</span>
	);
}

function JsonEditor(props: {
	value: Record<string, unknown>;
	onApply(v: Record<string, unknown>): void;
	onCancel(): void;
}) {
	const [text, setText] = useState(() => JSON.stringify(props.value, null, 2));
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setText(JSON.stringify(props.value, null, 2)), [props.value]);
	return (
		<div className="flex flex-col gap-1 px-2 pt-1" data-testid="composition-json-editor">
			<textarea
				aria-label="Props as JSON"
				className="h-40 w-full resize-y rounded-pr-control border border-transparent bg-pr-field px-1 py-1 font-pr-mono text-pr-small text-pr-text focus:outline focus:outline-1 focus:outline-pr-focus"
				value={text}
				spellCheck={false}
				onChange={(e) => setText(e.target.value)}
			/>
			{error ? <p className="text-pr-small text-pr-danger">{error}</p> : null}
			<div className="flex gap-1">
				<Button
					onClick={() => {
						try {
							const v = JSON.parse(text);
							if (!v || typeof v !== 'object' || Array.isArray(v))
								throw new Error('Props must be a JSON object');
							setError(null);
							props.onApply(v as Record<string, unknown>);
						} catch (e) {
							setError(e instanceof Error ? e.message : String(e));
						}
					}}
					data-testid="composition-json-apply"
				>
					Apply
				</Button>
				<Button variant="secondary" onClick={props.onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
