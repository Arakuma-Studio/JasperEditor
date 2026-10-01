// Preferences ▸ Processing (S07:PRU-004, PRM-001…004): the remote executor over SSH (key-based auth only),
// Test connection (the RemoteProbeResult rendered), Set up remote (a `remote-setup` job), local CPU slots and
// the super-resolution models with sizes, licences and attribution (Install; bundled models are marked).
import type {
	EngineJob,
	ProcessingModel,
	ProcessingSettings,
	RemoteExecutorSettings,
	RemoteProbeResult,
} from '@jasper/api';
import { Button, Checkbox, cx, Icon, Select, TextField, Toggle } from '@jasper/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import { useEngine } from '../state/engine.tsx';
import { errorText, followJob, formatAgo, formatBytes } from './engine-jobs.ts';
import { STEP_ORDER, type StepOp } from './model.ts';

const STEP_NAMES: Record<StepOp, string> = {
	deblock: 'Deblock',
	denoise: 'Denoise',
	stabilize: 'Stabilize',
	dejudder: 'De-judder',
	upscale: 'Upscale',
};

type RemoteForm = {
	enabled: boolean;
	host: string;
	port: string;
	user: string;
	identityFile: string;
	remoteDir: string;
	useFor: StepOp[];
	strictHostKeyChecking: 'accept-new' | 'yes';
};

const EMPTY_REMOTE: RemoteForm = {
	enabled: false,
	host: '',
	port: '22',
	user: '',
	identityFile: '',
	remoteDir: '',
	useFor: ['upscale', 'dejudder'],
	strictHostKeyChecking: 'accept-new',
};

function toForm(r: RemoteExecutorSettings | null): RemoteForm {
	if (!r) return EMPTY_REMOTE;
	return {
		enabled: r.enabled,
		host: r.host,
		port: String(r.port),
		user: r.user,
		identityFile: r.identityFile ?? '',
		remoteDir: r.remoteDir,
		useFor: [...r.useFor],
		strictHostKeyChecking: r.strictHostKeyChecking,
	};
}

/** The settings to PUT, or a validation message. Empty host/user/dir with the toggle off = no remote. */
function settingsFromForm(
	f: RemoteForm,
	localSlots: string,
): { settings: ProcessingSettings } | { error: string } {
	const blank = !f.host.trim() && !f.user.trim() && !f.remoteDir.trim() && !f.identityFile.trim();
	let remote: RemoteExecutorSettings | null = null;
	if (!(blank && !f.enabled)) {
		if (!f.host.trim()) return { error: 'Enter the remote host' };
		if (!f.user.trim()) return { error: 'Enter the SSH user' };
		if (!f.remoteDir.trim()) return { error: 'Enter the remote working directory' };
		const port = Number(f.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The port must be 1–65535' };
		remote = {
			enabled: f.enabled,
			host: f.host.trim(),
			port,
			user: f.user.trim(),
			identityFile: f.identityFile.trim() || null,
			remoteDir: f.remoteDir.trim(),
			useFor: STEP_ORDER.filter((s) => f.useFor.includes(s)),
			strictHostKeyChecking: f.strictHostKeyChecking,
		};
	}
	const settings: ProcessingSettings = { remote };
	if (localSlots.trim()) {
		const n = Number(localSlots);
		if (!Number.isInteger(n) || n < 1) return { error: 'CPU slots must be a whole number ≥ 1' };
		settings.localSlots = n;
	}
	return { settings };
}

function ProbeResultView({ probe, at }: { probe: RemoteProbeResult; at?: string | null }) {
	const row = (label: string, value: string | null, testId: string) => (
		<div className="contents">
			<dt className="text-pr-muted">{label}</dt>
			<dd className={cx('min-w-0 truncate', value ? 'text-pr-text' : 'text-pr-dim')} data-testid={testId}>
				{value ?? 'not found'}
			</dd>
		</div>
	);
	return (
		<div
			className="flex flex-col gap-2 rounded-pr-control border border-pr-border-subtle bg-pr-field-deep p-2"
			data-testid="probe-result"
			data-ok={probe.ok ? 'true' : 'false'}
		>
			<p className={cx('flex items-start gap-2', probe.ok ? 'text-pr-success' : 'text-pr-danger')}>
				<Icon id={probe.ok ? 'status.success' : 'status.error'} size={14} className="mt-[1px] shrink-0" />
				<span className="min-w-0 text-pr-text" data-testid="probe-message">
					<span className={probe.ok ? 'text-pr-success' : 'text-pr-danger'}>
						{probe.ok ? 'Ready' : 'Not ready'}
					</span>
					{probe.message ? ` — ${probe.message}` : ''}
				</span>
				{at ? <span className="ml-auto shrink-0 text-pr-small text-pr-dim">{formatAgo(at)}</span> : null}
			</p>
			<dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-pr-small">
				{row('Node.js', probe.node, 'probe-node')}
				{row('FFmpeg', probe.ffmpeg, 'probe-ffmpeg')}
				{row('GPU', probe.gpu ?? (probe.node ? 'none (CPU only)' : null), 'probe-gpu')}
				{row(
					'ONNX providers',
					probe.onnxProviders.length ? probe.onnxProviders.join(', ') : null,
					'probe-providers',
				)}
				{row(
					'Runtime',
					probe.runtimeReady ? 'installed and current' : 'not installed — run Set Up Remote',
					'probe-runtime',
				)}
			</dl>
		</div>
	);
}

function ModelsList() {
	const { client } = useEngine();
	const [models, setModels] = useState<ProcessingModel[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [installing, setInstalling] = useState<Record<string, string>>({});
	const load = useCallback(() => {
		client
			.call('processingModels')
			.then((r) => {
				setModels(r.models);
				setError(null);
			})
			.catch((e) => setError(errorText(e)));
	}, [client]);
	useEffect(load, [load]);
	const install = async (m: ProcessingModel) => {
		setInstalling((s) => ({ ...s, [m.id]: 'Queued' }));
		try {
			const job = (await client.call('processingModelInstall', { params: { modelId: m.id } })) as EngineJob;
			const end = await followJob(client, job.id, {
				onUpdate: (j) =>
					setInstalling((s) => ({
						...s,
						[m.id]: j.progress !== null ? `${Math.round(j.progress * 100)} %` : (j.stage ?? j.state),
					})),
			});
			if (end.state !== 'succeeded') setError(`${m.name}: ${end.error?.message ?? end.state}`);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setInstalling(({ [m.id]: _done, ...rest }) => rest);
			load();
		}
	};
	return (
		<PrefGroup title="Super-resolution models" testId="prefs-models">
			{error ? (
				<p className="text-pr-small text-pr-danger" role="alert">
					{error}
				</p>
			) : null}
			{models === null && !error ? <p className="text-pr-muted">Loading…</p> : null}
			{models?.length === 0 ? <p className="text-pr-muted">The engine's model catalogue is empty.</p> : null}
			<ul className="flex flex-col gap-2">
				{models?.map((m) => (
					<li
						key={m.id}
						className="flex flex-col gap-0.5 rounded-pr-control border border-pr-border-subtle p-2"
						data-testid={`model-${m.id}`}
					>
						<div className="flex items-center gap-2">
							<span className="min-w-0 truncate font-semibold text-pr-strong">{m.name}</span>
							<span className="shrink-0 text-pr-small text-pr-muted">
								{m.architecture} · {m.scale}× · {formatBytes(m.sizeBytes)}
							</span>
							<span className="ml-auto shrink-0">
								{m.installed ? (
									<span className="text-pr-small text-pr-success" data-testid={`model-${m.id}-state`}>
										{m.downloadUrl === null ? 'Bundled' : 'Installed'}
									</span>
								) : m.downloadUrl ? (
									<Button
										busy={!!installing[m.id]}
										onClick={() => void install(m)}
										data-testid={`model-${m.id}-install`}
									>
										{installing[m.id] ? `Installing ${installing[m.id]}` : 'Install'}
									</Button>
								) : (
									<span className="text-pr-small text-pr-warning">Missing from this installation</span>
								)}
							</span>
						</div>
						<p className="text-pr-small text-pr-muted">
							Weights licence: <span className="text-pr-text">{m.license}</span> ·{' '}
							<a
								href={m.sourceUrl}
								target="_blank"
								rel="noreferrer"
								className="text-pr-accent underline underline-offset-2"
							>
								Source
							</a>
						</p>
						{m.attribution ? <p className="text-pr-small text-pr-muted">{m.attribution}</p> : null}
					</li>
				))}
			</ul>
		</PrefGroup>
	);
}

export function ProcessingPreferencesPage() {
	const { client, capabilities } = useEngine();
	const ids = { host: useId(), port: useId(), user: useId(), key: useId(), dir: useId(), slots: useId() };
	const [loaded, setLoaded] = useState(false);
	const [form, setForm] = useState<RemoteForm>(EMPTY_REMOTE);
	const [slots, setSlots] = useState('');
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
	const [busy, setBusy] = useState<null | 'save' | 'probe' | 'setup'>(null);
	const [probe, setProbe] = useState<{ result: RemoteProbeResult; at: string | null } | null>(null);
	const [setupJob, setSetupJob] = useState<EngineJob | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true; // StrictMode runs effects twice: re-arm after the first cleanup
		return () => {
			mounted.current = false;
		};
	}, []);
	const proc = capabilities?.features?.processing;
	const cpuCount = capabilities?.limits.cpuCount ?? null;

	useEffect(() => {
		let cancelled = false;
		client
			.call('processingSettingsGet')
			.then((s) => {
				if (cancelled) return;
				setForm(toForm(s.remote));
				setSlots(s.localSlots ? String(s.localSlots) : '');
				setLoaded(true);
			})
			.catch((e) => {
				if (cancelled) return;
				setStatus({ kind: 'error', text: `Could not load the settings: ${errorText(e)}` });
				setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	const lastProbe = proc?.remote.lastProbe ?? null;

	const patch = (p: Partial<RemoteForm>) => {
		setForm((f) => ({ ...f, ...p }));
		setDirty(true);
		setStatus(null);
	};

	const save = async (): Promise<boolean> => {
		const built = settingsFromForm(form, slots);
		if ('error' in built) {
			setStatus({ kind: 'error', text: built.error });
			return false;
		}
		setBusy('save');
		try {
			const saved = await client.call('processingSettingsPut', { body: built.settings });
			if (!mounted.current) return true;
			setForm(toForm(saved.remote));
			setSlots(saved.localSlots ? String(saved.localSlots) : '');
			setDirty(false);
			setStatus({ kind: 'ok', text: 'Settings saved' });
			return true;
		} catch (e) {
			if (mounted.current) setStatus({ kind: 'error', text: errorText(e) });
			return false;
		} finally {
			if (mounted.current) setBusy(null);
		}
	};

	const test = async () => {
		if (dirty && !(await save())) return;
		setBusy('probe');
		setStatus(null);
		try {
			const result = await client.call('processingRemoteProbe');
			if (mounted.current) setProbe({ result, at: new Date().toISOString() });
		} catch (e) {
			if (mounted.current) setStatus({ kind: 'error', text: errorText(e) });
		} finally {
			if (mounted.current) setBusy(null);
		}
	};

	const setup = async () => {
		if (dirty && !(await save())) return;
		setBusy('setup');
		setStatus({ kind: 'info', text: 'Setting up the remote host… (progress in the Jobs panel)' });
		try {
			const job = (await client.call('processingRemoteSetup')) as EngineJob;
			const end = await followJob(client, job.id, { onUpdate: (j) => mounted.current && setSetupJob(j) });
			if (!mounted.current) return;
			if (end.state === 'succeeded') {
				setStatus({ kind: 'ok', text: 'The remote host is set up' });
				const r = end.result as RemoteProbeResult | undefined;
				if (r && typeof r.ok === 'boolean') setProbe({ result: r, at: end.finishedAt ?? null });
			} else
				setStatus({
					kind: 'error',
					text: `Set up failed: ${end.error?.code ?? end.state}: ${end.error?.message ?? ''}`,
				});
		} catch (e) {
			if (mounted.current) setStatus({ kind: 'error', text: errorText(e) });
		} finally {
			if (mounted.current) {
				setBusy(null);
				setSetupJob(null);
			}
		}
	};

	const hasRemote = !!form.host.trim();
	return (
		<div data-testid="prefs-processing" className="flex flex-col">
			<PrefGroup
				title="Remote executor (SSH)"
				actions={
					<Toggle
						checked={form.enabled}
						onCheckedChange={(c) => patch({ enabled: c })}
						label="Enabled"
						aria-label="Use the remote executor"
					/>
				}
			>
				<p className="mb-1 text-pr-small text-pr-muted">
					Runs heavy steps (upscale, de-judder) on another computer, e.g. a Linux box with an NVIDIA GPU.
					Key-based authentication only — JasperEditor never asks for or stores passwords.
				</p>
				<PrefRow label="Host" htmlFor={ids.host}>
					<TextField
						id={ids.host}
						className="w-56"
						placeholder="gpu-box.local"
						value={form.host}
						disabled={!loaded}
						onChange={(e) => patch({ host: e.target.value })}
						data-testid="remote-host"
					/>
					<label htmlFor={ids.port} className="text-pr-muted">
						Port
					</label>
					<TextField
						id={ids.port}
						className="w-16"
						inputMode="numeric"
						value={form.port}
						disabled={!loaded}
						onChange={(e) => patch({ port: e.target.value })}
						data-testid="remote-port"
					/>
				</PrefRow>
				<PrefRow label="User" htmlFor={ids.user}>
					<TextField
						id={ids.user}
						className="w-56"
						placeholder="jasper"
						value={form.user}
						disabled={!loaded}
						onChange={(e) => patch({ user: e.target.value })}
						data-testid="remote-user"
					/>
				</PrefRow>
				<PrefRow label="Identity file" htmlFor={ids.key}>
					<TextField
						id={ids.key}
						className="min-w-0 flex-1"
						placeholder="Empty = ssh agent / default keys, e.g. /home/me/.ssh/id_ed25519"
						value={form.identityFile}
						disabled={!loaded}
						onChange={(e) => patch({ identityFile: e.target.value })}
						data-testid="remote-identity"
					/>
				</PrefRow>
				<PrefRow label="Remote directory" htmlFor={ids.dir}>
					<TextField
						id={ids.dir}
						className="min-w-0 flex-1"
						placeholder="/home/jasper/jasper-remote"
						value={form.remoteDir}
						disabled={!loaded}
						onChange={(e) => patch({ remoteDir: e.target.value })}
						data-testid="remote-dir"
					/>
				</PrefRow>
				<PrefRow label="Use for (Auto)">
					<div className="flex flex-wrap gap-x-3 gap-y-1" data-testid="remote-usefor">
						{STEP_ORDER.map((s) => (
							<Checkbox
								key={s}
								checked={form.useFor.includes(s)}
								onCheckedChange={(c) =>
									patch({ useFor: c ? [...form.useFor, s] : form.useFor.filter((x) => x !== s) })
								}
								label={STEP_NAMES[s]}
							/>
						))}
					</div>
				</PrefRow>
				<PrefRow label="Host key checking">
					<Select
						label="Host key checking"
						className="w-72"
						value={form.strictHostKeyChecking}
						onValueChange={(v) => patch({ strictHostKeyChecking: v as RemoteForm['strictHostKeyChecking'] })}
						options={[
							{ value: 'accept-new', label: 'Accept new hosts, then pin the key' },
							{ value: 'yes', label: 'Only hosts already in known_hosts' },
						]}
					/>
				</PrefRow>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Button
						busy={busy === 'probe'}
						disabled={!hasRemote || !!busy}
						disabledReason={!hasRemote ? 'Enter a host first' : undefined}
						onClick={() => void test()}
						data-testid="remote-test"
					>
						Test Connection
					</Button>
					<Button
						busy={busy === 'setup'}
						disabled={!hasRemote || !!busy}
						disabledReason={!hasRemote ? 'Enter a host first' : undefined}
						onClick={() => void setup()}
						data-testid="remote-setup"
					>
						{setupJob?.progress != null
							? `Setting Up ${Math.round(setupJob.progress * 100)} %`
							: 'Set Up Remote'}
					</Button>
					<span className="text-pr-small text-pr-dim">
						Needs Linux x64, Node ≥ 20 and write access to the remote directory; an NVIDIA driver with CUDA 12
						for the GPU.
					</span>
				</div>
				{probe ? (
					<div className="mt-2">
						<ProbeResultView probe={probe.result} at={probe.at} />
					</div>
				) : lastProbe ? (
					<p
						className={cx('mt-2 text-pr-small', lastProbe.ok ? 'text-pr-success' : 'text-pr-muted')}
						data-testid="probe-last"
					>
						Last test {formatAgo(lastProbe.at)}: {lastProbe.ok ? 'ready' : 'not ready'}
						{lastProbe.gpu ? ` · ${lastProbe.gpu}` : ''}
						{lastProbe.message ? ` — ${lastProbe.message}` : ''}
					</p>
				) : null}
			</PrefGroup>

			<PrefGroup title="This computer">
				<PrefRow label="CPU slots per job" htmlFor={ids.slots}>
					<TextField
						id={ids.slots}
						className="w-16"
						inputMode="numeric"
						placeholder={cpuCount ? String(Math.max(1, Math.floor(cpuCount / 2))) : 'auto'}
						value={slots}
						disabled={!loaded}
						onChange={(e) => {
							setSlots(e.target.value);
							setDirty(true);
							setStatus(null);
						}}
						data-testid="local-slots"
					/>
					<span className="text-pr-small text-pr-dim">
						{cpuCount ? `of ${cpuCount} cores; empty = half of them` : 'empty = half the cores'}
					</span>
				</PrefRow>
				<PrefRow label="Available steps">
					<span className="text-pr-small text-pr-muted" data-testid="local-features">
						{proc
							? [
									`Stabilize: ${proc.stabilize === 'none' ? 'unavailable' : proc.stabilize}`,
									`Denoise: ${proc.denoise.length ? proc.denoise.join(', ') : 'unavailable'}`,
									`Deblock: ${proc.deblock ? 'yes' : 'no'}`,
									`De-judder: ${proc.dejudder}`,
									`Upscale: ${proc.upscale.runtime === 'none' ? 'unavailable' : `ONNX Runtime (${proc.upscale.providers.join(', ')})`}`,
								].join(' · ')
							: 'This engine does not report clip processing'}
					</span>
				</PrefRow>
			</PrefGroup>

			<ModelsList />

			<div className="sticky -bottom-4 -mx-4 -mb-4 flex h-11 items-center gap-2 border-t border-pr-border-subtle bg-pr-panel px-4">
				{status ? (
					<span
						role={status.kind === 'error' ? 'alert' : 'status'}
						data-testid="prefs-processing-status"
						className={cx(
							'min-w-0 truncate text-pr-small',
							status.kind === 'error'
								? 'text-pr-danger'
								: status.kind === 'ok'
									? 'text-pr-success'
									: 'text-pr-muted',
						)}
						title={status.text}
					>
						{status.text}
					</span>
				) : dirty ? (
					<span className="text-pr-small text-pr-muted">Unsaved changes</span>
				) : null}
				<Button
					variant="primary"
					pill
					className="ml-auto"
					busy={busy === 'save'}
					disabled={!loaded || !dirty || !!busy}
					onClick={() => void save()}
					data-testid="prefs-processing-save"
				>
					Save
				</Button>
			</div>
		</div>
	);
}
