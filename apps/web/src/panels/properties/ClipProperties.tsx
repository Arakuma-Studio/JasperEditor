// Properties for selected clips (S03:INS-002…005, S05:PRP-001/002): Transform, Crop, Blend Mode,
// Speed & Duration (read-only in M1), kind sections (Text + Box, Solid color, Motion Graphic
// parameters generated from the template schema), applied effects, and audio Gain/Level/Pan.
// Multi-selection shows the intersection per category; differing values show `–` and scrubs apply a
// relative delta to each clip (S03:INS-004).
import {
	type Clip,
	type Command,
	type EffectInstance,
	isKnownClipKind,
	kindCapabilities,
	type PropertySpec,
	paramsPropertySpecs,
	type Sequence,
	templateParamSections,
	templateParamVisible,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx, TimecodeText } from '@jasper/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { clipSections, templateParamControls } from '../../extensions/index.ts';
import { useRegistry } from '../../extensions/react.ts';
import { formatTimecode } from '../../gaps/time-display.ts';
import { MiniButton, SelectField } from './controls/fields.tsx';
import { FxGlyph, TrashGlyph } from './controls/glyphs.tsx';
import { PropertyRow, type RowContext } from './controls/PropertyRow.tsx';
import { Section } from './controls/Section.tsx';
import { TemplateGroupActions } from './controls/TemplateGroupActions.tsx';
import {
	bindCrop,
	bindProperty,
	isAudioClip,
	isVisualClip,
	makeRow,
	planSet,
	type Row,
	rowValue,
	templateOf,
} from './lib/model.ts';
import { absorbedTemplateParams } from './lib/template-params.ts';

const CROP_PARAMS = ['left', 'top', 'right', 'bottom', 'feather'] as const;
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export function ClipProperties(props: { session: EditorSession; clips: Clip[]; ctx: RowContext }) {
	const { session, clips, ctx } = props;
	const { doc, seq, frame } = ctx;
	const sections = useRegistry(clipSections);
	const mg = session.ctx.registries.mgTemplates;
	const effects = session.ctx.registries.effects;
	const visual = clips.filter(isVisualClip);
	const audio = clips.filter(isAudioClip);
	// cameras and lights have their own sections.
	const cameras = clips.filter((c) => c.kind === 'camera');
	const lights = clips.filter((c) => c.kind === 'light');
	const other = clips.filter(
		(c) => !isVisualClip(c) && !isAudioClip(c) && c.kind !== 'camera' && c.kind !== 'light',
	);
	const all3d =
		visual.length > 0 &&
		visual.every((c) => (c as { threeD?: { enabled?: boolean } }).threeD?.enabled === true);
	const rowFor = (key: string, list: Clip[]): Row | null =>
		makeRow(
			key,
			list.map((c) => bindProperty(doc, seq, c, key, frame, mg)),
		);
	const rows = (keys: string[], list: Clip[]) =>
		keys.map((k) => rowFor(k, list)).filter((r): r is Row => r !== null && r.bindings.length === list.length);
	const render = (r: Row | null, extra?: Partial<Parameters<typeof PropertyRow>[0]>) =>
		r ? <PropertyRow key={r.id} row={r} ctx={ctx} {...extra} /> : null;

	const allKind = (k: Clip['kind']) => visual.length > 0 && visual.every((c) => c.kind === k);
	const nonUniform = visual.some(
		(c) => (c as { transform?: { uniformScale: boolean } }).transform?.uniformScale === false,
	);
	const title = clips.length === 1 ? clips[0]!.name || clips[0]!.kind : `${clips.length} clips selected`;

	return (
		<div data-testid="clip-properties">
			<header className="flex h-[28px] items-center gap-2 px-2 text-pr-ui text-pr-strong">
				<span className="truncate">{title}</span>
				{clips.length > 1 ? (
					<span className="ml-auto text-pr-small text-pr-muted">
						{visual.length ? `${visual.length} video` : ''}
						{visual.length && audio.length ? ' · ' : ''}
						{audio.length ? `${audio.length} audio` : ''}
					</span>
				) : null}
			</header>
			{visual.length ? (
				<>
					<Section id="properties.transform" title="Transform">
						{rows(
							[
								'transform.position',
								'transform.scale',
								...(nonUniform ? ['transform.scaleWidth'] : []),
								'transform.uniformScale',
								'transform.rotation',
								'transform.anchor',
								'opacity',
							],
							visual,
						).map((r) => render(r))}
					</Section>
					{/* wp captions: captions have no effects (no Crop) and no blend mode */}
					{visual.some((c) => c.kind === 'captions') ? null : (
						<Section id="properties.crop" title="Crop" defaultOpen={false}>
							{CROP_PARAMS.map((p) =>
								render(
									makeRow(
										`crop.${p}`,
										visual.map((c) => bindCrop(doc, seq, c, p, frame)),
									),
								),
							)}
						</Section>
					)}
					{visual.some((c) => c.kind === 'captions') ? null : (
						<Section id="properties.blend" title="Blend Mode">
							{rows(['blendMode'], visual).map((r) => render(r))}
						</Section>
					)}
					{all3d ? (
						<Section id="properties.threeD" title="3D Layer">
							{rows(
								[
									'threeD.positionZ',
									'threeD.scaleZ',
									'threeD.orientation',
									'threeD.rotationX',
									'threeD.rotationY',
									'threeD.anchorZ',
									'threeD.autoOrient',
								],
								visual,
							).map((r) => render(r))}
						</Section>
					) : null}
					{all3d ? (
						<Section id="properties.material" title="Material Options" defaultOpen={false}>
							{rows(
								[
									'threeD.material.castsShadows',
									'threeD.material.lightTransmission',
									'threeD.material.acceptsShadows',
									'threeD.material.acceptsLights',
									'threeD.material.ambient',
									'threeD.material.diffuse',
									'threeD.material.specularIntensity',
									'threeD.material.specularShininess',
									'threeD.material.metal',
								],
								visual,
							).map((r) => render(r))}
						</Section>
					) : null}
					<SpeedSection clips={visual} seq={seq} />
					{allKind('text') ? (
						<TextSections session={session} visual={visual} ctx={ctx} rows={rows} render={render} />
					) : null}
					{allKind('solid') ? (
						<Section id="properties.solid" title="Color Matte">
							{rows(['solid.color'], visual).map((r) => render(r))}
						</Section>
					) : null}
					{allKind('motion-graphic') ? <TemplateSection visual={visual} ctx={ctx} session={session} /> : null}
					{visual.length === 1 ? <EffectsSummary clip={visual[0]!} ctx={ctx} effects={effects} /> : null}
				</>
			) : null}
			{/* M2 sections registered by feature packages (ARCHITECTURE §19.10). */}
			{sections
				.filter((d) => d.appliesTo(clips))
				.map((d) => (
					<Section
						key={d.id}
						id={`properties.ext.${d.id}`}
						title={d.title}
						defaultOpen={d.defaultOpen ?? true}
					>
						<d.component session={session} clips={clips} frame={frame} sequenceId={seq.id} />
					</Section>
				))}
			{cameras.length ? (
				<Section id="properties.camera" title="Camera">
					{rows(
						[
							'camera.type',
							'camera.pointOfInterest',
							'camera.position',
							'camera.orientation',
							'camera.zoom',
							'camera.depthOfField',
							'camera.focusDistance',
							'camera.aperture',
							'camera.blurLevel',
							'camera.irisShape',
						],
						cameras,
					).map((r) => render(r))}
				</Section>
			) : null}
			{lights.length ? (
				<Section id="properties.light" title="Light">
					{rows(
						[
							'light.type',
							'light.position',
							'light.pointOfInterest',
							'light.intensity',
							'light.color',
							'light.coneAngle',
							'light.coneFeather',
							'light.falloff',
							'light.radius',
							'light.falloffDistance',
							'light.castsShadows',
							'light.shadowDarkness',
							'light.shadowDiffusion',
						],
						lights,
					).map((r) => render(r))}
				</Section>
			) : null}
			{audio.length ? (
				<Section id="properties.audio" title="Audio">
					{rows(['gainDb', 'volumeDb', 'pan'], audio).map((r) => render(r))}
					<SpeedRows clips={audio} seq={seq} />
				</Section>
			) : null}
			{other.length ? (
				<p className="px-2 py-1 text-pr-small text-pr-muted">
					{other.length} clip{other.length > 1 ? 's' : ''} of an unsupported kind (
					{[...new Set(other.map((c) => c.kind))].join(', ')}) — preserved, not editable here.
				</p>
			) : null}
		</div>
	);
}

function SpeedRows({ clips, seq }: { clips: Clip[]; seq: Sequence }) {
	const rates = [...new Set(clips.map((c) => (c.speed.reverse ? -1 : 1) * c.speed.rate))];
	const durations = [...new Set(clips.map((c) => c.duration))];
	const row = 'flex min-h-[var(--pr-row-h)] items-center gap-2 pl-2 pr-1';
	return (
		<>
			<div className={row}>
				<span className="w-[34%] shrink-0 text-pr-ui text-pr-muted">Speed</span>
				<span className="text-pr-ui text-pr-text" data-testid="speed-readout">
					{rates.length === 1
						? `${Math.round(Math.abs(rates[0]!) * 10000) / 100}%${rates[0]! < 0 ? ' (reversed)' : ''}`
						: '–'}
				</span>
			</div>
			<div className={row}>
				<span className="w-[34%] shrink-0 text-pr-ui text-pr-muted">Duration</span>
				{durations.length === 1 ? (
					<TimecodeText
						tone="primary"
						value={formatTimecode(durations[0]!, seq.settings.frameRate, {
							dropFrame: seq.settings.dropFrame,
						})}
					/>
				) : (
					<span className="text-pr-ui text-pr-text">–</span>
				)}
			</div>
		</>
	);
}

function SpeedSection({ clips, seq }: { clips: Clip[]; seq: Sequence }) {
	const media = clips.filter((c) => isKnownClipKind(c.kind) && kindCapabilities(c.kind)?.supportsSpeed);
	if (!media.length) return null;
	return (
		<Section id="properties.speed" title="Speed & Duration" defaultOpen={false}>
			<SpeedRows clips={media} seq={seq} />
			<p className="px-2 text-pr-small text-pr-dim">Change speed with the Rate Stretch tool.</p>
		</Section>
	);
}

type FontOption = { id: string; label: string; disabled?: boolean };

/** Font families: the project's fonts plus the engine catalog (/api/fonts) for reference. */
function useFontOptions(session: EditorSession, docFonts: Record<string, { id: string; family: string }>) {
	const [catalog, setCatalog] = useState<string[]>([]);
	useEffect(() => {
		let cancelled = false;
		session.engine
			?.listFonts()
			.then((r) => !cancelled && setCatalog(r.fonts.map((f) => f.family)))
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [session]);
	const inDoc = Object.values(docFonts);
	const known = new Set(inDoc.map((f) => f.family));
	const options: FontOption[] = [
		...inDoc.map((f) => ({ id: f.id, label: f.family })),
		// a bundled family not in the project yet is registered when picked (font.add).
		...catalog.filter((f) => !known.has(f)).map((f) => ({ id: `catalog:${f}`, label: f })),
	];
	return options;
}

function TextSections(props: {
	session: EditorSession;
	visual: Clip[];
	ctx: RowContext;
	rows(keys: string[], list: Clip[]): Row[];
	render(r: Row | null, extra?: Partial<Parameters<typeof PropertyRow>[0]>): ReactNode;
}) {
	const { visual, ctx, rows, render, session } = props;
	const fonts = useFontOptions(session, ctx.doc.fonts);
	const get = (k: string) => rows([k], visual)[0] ?? null;
	const content = get('text.content');
	const fontRow = get('text.fontId');
	const weightRow = get('text.weight');
	const rest = rows(
		[
			'text.italic',
			'text.sizePx',
			'text.align',
			'text.fill',
			'text.strokeWidth',
			'text.strokeColor',
			'text.trackingEm',
			'text.lineHeight',
			'text.allCaps',
		],
		visual,
	);
	const setRow = (row: Row, v: unknown) => {
		// picking a catalog family registers it and sets it on the selected clips in one step.
		if (row.spec.key === 'text.fontId' && typeof v === 'string' && v.startsWith('catalog:')) {
			ctx.ops.apply('Font', [
				{ type: 'font.add', family: v.slice(8), ref: '$font' } as Command,
				...row.bindings.map(
					(b) =>
						({
							type: 'clip.update',
							clipIds: [b.clip.id],
							patch: { content: { style: { fontId: '$font' } } },
						}) as Command,
				),
			]);
			return;
		}
		const plan = planSet(row, ctx.frame, () => v);
		ctx.ops.apply(row.label, plan.commands as Command[]);
	};
	return (
		<>
			<Section id="properties.text" title="Text">
				{render(content ?? null)}
				{fontRow
					? render(fontRow, {
							editor: (
								<select
									aria-label="Font"
									className="h-[20px] min-w-0 flex-1 rounded-pr-control bg-pr-field px-1 font-pr text-pr-ui text-pr-text"
									value={rowValue(fontRow).mixed ? '' : String(rowValue(fontRow).value)}
									onChange={(e) => e.target.value && setRow(fontRow, e.target.value)}
									data-testid="prop-text.fontId"
								>
									{rowValue(fontRow).mixed ? <option value="">–</option> : null}
									{fonts.map((f) => (
										<option key={f.id} value={f.id} disabled={f.disabled}>
											{f.label}
										</option>
									))}
								</select>
							),
						})
					: null}
				{weightRow
					? render(weightRow, {
							editor: (
								<SelectField
									value={rowValue(weightRow).mixed ? null : (rowValue(weightRow).value as number)}
									options={WEIGHTS}
									label="Weight"
									onChange={(v) => setRow(weightRow, v)}
								/>
							),
						})
					: null}
				{rest.map((r) => render(r))}
			</Section>
			<Section id="properties.textBox" title="Box" defaultOpen={false}>
				{rows(
					[
						'text.backgroundColor',
						'text.backgroundPadding',
						'text.backgroundRadius',
						'text.boxWidth',
						'text.boxHeight',
						'text.autoSize',
					],
					visual,
				).map((r) => render(r))}
			</Section>
			{/* text-animators: AE's Character panel (kerning, baseline shift, tsume, faux styles, caps, scripts,
			    ligatures and OpenType features, variable font axes). */}
			<Section id="properties.textCharacter" title="Character" defaultOpen={false}>
				{rows(
					[
						'text.kerning',
						'text.kerningAmount',
						'text.baselineShiftPx',
						'text.tsume',
						'text.fauxBold',
						'text.fauxItalic',
						'text.smallCaps',
						'text.script',
						'text.ligatures',
						'text.discretionaryLigatures',
						'text.contextualAlternates',
						'text.stylisticAlternates',
						'text.swash',
						'text.titling',
						'text.ordinals',
						'text.fractions',
						'text.allSmallCaps',
						'text.figureStyle',
						'text.figureWidth',
						'text.stylisticSets',
						'text.fontVariations',
					],
					visual,
				).map((r) => render(r))}
			</Section>
			{/* text-animators: AE's Paragraph panel (justification, indents, paragraph spacing). */}
			<Section id="properties.textParagraph" title="Paragraph" defaultOpen={false}>
				{rows(
					[
						'text.justifyLast',
						'text.indentLeftPx',
						'text.indentRightPx',
						'text.indentFirstLinePx',
						'text.spaceBeforePx',
						'text.spaceAfterPx',
					],
					visual,
				).map((r) => render(r))}
			</Section>
		</>
	);
}

/** Motion-graphic parameters: an auto-generated form from the template schema (S05:ECP-008, PRP-001). */
function TemplateSection(props: { visual: Clip[]; ctx: RowContext; session: EditorSession }) {
	const { visual, ctx, session } = props;
	const controls = useRegistry(templateParamControls);
	const mg = session.ctx.registries.mgTemplates;
	const tpl = templateOf(visual[0]!, mg);
	const same = visual.every(
		(c) => c.kind === 'motion-graphic' && c.template.id === tpl?.id && c.template.version === tpl?.version,
	);
	if (!tpl || !same) {
		return (
			<Section id="properties.template" title="Parameters">
				<p className="px-2 text-pr-small text-pr-muted">
					{tpl ? 'Different templates selected.' : 'Template not available in this app version.'}
				</p>
			</Section>
		);
	}
	// C3: the template's ui hints — params that apply to none of the selected clips are hidden (`visibleWhen`), the
	// others are grouped in its sections (in order; params in no group first).
	const shown = paramsPropertySpecs(tpl).filter((s) =>
		visual.some((c) => templateParamVisible(s, (c as { params?: Record<string, unknown> }).params)),
	);
	// WP7a: rows edited by another row's custom control (`alsoEdits`, e.g. the time unit) are not drawn twice.
	const absorbed = absorbedTemplateParams(shown, controls);
	const specs = shown.filter((s) => !absorbed.has(s.key.slice('params.'.length)));
	const renderSpec = (s: PropertySpec, indent: boolean) => {
		const row = makeRow(
			s.key,
			visual.map((c) => bindProperty(ctx.doc, ctx.seq, c, s.key, ctx.frame, mg)),
		);
		return row ? <PropertyRow key={row.id} row={row} ctx={ctx} indent={indent} /> : null;
	};
	return (
		<Section id="properties.template" title={`Parameters · ${tpl.name}`}>
			<p className="px-2 pb-1 text-pr-small text-pr-muted">
				{tpl.id}@{tpl.version} · {tpl.category}
			</p>
			{templateParamSections(specs).map((sec) =>
				sec.section ? (
					<Section
						key={sec.section.id}
						id={`properties.template.${tpl.id}.${sec.section.id}`}
						title={sec.section.label}
						variant="group"
						className="pl-2"
						actions={
							<TemplateGroupActions ctx={ctx} clips={visual} specs={sec.specs} label={sec.section.label} />
						}
					>
						<div data-template-group={sec.section.id}>{sec.specs.map((s) => renderSpec(s, true))}</div>
					</Section>
				) : (
					sec.specs.map((s) => renderSpec(s, false))
				),
			)}
		</Section>
	);
}

/** Applied effects summary with fx toggles (S03:INS-002 "Effects"); edit params in Effect Controls. */
function EffectsSummary(props: {
	clip: Clip;
	ctx: RowContext;
	effects: { get(id: string, v?: number): { label: string } | undefined };
}) {
	const list = (props.clip as { effects?: EffectInstance[] }).effects ?? [];
	if (!list.length) return null;
	const apply = (label: string, cmd: Command) => props.ctx.ops.apply(label, [cmd]);
	return (
		<Section id="properties.effects" title={`Effects (${list.length})`}>
			{list.map((fx) => {
				const spec = props.effects.get(fx.effectId, fx.effectVersion);
				return (
					<div key={fx.id} className="flex h-[var(--pr-row-h)] items-center gap-1 pr-1 pl-2">
						<MiniButton
							label={
								fx.enabled ? `Bypass ${spec?.label ?? fx.effectId}` : `Enable ${spec?.label ?? fx.effectId}`
							}
							active={fx.enabled}
							onClick={() =>
								apply('Toggle Effect', {
									type: 'effect.setEnabled',
									effectInstanceId: fx.id,
									enabled: !fx.enabled,
								} as Command)
							}
						>
							<FxGlyph size={13} off={!fx.enabled} />
						</MiniButton>
						<span className={cx('flex-1 truncate text-pr-ui', fx.enabled ? 'text-pr-text' : 'text-pr-dim')}>
							{spec ? spec.label : `Missing effect: ${fx.effectId}`}
						</span>
						<MiniButton
							label={`Remove ${spec?.label ?? fx.effectId}`}
							onClick={() =>
								apply('Remove Effect', { type: 'effect.remove', effectInstanceId: fx.id } as Command)
							}
						>
							<TrashGlyph size={12} />
						</MiniButton>
					</div>
				);
			})}
		</Section>
	);
}
