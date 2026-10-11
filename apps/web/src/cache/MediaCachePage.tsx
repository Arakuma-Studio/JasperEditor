// Edit ▸ Preferences ▸ Media Cache (M3, S04:CA-013/CA-014, S05 Preferences; Premiere's Media Cache preferences):
// the engine's cache usage per kind (in use / referenced by saved projects / unused), "Clean Unused", "Clean All
// (not in use)…", and the automatic cleaning settings — age limit, total budget, per-kind limits. Engine settings
// have their own Save button (the engine validates them), like Preferences ▸ Processing.
import type {
	CacheGcReport,
	CacheKind,
	CacheKindUsage,
	CacheLocationCheck,
	CacheSettings,
	CacheUsage,
	EngineJob,
} from '@jasper/api';
import { Button, Checkbox, confirmDialog, cx, Select, TextField } from '@jasper/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { errorText, followJob, formatAgo, formatBytes } from '../processing/engine-jobs.ts';
import { getDesktopBridge } from '../runtime/platform.ts';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';

const GB = 1024 ** 3;

type KindForm = { maxGb: string; days: string };
type Form = {
	autoClean: boolean;
	ageOn: boolean;
	days: string;
	budget: 'auto' | 'custom';
	gb: string;
	kinds: Partial<Record<CacheKind, KindForm>>;
	logsDays: string;
	logsMb: string;
};

/** Per-kind "Days": empty = the kind's default, a number, or "never" (kept until cleaned by hand). */
const NEVER = 'never';
const MB = 1024 ** 2;

const num = (n: number) => String(Math.round(n * 100) / 100);

function toForm(s: CacheSettings): Form {
	const kinds: Form['kinds'] = {};
	for (const [k, v] of Object.entries(s.kinds) as [
		CacheKind,
		NonNullable<CacheSettings['kinds'][CacheKind]>,
	][]) {
		kinds[k] = {
			maxGb: v.maxBytes ? num(v.maxBytes / GB) : '',
			days: v.maxAgeDays === undefined ? '' : v.maxAgeDays === null ? NEVER : num(v.maxAgeDays),
		};
	}
	return {
		autoClean: s.autoClean,
		ageOn: s.maxAgeDays !== null,
		days: s.maxAgeDays === null ? '30' : num(s.maxAgeDays),
		budget: s.maxTotalBytes === null ? 'auto' : 'custom',
		gb: s.maxTotalBytes === null ? '' : num(s.maxTotalBytes / GB),
		kinds,
		logsDays: s.logs.maxAgeDays === null ? NEVER : num(s.logs.maxAgeDays),
		logsMb: s.logs.maxBytes === null ? '' : num(s.logs.maxBytes / MB),
	};
}

/** The settings to PUT, or a validation message. */
function fromForm(f: Form, prev: CacheSettings): { settings: CacheSettings } | { error: string } {
	const pos = (v: string) => {
		const n = Number(v.replace(',', '.'));
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	let maxAgeDays: number | null = null;
	if (f.ageOn) {
		maxAgeDays = pos(f.days);
		if (maxAgeDays === null) return { error: 'Enter the number of days (more than 0)' };
	}
	let maxTotalBytes: number | null = null;
	if (f.budget === 'custom') {
		const gb = pos(f.gb);
		if (gb === null) return { error: 'Enter the cache size limit in GB (more than 0)' };
		maxTotalBytes = Math.round(gb * GB);
	}
	const kinds: CacheSettings['kinds'] = {};
	for (const [k, v] of Object.entries(f.kinds) as [CacheKind, KindForm][]) {
		const entry: NonNullable<CacheSettings['kinds'][CacheKind]> = {};
		if (v.maxGb.trim()) {
			const gb = pos(v.maxGb);
			if (gb === null) return { error: 'Size limits are GB values above 0 (empty = no limit)' };
			entry.maxBytes = Math.round(gb * GB);
		}
		const days = v.days.trim().toLowerCase();
		if (days === NEVER) entry.maxAgeDays = null;
		else if (days) {
			const d = pos(days);
			if (d === null) return { error: 'Days are numbers above 0, "never", or empty for the default' };
			entry.maxAgeDays = d;
		}
		if (Object.keys(entry).length) kinds[k] = entry;
	}
	const logsDays = f.logsDays.trim().toLowerCase();
	const logsAge = logsDays === NEVER || logsDays === '' ? null : pos(logsDays);
	if (logsDays && logsDays !== NEVER && logsAge === null)
		return { error: 'Log retention is a number of days above 0 or "never"' };
	const logsMb = f.logsMb.trim() ? pos(f.logsMb) : null;
	if (f.logsMb.trim() && logsMb === null) return { error: 'The log size limit is MB above 0 (empty = none)' };
	return {
		settings: {
			autoClean: f.autoClean,
			maxAgeDays,
			maxTotalBytes,
			kinds,
			logs: { maxAgeDays: logsAge, maxBytes: logsMb === null ? null : Math.round(logsMb * MB) },
			location: prev.location,
		},
	};
}

/** One stacked bar: in use / referenced by saved projects / unused, over the budget. */
function UsageBar({ u }: { u: CacheUsage }) {
	const scale = Math.max(u.totalBytes, u.maxTotalBytes ?? 0, 1);
	const pct = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100))}%`;
	const over = u.maxTotalBytes !== null && u.totalBytes > u.maxTotalBytes;
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-1">
			<div
				className="relative flex h-3 w-full overflow-hidden rounded-pr-control border border-pr-border-subtle bg-pr-field-deep"
				role="img"
				aria-label={`${formatBytes(u.totalBytes)} used`}
				data-testid="cache-bar"
			>
				<div className="h-full bg-pr-accent-fill" style={{ width: pct(u.inUseBytes) }} />
				<div className="h-full bg-pr-icon" style={{ width: pct(u.referencedBytes) }} />
				<div className="h-full bg-pr-dim" style={{ width: pct(u.unusedBytes) }} />
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-pr-small text-pr-muted">
				<Legend className="bg-pr-accent-fill" label="In use" bytes={u.inUseBytes} />
				<Legend className="bg-pr-icon" label="Saved projects" bytes={u.referencedBytes} />
				<Legend className="bg-pr-dim" label="Unused" bytes={u.unusedBytes} />
				{over ? (
					<span className="text-pr-warning" data-testid="cache-over-budget">
						Over the limit: what saved projects use is only removed by Clean All
					</span>
				) : null}
			</div>
		</div>
	);
}

function Legend(props: { className: string; label: string; bytes: number }) {
	return (
		<span className="flex items-center gap-1">
			<span className={cx('inline-block h-2 w-2 rounded-[2px]', props.className)} />
			{props.label} <span className="text-pr-text">{formatBytes(props.bytes)}</span>
		</span>
	);
}

function KindRow(props: {
	k: CacheKindUsage;
	form: KindForm;
	disabled: boolean;
	onChange(next: KindForm): void;
}) {
	const { k } = props;
	const cell = 'px-1.5 py-0.5 text-right tabular-nums';
	const dim = (n: number) => (n > 0 ? formatBytes(n) : <span className="text-pr-dim">—</span>);
	return (
		<tr className="border-t border-pr-border-subtle" data-testid={`cache-kind-${k.kind}`}>
			<td className="max-w-0 truncate px-1.5 py-0.5 text-pr-text" title={k.description}>
				{k.label}
			</td>
			<td className={cell} data-testid={`cache-kind-${k.kind}-entries`}>
				{k.entries}
			</td>
			<td className={cx(cell, 'text-pr-strong')} data-testid={`cache-kind-${k.kind}-bytes`}>
				{dim(k.bytes)}
			</td>
			<td className={cell}>{dim(k.inUseBytes)}</td>
			<td className={cell}>{dim(k.referencedBytes)}</td>
			<td className={cell}>{dim(k.unusedBytes)}</td>
			<td className="px-1 py-0.5">
				<TextField
					aria-label={`${k.label}: size limit in GB`}
					className="h-5 w-16 text-right"
					inputMode="decimal"
					placeholder="none"
					value={props.form.maxGb}
					disabled={props.disabled}
					onChange={(e) => props.onChange({ ...props.form, maxGb: e.target.value })}
					data-testid={`cache-kind-${k.kind}-max`}
				/>
			</td>
			<td className="px-1 py-0.5">
				<TextField
					aria-label={`${k.label}: delete unused files after (days, or "never")`}
					title='Days: empty = default, "never" = keep until cleaned by hand'
					className="h-5 w-14 text-right"
					inputMode="decimal"
					placeholder={k.defaultMaxAgeDays === null ? 'never' : num(k.defaultMaxAgeDays)}
					value={props.form.days}
					disabled={props.disabled}
					onChange={(e) => props.onChange({ ...props.form, days: e.target.value })}
					data-testid={`cache-kind-${k.kind}-days`}
				/>
			</td>
		</tr>
	);
}

function lastGcText(r: CacheGcReport): string {
	const how = r.mode === 'auto' ? 'automatic' : r.mode === 'all' ? 'Clean All' : 'Clean Unused';
	const what = r.removedEntries ? `${formatBytes(r.removedBytes)} removed` : 'nothing to remove';
	return `Last cleaned ${formatAgo(r.at)} (${how}): ${what}`;
}

function reportText(r: CacheGcReport): string {
	const parts = [
		`removed ${r.removedEntries} item${r.removedEntries === 1 ? '' : 's'} (${formatBytes(r.removedBytes)})`,
	];
	if (r.keptInUse) parts.push(`${r.keptInUse} in use kept`);
	if (r.keptReferenced) parts.push(`${r.keptReferenced} used by saved projects kept`);
	if (r.failed) parts.push(`${r.failed} busy, retried later`);
	return parts.join(' · ');
}

/**
 * Change the cache location (S04:CA-021): a folder (typed, or picked on the desktop), checked by the engine (writable,
 * free space, same disk), then moved with the existing cache — or a fresh cache started there — as a `cache-move`
 * job that waits for running jobs and runs alone. Progress is shown here; the engine switches when it succeeds.
 */
function LocationPanel(props: { usage: CacheUsage; onDone(): void; onClose(): void }) {
	const { client } = useEngine();
	const inputId = useId();
	const [path, setPath] = useState('');
	const [mode, setMode] = useState<'move' | 'fresh'>('move');
	const [keepOld, setKeepOld] = useState(false);
	const [check, setCheck] = useState<CacheLocationCheck | null>(null);
	const [job, setJob] = useState<EngineJob | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const desktop = getDesktopBridge();
	const target = (useDefault: boolean) => (useDefault ? null : path.trim());

	const pickFolder = async () => {
		if (!desktop) return;
		setBusy(true);
		setError(null);
		try {
			const selected = await desktop.pickFolder();
			if (selected !== null) {
				setPath(selected);
				setCheck(null);
			}
		} catch (e) {
			setError(`Could not choose a folder: ${errorText(e)}`);
		} finally {
			setBusy(false);
		}
	};

	const runCheck = async (useDefault = false) => {
		const p = target(useDefault);
		if (p === '') return;
		setBusy(true);
		setError(null);
		try {
			setCheck(await client.call('cacheLocationCheck', { body: { path: p } }));
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const start = async (useDefault = false) => {
		const p = target(useDefault);
		if (p === '') return;
		setBusy(true);
		setError(null);
		try {
			const started = (await client.call('cacheLocationSet', {
				body: { path: p, mode, ...(mode === 'fresh' ? { keepOld } : {}) },
			})) as EngineJob;
			setJob(started);
			const end = await followJob(client, started.id, { onUpdate: setJob, intervalMs: 500 });
			if (end.state === 'succeeded') props.onDone();
			else setError(`${end.error?.code ?? end.state}: ${end.error?.message ?? ''}`);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const progress =
		job && !['succeeded', 'failed', 'cancelled'].includes(job.state)
			? `${job.stage ?? job.state}${job.progress != null && job.progress > 0 ? ` · ${Math.round(job.progress * 100)} %` : ''}`
			: null;
	return (
		<div
			className="mt-1 ml-[172px] flex flex-col gap-2 rounded-pr-control border border-pr-border-subtle bg-pr-field-deep p-2"
			data-testid="cache-location-panel"
		>
			<div className="flex items-center gap-2">
				<label htmlFor={inputId} className="shrink-0 text-pr-muted">
					New folder
				</label>
				<TextField
					id={inputId}
					className="min-w-0 flex-1 font-mono"
					placeholder="/Volumes/Fast SSD or D:\\Cache"
					value={path}
					disabled={busy}
					onChange={(e) => {
						setPath(e.target.value);
						setCheck(null);
					}}
					data-testid="cache-location-path"
				/>
				{desktop ? (
					<Button disabled={busy} onClick={() => void pickFolder()}>
						Browse…
					</Button>
				) : null}
				<Button
					disabled={busy || !path.trim()}
					onClick={() => void runCheck()}
					data-testid="cache-location-check"
				>
					Check
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<Select
					label="What to do with the current cache"
					className="w-72"
					value={mode}
					disabled={busy}
					onValueChange={(v) => setMode(v as 'move' | 'fresh')}
					options={[
						{ value: 'move', label: 'Move the existing cache there' },
						{ value: 'fresh', label: 'Start a new, empty cache there' },
					]}
				/>
				{mode === 'fresh' ? (
					<Checkbox
						checked={keepOld}
						disabled={busy}
						onCheckedChange={setKeepOld}
						label="Keep the old files (not deleted)"
						aria-label="Keep the old cache files"
					/>
				) : null}
			</div>
			{check ? (
				<p
					className={cx('text-pr-small', check.ok ? 'text-pr-muted' : 'text-pr-danger')}
					role={check.ok ? 'status' : 'alert'}
					data-testid="cache-location-result"
				>
					{check.ok
						? `${check.path} · ${check.freeBytes !== null ? `${formatBytes(check.freeBytes)} free` : 'free space unknown'} · ${
								mode === 'fresh'
									? 'starts empty'
									: check.sameDevice
										? 'same disk: moved instantly'
										: `copies ${formatBytes(check.requiredBytes)}`
							}`
						: check.message}
				</p>
			) : null}
			{progress ? (
				<p className="text-pr-small text-pr-text" data-testid="cache-location-progress">
					{progress}
				</p>
			) : null}
			{error ? (
				<p className="text-pr-small text-pr-danger" role="alert" data-testid="cache-location-error">
					{error}
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					variant="primary"
					busy={busy && !!job}
					disabled={busy || !path.trim() || (check !== null && !check.ok)}
					onClick={() => void start()}
					data-testid="cache-location-move"
				>
					{mode === 'move' ? 'Move Cache' : 'Use New Folder'}
				</Button>
				{!props.usage.locationIsDefault ? (
					<Button disabled={busy} onClick={() => void start(true)} data-testid="cache-location-default">
						{mode === 'move' ? 'Move Back to Default' : 'Use Default Location'}
					</Button>
				) : null}
				<Button variant="quiet" disabled={busy} onClick={props.onClose}>
					Cancel
				</Button>
				<span className="text-pr-small text-pr-dim">
					Waits for running jobs; nothing else runs while the cache moves.
				</span>
			</div>
		</div>
	);
}

export function MediaCachePreferencesPage() {
	const { client, subscribe } = useEngine();
	const ids = { days: useId(), gb: useId() };
	const [usage, setUsage] = useState<CacheUsage | null>(null);
	const [form, setForm] = useState<Form | null>(null);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState<null | 'load' | 'save' | 'unused' | 'all'>('load');
	const [moving, setMoving] = useState(false);
	const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
	const mounted = useRef(true);
	const dirtyRef = useRef(false);
	dirtyRef.current = dirty;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		try {
			const u = await client.call('cacheUsage');
			if (!mounted.current) return;
			setUsage(u);
			if (!dirtyRef.current) setForm(toForm(u.settings));
		} catch (e) {
			if (mounted.current) setStatus({ kind: 'error', text: `Could not read the cache: ${errorText(e)}` });
		} finally {
			if (mounted.current) setBusy((b) => (b === 'load' ? null : b));
		}
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);
	// Another window, an agent or an automatic pass cleaned: refresh.
	useEffect(() => subscribe((e) => e?.type === 'cache.cleaned' && void load()), [subscribe, load]);

	const patch = (p: Partial<Form>) => {
		setForm((f) => (f ? { ...f, ...p } : f));
		setDirty(true);
		setStatus(null);
	};

	const save = async () => {
		if (!form || !usage) return;
		const built = fromForm(form, usage.settings);
		if ('error' in built) {
			setStatus({ kind: 'error', text: built.error });
			return;
		}
		setBusy('save');
		try {
			const saved = await client.call('cacheSettingsPut', { body: built.settings });
			if (!mounted.current) return;
			setForm(toForm(saved));
			setDirty(false);
			setStatus({ kind: 'ok', text: 'Settings saved' });
			await load();
		} catch (e) {
			if (mounted.current) setStatus({ kind: 'error', text: errorText(e) });
		} finally {
			if (mounted.current) setBusy(null);
		}
	};

	const clean = async (mode: 'unused' | 'all') => {
		if (mode === 'all') {
			const ok = await confirmDialog({
				title: 'Clean all media cache files that are not in use?',
				body: (
					<div className="flex flex-col gap-2">
						<p>
							{usage && usage.referencedBytes + usage.unusedBytes === 0
								? 'Everything in the cache is in use right now: nothing would be removed.'
								: `This frees up to ${usage ? formatBytes(usage.referencedBytes + usage.unusedBytes) : 'all of it'}, including files saved projects use. They are made again when needed, so previews and exports of those projects are slower the first time.`}
						</p>
						<p className="text-pr-muted">
							Files of open projects and running exports are kept. Media files and projects are never deleted.
						</p>
					</div>
				),
				confirmLabel: 'Clean All',
				danger: true,
			});
			if (!ok) return;
		}
		setBusy(mode);
		setStatus({ kind: 'info', text: 'Cleaning…' });
		try {
			const r = await client.call('cacheClean', { body: { mode } });
			if (!mounted.current) return;
			setStatus({ kind: 'ok', text: `${mode === 'all' ? 'Clean All' : 'Clean Unused'}: ${reportText(r)}` });
			await load();
		} catch (e) {
			if (mounted.current) setStatus({ kind: 'error', text: errorText(e) });
		} finally {
			if (mounted.current) setBusy(null);
		}
	};

	const total = usage
		? `${formatBytes(usage.totalBytes)}${
				usage.maxTotalBytes !== null
					? ` of ${formatBytes(usage.maxTotalBytes)}${usage.automaticBudget ? ' (automatic limit)' : ''}`
					: ''
			}`
		: '…';
	const settingsDisabled = !form || busy === 'save';
	return (
		<div data-testid="prefs-cache" className="flex flex-col">
			<PrefGroup
				title="Media Cache"
				actions={
					<Button
						variant="quiet"
						busy={busy === 'load'}
						onClick={() => {
							setBusy('load');
							void load();
						}}
						data-testid="cache-refresh"
					>
						Refresh
					</Button>
				}
			>
				<p className="mb-1 text-pr-small text-pr-muted">
					Files the editor makes from your media and timelines — waveforms, thumbnails, proxies, baked colour
					LUTs, warped and baked layers, motion-graphics renders, export outputs. They are made again when
					needed; removing them never changes a project.
				</p>
				{usage?.location ? (
					<PrefRow label="Location">
						<span
							className="min-w-0 truncate font-mono text-pr-small text-pr-text"
							title={usage.location}
							data-testid="cache-location"
						>
							{usage.location}
						</span>
						<span className="shrink-0 text-pr-small text-pr-dim">
							{usage.locationIsDefault === false ? '(custom)' : '(default)'}
						</span>
						{!moving ? (
							<Button
								variant="quiet"
								className="ml-auto shrink-0"
								disabled={!!busy}
								onClick={() => setMoving(true)}
								data-testid="cache-location-change"
							>
								Change…
							</Button>
						) : null}
					</PrefRow>
				) : null}
				{usage?.location && moving ? (
					<LocationPanel
						usage={usage}
						onClose={() => setMoving(false)}
						onDone={() => {
							setMoving(false);
							setStatus({ kind: 'ok', text: 'The media cache location changed' });
							void load();
						}}
					/>
				) : null}
				<PrefRow label="Usage">
					<span className="shrink-0 text-pr-strong" data-testid="cache-total">
						{total}
					</span>
					{usage?.freeDiskBytes != null ? (
						<span className="shrink-0 text-pr-small text-pr-muted">
							· {formatBytes(usage.freeDiskBytes)} free on disk
						</span>
					) : null}
				</PrefRow>
				{usage ? (
					<div className="pl-[172px]">
						<UsageBar u={usage} />
					</div>
				) : null}
				<div className="mt-2 overflow-hidden rounded-pr-control border border-pr-border-subtle">
					<table className="w-full table-fixed border-collapse text-pr-small" data-testid="cache-table">
						<colgroup>
							<col />
							<col className="w-[48px]" />
							<col className="w-[72px]" />
							<col className="w-[72px]" />
							<col className="w-[80px]" />
							<col className="w-[72px]" />
							<col className="w-[76px]" />
							<col className="w-[68px]" />
						</colgroup>
						<thead className="bg-pr-panel-alt text-pr-muted">
							<tr>
								<th className="px-1.5 py-1 text-left font-normal">Kind</th>
								<th className="px-1.5 py-1 text-right font-normal">Items</th>
								<th className="px-1.5 py-1 text-right font-normal">Size</th>
								<th className="px-1.5 py-1 text-right font-normal">In use</th>
								<th className="px-1.5 py-1 text-right font-normal" title="Referenced by saved projects">
									Projects
								</th>
								<th className="px-1.5 py-1 text-right font-normal">Unused</th>
								<th className="px-1.5 py-1 text-left font-normal" title="Size limit in GB (empty = none)">
									Limit GB
								</th>
								<th className="px-1.5 py-1 text-left font-normal" title="Delete unused files after N days">
									Days
								</th>
							</tr>
						</thead>
						<tbody>
							{usage?.kinds.map((k) => (
								<KindRow
									key={k.kind}
									k={k}
									form={form?.kinds[k.kind] ?? { maxGb: '', days: '' }}
									disabled={settingsDisabled}
									onChange={(next) => form && patch({ kinds: { ...form.kinds, [k.kind]: next } })}
								/>
							))}
							{usage?.logs && form ? (
								<tr className="border-t border-pr-border bg-pr-panel-alt" data-testid="cache-logs">
									<td
										className="max-w-0 truncate px-1.5 py-0.5 text-pr-text"
										title="Engine logs and the job history: not cache, never removed by Clean Unused / Clean All"
									>
										Logs and job history
									</td>
									<td className="px-1.5 py-0.5 text-right tabular-nums">{usage.logs.files}</td>
									<td
										className="px-1.5 py-0.5 text-right tabular-nums text-pr-strong"
										data-testid="cache-logs-bytes"
									>
										{formatBytes(usage.logs.bytes)}
									</td>
									<td colSpan={3} className="px-1.5 py-0.5 text-pr-dim">
										kept by age and size
									</td>
									<td className="px-1 py-0.5">
										<TextField
											aria-label="Logs: size limit in MB"
											title="MB (empty = no limit)"
											className="h-5 w-16 text-right"
											inputMode="decimal"
											placeholder="none"
											value={form.logsMb}
											disabled={settingsDisabled}
											onChange={(e) => patch({ logsMb: e.target.value })}
											data-testid="cache-logs-max"
										/>
									</td>
									<td className="px-1 py-0.5">
										<TextField
											aria-label='Logs: delete after (days, or "never")'
											className="h-5 w-14 text-right"
											inputMode="decimal"
											placeholder={NEVER}
											value={form.logsDays}
											disabled={settingsDisabled}
											onChange={(e) => patch({ logsDays: e.target.value })}
											data-testid="cache-logs-days"
										/>
									</td>
								</tr>
							) : null}
							{!usage ? (
								<tr>
									<td colSpan={8} className="px-1.5 py-2 text-pr-muted">
										{busy === 'load' ? 'Reading the cache…' : 'The cache usage is not available.'}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Button
						busy={busy === 'unused'}
						disabled={!usage || !!busy}
						onClick={() => void clean('unused')}
						data-testid="cache-clean-unused"
					>
						Clean Unused
					</Button>
					<Button
						variant="danger"
						busy={busy === 'all'}
						disabled={!usage || !!busy}
						onClick={() => void clean('all')}
						data-testid="cache-clean-all"
					>
						Clean All (not in use)…
					</Button>
					<span className="text-pr-small text-pr-dim" data-testid="cache-last-gc">
						{usage?.lastGc ? lastGcText(usage.lastGc) : ''}
					</span>
				</div>
			</PrefGroup>

			<PrefGroup title="Automatic Cleaning" testId="cache-settings">
				<PrefRow label="Clean automatically">
					<Checkbox
						checked={form?.autoClean ?? true}
						disabled={settingsDisabled}
						onCheckedChange={(c) => patch({ autoClean: c })}
						label="At start-up, every hour and after renders"
						aria-label="Clean automatically"
					/>
				</PrefRow>
				<PrefRow label="Unused files" htmlFor={ids.days}>
					<Checkbox
						checked={form?.ageOn ?? true}
						disabled={settingsDisabled || !form?.autoClean}
						onCheckedChange={(c) => patch({ ageOn: c })}
						label="Delete when older than"
						aria-label="Delete unused cache files by age"
					/>
					<TextField
						id={ids.days}
						className="w-14 text-right"
						inputMode="decimal"
						value={form?.days ?? ''}
						disabled={settingsDisabled || !form?.ageOn || !form?.autoClean}
						onChange={(e) => patch({ days: e.target.value })}
						data-testid="cache-max-age"
					/>
					<span className="text-pr-muted">days</span>
				</PrefRow>
				<PrefRow label="Cache size limit" htmlFor={ids.gb}>
					<Select
						label="Cache size limit"
						className="w-80"
						value={form?.budget ?? 'auto'}
						disabled={settingsDisabled || !form?.autoClean}
						onValueChange={(v) => patch({ budget: v as Form['budget'] })}
						options={[
							{ value: 'auto', label: 'Automatic (25 GB or 15 % of free disk)' },
							{ value: 'custom', label: 'Custom' },
						]}
					/>
					{form?.budget === 'custom' ? (
						<>
							<TextField
								id={ids.gb}
								className="w-16 text-right"
								inputMode="decimal"
								value={form.gb}
								disabled={settingsDisabled || !form.autoClean}
								onChange={(e) => patch({ gb: e.target.value })}
								data-testid="cache-budget-gb"
							/>
							<span className="text-pr-muted">GB</span>
						</>
					) : null}
				</PrefRow>
				<p className="pl-[172px] text-pr-small text-pr-muted">
					Over the limit, the least recently used unused files go first. Files of open projects, running jobs
					and saved projects are never removed automatically. Per-kind limits are in the table above (Days:
					empty = the default, “never” = keep until cleaned by hand); logs are kept by their own age and size
					limits.
				</p>
				<div className="mt-2 flex items-center gap-2">
					<Button
						variant="primary"
						busy={busy === 'save'}
						disabled={!dirty || !!busy}
						onClick={() => void save()}
						data-testid="cache-save"
					>
						Save
					</Button>
					{status ? (
						<span
							role={status.kind === 'error' ? 'alert' : 'status'}
							className={cx(
								'min-w-0 text-pr-small',
								status.kind === 'error'
									? 'text-pr-danger'
									: status.kind === 'ok'
										? 'text-pr-success'
										: 'text-pr-muted',
							)}
							data-testid="cache-status"
						>
							{status.text}
						</span>
					) : null}
				</div>
			</PrefGroup>
		</div>
	);
}
