// Sequence ▸ Automate ▸ Decorate Cuts… / Punch-ins… / Ken Burns… / Reactions… / Slide Overlays… / Music Bed… /
// Stingers… (spec 15 EA-020…EA-026, EA-040; the overlay passes' fields are in OverlayFields.tsx): the pass's
// parameters with their defaults (the measured values; `initialParams` = a style recipe's), a dry-run summary that
// follows every change (how many cuts / clips get a decoration, coverage, why the others are left out, kit families,
// the export cost and the sounds it will use), and Propose: the engine's `edit-automation` job stores a proposal and
// review opens on it — nothing changes until the user applies it in review.
import type { AutomationPassId, AutomationPassResult } from '@jasper/api';
import {
	builtinKitPack,
	type KitPack,
	repeatProbability,
	type Sequence,
	sequenceDuration,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	ScrubbyNumber,
	Select,
	Slider,
} from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToastRequest } from '../commands/types.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { t, translateName } from '../i18n/runtime.ts';
import {
	bool,
	NumberRow,
	num,
	type Params,
	pct,
	Row,
	SfxFields,
	ShareSlider,
	str,
	trackOptions,
} from './fields.tsx';
import { guessBin, MusicFields, ReactionFields, SlideFields, StingerFields } from './OverlayFields.tsx';
import {
	type AutomationEngine,
	AutomationRunError,
	dryRunPass,
	proposePass,
	reviewPassResult,
} from './run.ts';
import { rememberPassParams } from './style-store.ts';

export const AUTOMATION_DIALOG = 'automation.pass';

let registered = false;
export function registerAutomationDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(AUTOMATION_DIALOG, AutomationDialog);
}

export const AUTOMATION_PASS_TITLES: Record<AutomationPassId, string> = {
	'decorate-cuts': 'Decorate Cuts',
	'punch-ins': 'Punch-ins',
	'ken-burns': 'Ken Burns',
	reactions: 'Reactions',
	slides: 'Slide Overlays',
	music: 'Music Bed',
	stingers: 'Stingers',
};

/** Passes that need the user's files (a bin or folder) before anything can be counted. */
const ASSET_PASSES: ReadonlySet<AutomationPassId> = new Set(['reactions', 'music']);

const PASS_INTRO_TEXT: Record<AutomationPassId, string> = {
	'decorate-cuts':
		'Puts a cut kit on every picture cut: an adjustment clip centred on the cut on an FX track above the picture, and a whoosh of the same length with its peak on the cut.',
	'punch-ins':
		'Zooms into the A-roll clips: from the clip midpoint, a short linear ramp to a larger scale, held to the cut. "!" and "?" phrases come first.',
	'ken-burns': 'Gives some of the remaining A-roll clips a slow zoom in or out over the whole clip.',
	reactions:
		'Puts your reaction pictures over the picture at markers, calls to action and exclamations (and where no face is seen): on a cut close by, at a slot, with a wobble.',
	slides:
		'Slides overlay pictures in at their heads and out at their tails with one-sided Smooth Slide transitions where nothing else touches the edge.',
	music:
		'Lays your songs end to end on a Music track, quiet under the voice, switching to the next song on a cut.',
	stingers:
		'Adds a short burst of generated TV static, picture and sound, after shouted punchlines. Review each one: this pass only suggests.',
};

/** Why a cut or clip got nothing (the planners' skip codes). */
export const SKIP_LABELS: Record<string, string> = {
	transition: 'Has a transition',
	decorated: 'Already decorated',
	spacing: 'Too close (spacing)',
	coverage: 'Left out (coverage)',
	'too-close': 'Too close to the previous kit',
	edge: 'At the start or end of the sequence',
	'track-busy': 'FX track busy',
	'no-family': 'No kit fits',
	short: 'Shorter than the minimum',
	motion: 'Motion already keyed',
	effect: 'An effect moves the picture',
	excluded: 'Left to another pass',
	reframed: 'Reframed (its own scale or position)',
	density: 'Left out (density)',
	share: 'Left out (share)',
	kind: 'Not a picture clip',
	overlap: 'Another reaction is on screen',
	rate: 'Over the rate per minute',
	subtitles: 'Subtitles cover every slot',
	locked: 'Track locked',
	'not-free': 'Another clip or transition touches it',
};

const DETAIL_LABELS: Record<string, string> = {
	marker: 'Markers',
	cta: 'Calls to action',
	exclamation: 'Exclamations',
	hidden: 'Speaker not visible',
	onCut: 'On a cut',
	overlays: 'Overlays',
	heads: 'Heads',
	tails: 'Tails',
	down: 'Down',
	up: 'Up',
	left: 'Left',
	right: 'Right',
	switches: 'Switches',
	intro: 'Intro step',
	ducked: 'Ducked beds',
	both: 'Loud and “!”',
	loudness: 'Loud',
};

export type RangeChoice = 'sequence' | 'inout';
const name = (s: string) => translateName(s) ?? s;

export function SeedRow(p: { value: number; onChange(v: number): void }) {
	return (
		<Row label={t('Seed')} testId="automation-seed">
			<ScrubbyNumber
				label={t('Seed')}
				value={p.value}
				min={0}
				max={2 ** 31 - 1}
				precision={0}
				onCommit={p.onChange}
				onScrubEnd={(v) => p.onChange(v)}
			/>
			<Button
				variant="quiet"
				onClick={() => p.onChange(Math.floor(Math.random() * 2 ** 31))}
				data-testid="automation-new-seed"
			>
				⟳ {t('New draw')}
			</Button>
		</Row>
	);
}

function DecorateFields(p: { seq: Sequence; params: Params; set(k: string, v: unknown): void }) {
	const vertical = p.seq.settings.height > p.seq.settings.width;
	const packId = typeof p.params.pack === 'string' ? p.params.pack : 'auto';
	const pack: KitPack = builtinKitPack(
		packId === 'auto' ? (vertical ? 'shorts-shake' : 'long-pack') : packId,
	)!;
	const fam = (p.params.families ?? {}) as Record<string, number>;
	const shares = pack.families.map((f) => fam[f.id] ?? f.weight);
	const total = shares.reduce((a, b) => a + b, 0) || 1;
	const penalty = num(p.params.repeatPenalty, pack.repeatPenalty);
	return (
		<>
			<Row label={t('Kit pack')} testId="automation-pack">
				<Select
					label={t('Kit pack')}
					value={packId}
					onValueChange={(v) => {
						p.set('pack', v === 'auto' ? undefined : v);
						p.set('families', undefined);
						p.set('repeatPenalty', undefined);
					}}
					options={[
						{
							value: 'auto',
							label: t(
								'Automatic: {0}',
								name(builtinKitPack(vertical ? 'shorts-shake' : 'long-pack')!.label),
							),
						},
						{ value: 'shorts-shake', label: name('Shorts shake') },
						{ value: 'long-pack', label: name('Long-form transition pack') },
					]}
				/>
			</Row>
			{pack.families.length > 1 ? (
				<fieldset className="flex flex-col gap-1" data-testid="automation-families">
					<legend className="mb-1 text-pr-muted">{t('Kit families')}</legend>
					{pack.families.map((f, i) => (
						<Row key={f.id} label={name(f.label)} testId={`automation-family-${f.id}`}>
							<Slider
								className="min-w-0 flex-1"
								label={name(f.label)}
								valueText={pct(shares[i]! / total)}
								value={Math.round((shares[i]! / total) * 100)}
								min={0}
								max={100}
								step={1}
								defaultValue={Math.round((f.weight / pack.families.reduce((a, x) => a + x.weight, 0)) * 100)}
								onChange={(v) => {
									// shares in % of the pack: the others keep their weights
									const next: Record<string, number> = {};
									pack.families.forEach((g, j) => {
										next[g.id] = j === i ? v : Math.round((shares[j]! / total) * 100);
									});
									p.set('families', next);
								}}
							/>
							<span className="w-[48px] shrink-0 text-right text-pr-small pr-tabular">
								{pct(shares[i]! / total)}
							</span>
						</Row>
					))}
					<Row label={t('Fewer repeats')} testId="automation-repeat">
						<Slider
							className="min-w-0 flex-1"
							label={t('Repeat penalty')}
							valueText={t('Same family as the previous kit: {0}', pct(repeatProbability(shares, penalty)))}
							value={Math.round((1 - penalty) * 100)}
							min={0}
							max={100}
							step={1}
							defaultValue={Math.round((1 - pack.repeatPenalty) * 100)}
							onChange={(v) => p.set('repeatPenalty', 1 - v / 100)}
						/>
						<span className="shrink-0 text-right text-pr-small text-pr-muted pr-tabular">
							{t('{0} same as previous', pct(repeatProbability(shares, penalty)))}
						</span>
					</Row>
				</fieldset>
			) : null}
			<Row label={t('Cuts on')} testId="automation-track">
				<Select
					label={t('Cuts on')}
					value={str(p.params.track, 'auto')}
					onValueChange={(v) => p.set('track', v === 'auto' ? undefined : v)}
					options={trackOptions(p.seq, t('Every picture cut'))}
				/>
			</Row>
			<ShareSlider
				label={t('Coverage')}
				value={num(p.params.coverage, 1)}
				defaultValue={1}
				onChange={(v) => p.set('coverage', v === 1 ? undefined : v)}
				testId="automation-coverage"
			/>
			<NumberRow
				label={t('Minimum spacing')}
				unit={t('frames')}
				value={num(p.params.minSpacingFrames, 0)}
				min={0}
				max={100_000}
				onCommit={(v) => p.set('minSpacingFrames', v || undefined)}
				testId="automation-spacing"
			/>
			<div className="flex flex-col gap-1 pl-[140px]">
				<Checkbox
					checked={bool(p.params.includeJumpCuts, true)}
					onCheckedChange={(c) => p.set('includeJumpCuts', c ? undefined : false)}
					label={t('Jump cuts')}
				/>
				<Checkbox
					checked={bool(p.params.includeInsertEdges, false)}
					onCheckedChange={(c) => p.set('includeInsertEdges', c || undefined)}
					label={t('Where B-roll inserts enter and leave')}
				/>
				<Checkbox
					checked={bool(p.params.skipDecorated, true)}
					onCheckedChange={(c) => p.set('skipDecorated', c ? undefined : false)}
					label={t('Skip cuts that already have an adjustment clip')}
				/>
			</div>
			<SfxFields
				value={p.params.sfx as Params | undefined}
				label={t('A whoosh as long as the kit, its peak on the cut')}
				onChange={(v) => p.set('sfx', Object.keys(v).length ? v : undefined)}
			/>
		</>
	);
}

function PunchFields(p: { seq: Sequence; params: Params; set(k: string, v: unknown): void }) {
	const target = p.params.target;
	const targetKind =
		target === 'subject' ? 'subject' : target && typeof target === 'object' ? 'point' : 'center';
	const pt = (target && typeof target === 'object' ? target : { x: 0.5, y: 0.5 }) as { x: number; y: number };
	return (
		<>
			<Row label={t('A-roll track')} testId="automation-track">
				<Select
					label={t('A-roll track')}
					value={str(p.params.track, 'auto')}
					onValueChange={(v) => p.set('track', v === 'auto' ? undefined : v)}
					options={trackOptions(p.seq, t('Automatic (most picture)'))}
				/>
			</Row>
			<ShareSlider
				label={t('Density')}
				value={num(p.params.density, 0.7)}
				defaultValue={0.7}
				onChange={(v) => p.set('density', v)}
				testId="automation-density"
			/>
			<NumberRow
				label={t('Shortest clip')}
				unit="s"
				precision={1}
				value={num(p.params.minClipSeconds, 1.5)}
				min={0}
				max={600}
				onCommit={(v) => p.set('minClipSeconds', v)}
				testId="automation-min-clip"
			/>
			<NumberRow
				label={t('Zoom to')}
				unit="%"
				value={num(p.params.scale, 180)}
				min={101}
				max={1000}
				onCommit={(v) => p.set('scale', v)}
				testId="automation-scale"
			/>
			<NumberRow
				label={t('Ramp')}
				unit={t('frames')}
				value={num(p.params.rampFrames, 7)}
				min={1}
				max={600}
				onCommit={(v) => p.set('rampFrames', v)}
				testId="automation-ramp"
			/>
			<Row label={t('Starts at')} testId="automation-start">
				<Select
					label={t('Starts at')}
					value={str(p.params.start, 'midpoint')}
					onValueChange={(v) => p.set('start', v === 'midpoint' ? undefined : v)}
					options={[
						{ value: 'midpoint', label: t('The clip midpoint') },
						{ value: 'word', label: t('The word start nearest the midpoint') },
						{ value: 'caption', label: t('A subtitle start, as you place them') },
					]}
				/>
			</Row>
			<Row label={t('Zooms toward')} testId="automation-target">
				<Select
					label={t('Zooms toward')}
					value={targetKind}
					onValueChange={(v) =>
						p.set('target', v === 'center' ? undefined : v === 'subject' ? 'subject' : { x: pt.x, y: pt.y })
					}
					options={[
						{ value: 'center', label: t('The centre of the frame') },
						{ value: 'subject', label: t('The subject (face tracking or saliency)') },
						{ value: 'point', label: t('A point') },
					]}
				/>
			</Row>
			{targetKind === 'point' ? (
				<>
					<ShareSlider
						label={t('Point x')}
						value={pt.x}
						defaultValue={0.5}
						onChange={(x) => p.set('target', { x, y: pt.y })}
					/>
					<ShareSlider
						label={t('Point y')}
						value={pt.y}
						defaultValue={0.5}
						onChange={(y) => p.set('target', { x: pt.x, y })}
					/>
				</>
			) : null}
			<Row label={t('Made with')} testId="automation-method">
				<Select
					label={t('Made with')}
					value={str(p.params.method, 'motion')}
					onValueChange={(v) => p.set('method', v === 'motion' ? undefined : v)}
					options={[
						{ value: 'motion', label: t('Motion keyframes on the clip (native export)') },
						{ value: 'adjustment', label: t('A Transform adjustment clip (affects everything below)') },
					]}
				/>
			</Row>
			<div className="flex flex-col gap-1 pl-[140px]">
				<Checkbox
					checked={bool(p.params.skipReframed, true)}
					onCheckedChange={(c) => p.set('skipReframed', c ? undefined : false)}
					label={t('Skip clips reframed with their own scale or position')}
				/>
			</div>
			<SfxFields
				value={p.params.sfx as Params | undefined}
				label={t('A whoosh when the zoom starts')}
				onChange={(v) => p.set('sfx', Object.keys(v).length ? v : undefined)}
			/>
		</>
	);
}

function KenBurnsFields(p: { seq: Sequence; params: Params; set(k: string, v: unknown): void }) {
	const vertical = p.seq.settings.height > p.seq.settings.width;
	const auto = vertical ? 118 : 130;
	return (
		<>
			<Row label={t('A-roll track')} testId="automation-track">
				<Select
					label={t('A-roll track')}
					value={str(p.params.track, 'auto')}
					onValueChange={(v) => p.set('track', v === 'auto' ? undefined : v)}
					options={trackOptions(p.seq, t('Automatic (most picture)'))}
				/>
			</Row>
			<ShareSlider
				label={t('Share of the clips')}
				value={num(p.params.share, 0.15)}
				defaultValue={0.15}
				onChange={(v) => p.set('share', v)}
				testId="automation-share"
			/>
			<NumberRow
				label={t('Zoom to')}
				unit="%"
				value={num(p.params.scale, auto)}
				min={101}
				max={400}
				onCommit={(v) => p.set('scale', v === auto ? undefined : v)}
				testId="automation-scale"
			/>
			<NumberRow
				label={t('Zoom-ins per zoom-out')}
				precision={1}
				value={num(p.params.inOutRatio, 2)}
				min={0}
				max={100}
				onCommit={(v) => p.set('inOutRatio', v)}
				testId="automation-ratio"
			/>
			<NumberRow
				label={t('Shortest clip')}
				unit="s"
				precision={1}
				value={num(p.params.minClipSeconds, 1)}
				min={0}
				max={600}
				onCommit={(v) => p.set('minClipSeconds', v)}
				testId="automation-min-clip"
			/>
		</>
	);
}

/** The dry run, in words: counts, coverage, skips, families, export cost, sounds, budget. */
export function DryRunSummary(p: { result: AutomationPassResult }) {
	const r = p.result;
	const s = r.summary;
	const noun =
		r.pass === 'decorate-cuts'
			? t('{0} of {1} cuts get a kit ({2})', s.count, s.considered, pct(s.coverage))
			: r.pass === 'punch-ins'
				? t('{0} of {1} candidate clips get a punch-in ({2})', s.count, s.considered, pct(s.coverage))
				: r.pass === 'ken-burns'
					? t('{0} of {1} candidate clips get a Ken Burns move ({2})', s.count, s.considered, pct(s.coverage))
					: r.pass === 'reactions'
						? t('{0} of {1} triggers get a reaction', s.count, s.considered)
						: r.pass === 'slides'
							? t('{0} of {1} overlay edges get a slide', s.count, s.considered)
							: r.pass === 'music'
								? t('{0} beds from {1} songs', s.count, s.considered)
								: t('{0} of {1} punchlines get a stinger', s.count, s.considered);
	const detail = Object.entries(s.detail ?? {}).filter(([, n]) => n > 0);
	const skips = Object.entries(s.skipped.byCode).sort((a, b) => b[1] - a[1]);
	return (
		<div className="flex flex-col gap-1 text-pr-small" data-testid="automation-summary">
			<span className="text-pr-text" data-testid="automation-summary-count">
				{noun}
			</span>
			{s.families && Object.keys(s.families).length > 1 ? (
				<span className="text-pr-muted" data-testid="automation-summary-families">
					{Object.entries(s.families)
						.map(([id, n]) => {
							const label = builtinKitPack('long-pack')?.families.find((f) => f.id === id)?.label ?? id;
							return `${name(label)} ${n}`;
						})
						.join(' · ')}
				</span>
			) : null}
			{detail.length ? (
				<span className="text-pr-muted" data-testid="automation-summary-detail">
					{detail.map(([k, n]) => `${DETAIL_LABELS[k] ?? k} ${n}`).join(' · ')}
				</span>
			) : null}
			{s.assets ? (
				<span className="text-pr-muted" data-testid="automation-summary-assets">
					{s.assets.count === 0
						? t('No usable files in the chosen source')
						: t('{0} files: {1}', s.assets.count, s.assets.names.slice(0, 6).join(', '))}
				</span>
			) : null}
			{skips.length ? (
				<span className="text-pr-muted" data-testid="automation-summary-skipped">
					{t('Left out: {0}', skips.map(([code, n]) => `${SKIP_LABELS[code] ?? code} ${n}`).join(' · '))}
				</span>
			) : null}
			<span className="text-pr-muted" data-testid="automation-summary-cost">
				{s.cost.class === 'native'
					? r.pass === 'punch-ins' || r.pass === 'ken-burns'
						? t('Export: native (Motion keyframes)')
						: t('Export: native')
					: s.cost.class === 'hybrid'
						? t(
								'Export: native, with these layers or spans rendered by Remotion ({0})',
								s.cost.effects.join(', '),
							)
						: t('Export: rendered through the Remotion path ({0})', s.cost.effects.join(', '))}
			</span>
			{s.track ? (
				<span className="text-pr-muted">
					{s.track.startsWith('new track ')
						? t('On a new track {0}', s.track.slice('new track '.length))
						: t('On track {0}', s.track)}
				</span>
			) : null}
			{r.sfx ? (
				<span className="text-pr-muted" data-testid="automation-summary-sfx">
					{r.sfx.available === 0
						? t('No {0} sounds in the chosen sources: the decorations get no sound', r.sfx.type)
						: t('{0} sounds: {1} placed from {2} available', r.sfx.type, r.sfx.placed, r.sfx.available)}
				</span>
			) : null}
			{!r.budget.fits ? (
				<span className="text-pr-warning" data-testid="automation-summary-budget">
					{r.budget.suggestedRange
						? t(
								'Too big for one proposal: choose In to Out up to frame {0}, then the rest',
								r.budget.suggestedRange.end,
							)
						: t('Too big for one proposal: choose a shorter range')}
				</span>
			) : null}
			{r.warnings.map((w) => (
				<span key={w.code + w.message} className="text-pr-warning" data-automation-warning={w.code}>
					! {w.message}
				</span>
			))}
		</div>
	);
}

export type AutomationDialogProps = {
	session: EditorSession;
	engine: AutomationEngine;
	sequenceId: string;
	pass: AutomationPassId;
	/** Starting values (a style recipe's), over the defaults. */
	initialParams?: Params;
	toast?: (r: ToastRequest) => void;
	onReview?: () => void;
};

/** The pass parameters of the dialog's state (range from the choice; undefined values dropped). */
export function dialogParams(seq: Sequence, params: Params, range: RangeChoice): Params {
	const out: Params = {};
	for (const [k, v] of Object.entries(params)) if (v !== undefined && k !== 'range') out[k] = v;
	if (range === 'inout') {
		// the Sequence's In to Out, as the other range pickers read it (Out exclusive)
		const total = sequenceDuration(seq);
		const start = Math.max(0, seq.inPoint ?? 0);
		const end = Math.min(total, seq.outPoint ?? total);
		if (end > start) out.range = { start, end };
	}
	return out;
}

export function AutomationDialog(props: HostedDialogProps<AutomationDialogProps>) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId, engine, pass } = props;
	const seq = session.getCommitted().sequences[sequenceId];
	const [params, setParams] = useState<Params>(() => {
		const init: Params = { seed: 1, ...(props.initialParams ?? {}) };
		// the reaction pictures / songs: a bin named for them, when the project has one
		if (ASSET_PASSES.has(pass) && !init.assets) {
			const bin = guessBin(session.getCommitted(), pass === 'reactions' ? 'image' : 'audio');
			if (bin) init.assets = { bin };
		}
		return init;
	});
	const hasInOut = !!seq && (seq.inPoint !== null || seq.outPoint !== null);
	const [range, setRange] = useState<RangeChoice>('sequence');
	const [dry, setDry] = useState<AutomationPassResult | null>(null);
	const [dryError, setDryError] = useState<string | null>(null);
	const [running, setRunning] = useState<{ progress: number | null; stage: string } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	const readOnly = session.getState().readOnly;
	const set = (k: string, v: unknown) => setParams((cur) => ({ ...cur, [k]: v }));
	const needsAssets = ASSET_PASSES.has(pass) && !params.assets;
	const request = useMemo(
		() => (seq && !needsAssets ? dialogParams(seq, params, range) : null),
		[seq, params, range, needsAssets],
	);
	const key = JSON.stringify(request);

	// the dry run follows the parameters (debounced; a newer one supersedes an older one)
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the request's identity
	useEffect(() => {
		if (!request) return;
		const ac = new AbortController();
		const timer = setTimeout(() => {
			dryRunPass(engine, session.projectId, pass, sequenceId, request, ac.signal).then(
				(r) => {
					if (ac.signal.aborted) return;
					setDry(r);
					setDryError(null);
				},
				(e) => {
					if (ac.signal.aborted) return;
					setDry(null);
					setDryError(e instanceof Error ? e.message : String(e));
				},
			);
		}, 250);
		return () => {
			clearTimeout(timer);
			ac.abort();
		};
	}, [key, engine, pass, sequenceId, session.projectId]);
	useEffect(() => () => abort.current?.abort(), []);

	const propose = async (): Promise<boolean> => {
		if (!request) return false;
		setMessage(null);
		const ac = new AbortController();
		abort.current = ac;
		setRunning({ progress: null, stage: t('Starting…') });
		try {
			const r = await proposePass(engine, session.projectId, pass, sequenceId, request, {
				signal: ac.signal,
				onJob: (j) => setRunning({ progress: j.progress, stage: j.stage ?? j.title }),
			});
			rememberPassParams(session.projectId, pass, request);
			const out = await reviewPassResult(session, r);
			if (!r.proposalId) {
				setRunning(null);
				setMessage(out.message);
				return false;
			}
			props.toast?.({ kind: 'success', message: out.message });
			props.onReview?.();
			return true;
		} catch (e) {
			setRunning(null);
			if (e instanceof AutomationRunError && e.code === 'E_CANCELLED') return false;
			setMessage(
				e instanceof AutomationRunError && e.code === 'PROPOSAL_TOO_LARGE'
					? t('Too big for one proposal: choose In to Out over a part of the sequence, then the rest')
					: e instanceof Error
						? e.message
						: String(e),
			);
			return false;
		} finally {
			abort.current = null;
		}
	};

	const progress = running?.progress != null ? Math.round(running.progress * 100) : null;
	// stingers: the dry run cannot count loudness peaks it has not measured yet (Propose measures them)
	const unmeasured = !!dry?.warnings.some((w) => w.code === 'W_NO_LOUDNESS');
	const nothing = !!dry && dry.summary.count === 0 && !unmeasured;
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					abort.current?.abort();
					finish();
				}
			}}
			onCancel={() => abort.current?.abort()}
			title={AUTOMATION_PASS_TITLES[pass]}
			size="medium"
			primaryLabel={running ? t('Proposing…') : t('Propose')}
			primaryDisabled={readOnly || !seq || needsAssets || !!running || nothing || (!!dry && !dry.budget.fits)}
			onPrimary={propose}
			data-testid={`automation-dialog-${pass}`}
		>
			{seq ? (
				<div className="flex flex-col gap-3 text-pr-ui">
					<p className="text-pr-small text-pr-muted">{PASS_INTRO_TEXT[pass]}</p>
					<p className="text-pr-small text-pr-muted">
						{t('Nothing changes until you apply the proposal in review.')}
					</p>
					<Row label={t('Range')} testId="automation-range">
						<Select
							label={t('Range')}
							value={range}
							onValueChange={(v) => setRange(v as RangeChoice)}
							options={[
								{ value: 'sequence', label: t('Whole sequence') },
								{ value: 'inout', label: t('In to Out'), disabled: !hasInOut },
							]}
						/>
					</Row>
					{pass === 'decorate-cuts' ? (
						<DecorateFields seq={seq} params={params} set={set} />
					) : pass === 'punch-ins' ? (
						<PunchFields seq={seq} params={params} set={set} />
					) : pass === 'ken-burns' ? (
						<KenBurnsFields seq={seq} params={params} set={set} />
					) : pass === 'reactions' ? (
						<ReactionFields seq={seq} doc={session.getCommitted()} params={params} set={set} />
					) : pass === 'slides' ? (
						<SlideFields seq={seq} doc={session.getCommitted()} params={params} set={set} />
					) : pass === 'music' ? (
						<MusicFields seq={seq} doc={session.getCommitted()} params={params} set={set} />
					) : (
						<StingerFields seq={seq} doc={session.getCommitted()} params={params} set={set} />
					)}
					<SeedRow value={num(params.seed, 1)} onChange={(v) => set('seed', v)} />
					<div aria-live="polite" className="flex flex-col gap-1">
						{running ? (
							<span className="text-pr-small text-pr-text" data-testid="automation-progress-text">
								{running.stage}
								{progress !== null ? ` · ${progress} %` : ''}
							</span>
						) : message ? (
							<span className="text-pr-small text-pr-warning" data-testid="automation-message">
								{message}
							</span>
						) : null}
						{needsAssets ? (
							<span className="text-pr-small text-pr-muted" data-testid="automation-needs-assets">
								{pass === 'reactions'
									? t('Choose the bin or folder that holds your reaction pictures')
									: t('Choose the bin or folder that holds your songs')}
							</span>
						) : dry ? (
							<DryRunSummary result={dry} />
						) : dryError ? (
							<span className="text-pr-small text-pr-warning" data-testid="automation-dry-error">
								{dryError}
							</span>
						) : (
							<span className="text-pr-small text-pr-muted">{t('Counting…')}</span>
						)}
					</div>
					{running ? (
						<div
							className="h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
							role="progressbar"
							aria-label={t('Proposing')}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={progress ?? undefined}
							data-testid="automation-progress"
						>
							<div
								className="h-full bg-pr-accent-fill"
								style={{ width: `${progress ?? 100}%`, opacity: progress === null ? 0.5 : 1 }}
							/>
						</div>
					) : null}
				</div>
			) : (
				<p className="text-pr-small text-pr-muted">{t('Open a sequence first')}</p>
			)}
		</Dialog>
	);
}
