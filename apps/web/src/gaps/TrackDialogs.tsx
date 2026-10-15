import type { AudioChannelFormat, CommandInput, Sequence, Track } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Checkbox,
	confirmDialog,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
} from '@jasper/ui';
import { type ReactNode, useId, useState } from 'react';

export const ADD_TRACKS_DIALOG = 'gaps.addTracks';
export const DELETE_TRACKS_DIALOG = 'gaps.deleteTracks';

const TRACK_TYPES: { value: AudioChannelFormat; label: string }[] = [
	{ value: 'mono', label: 'Mono' },
	{ value: 'stereo', label: 'Stereo' },
	{ value: '5.1', label: '5.1' },
];

const kindName = (k: 'video' | 'audio' | 'submix') =>
	k === 'video' ? 'Video' : k === 'audio' ? 'Audio' : 'Submix';

/** Placement choices: index into the kind's list (0 = before the first). */
function placementOptions(
	tracks: readonly Pick<Track, 'name'>[],
	kind: 'video' | 'audio' | 'submix',
): { value: string; label: string }[] {
	const out = [{ value: '0', label: 'Before First Track' }];
	tracks.forEach((t, i) => {
		const name = t.name ? ` (${t.name})` : '';
		out.push({ value: String(i + 1), label: `After ${kindName(kind)} ${i + 1}${name}` });
	});
	out[out.length - 1] = {
		...out[out.length - 1]!,
		label: tracks.length ? 'After Last Track' : out[0]!.label,
	};
	return out;
}

/** Commands of an Add Tracks run (counts of 0 add nothing). */
export function addTracksCommands(
	seq: Sequence,
	opts: {
		video: { count: number; index: number };
		audio: { count: number; index: number; type: AudioChannelFormat };
		submix: { count: number; index: number; type: AudioChannelFormat };
	},
): CommandInput[] {
	const cmds: CommandInput[] = [];
	const clampCount = (n: number) => Math.max(0, Math.min(99, Math.floor(Number.isFinite(n) ? n : 0)));
	const v = clampCount(opts.video.count);
	const a = clampCount(opts.audio.count);
	const s = clampCount(opts.submix.count);
	if (v)
		cmds.push({
			type: 'track.add',
			sequenceId: seq.id,
			kind: 'video',
			count: v,
			index: Math.min(opts.video.index, seq.videoTracks.length),
		});
	if (a)
		cmds.push({
			type: 'track.add',
			sequenceId: seq.id,
			kind: 'audio',
			count: a,
			index: Math.min(opts.audio.index, seq.audioTracks.length),
			...(opts.audio.type !== 'stereo' ? { channelFormat: opts.audio.type } : {}),
		});
	const submixes = seq.submixTracks ?? [];
	for (let i = 0; i < s; i++)
		cmds.push({
			type: 'mixer.addSubmix',
			sequenceId: seq.id,
			index: Math.min(opts.submix.index, submixes.length) + i,
			channelFormat: opts.submix.type,
		});
	return cmds;
}

const isEmpty = (seq: Sequence, trackId: string) =>
	!Object.values(seq.clips).some((c) => c.trackId === trackId);

/** Submixes no track (or other submix) outputs or sends to. */
export function unassignedSubmixes(seq: Sequence): Track[] {
	const all = [...seq.audioTracks, ...(seq.submixTracks ?? [])];
	return (seq.submixTracks ?? []).filter(
		(s) =>
			!all.some((t) => t.mixer?.output === s.id || (t.mixer?.sends ?? []).some((x) => x.target === s.id)),
	);
}

export type DeleteChoice = { enabled: boolean; target: string };

/** Track ids a Delete Tracks run removes (`target`: `empty` / `unassigned` or a track id). */
export function deleteTracksPlan(
	seq: Sequence,
	opts: { video: DeleteChoice; audio: DeleteChoice; submix: DeleteChoice },
): { trackIds: string[]; submixIds: string[]; clips: number; error?: string } {
	const pick = (list: readonly Track[], c: DeleteChoice) =>
		!c.enabled
			? []
			: c.target === 'empty'
				? list.filter((t) => isEmpty(seq, t.id))
				: list.filter((t) => t.id === c.target);
	const video = pick(seq.videoTracks, opts.video);
	const audio = pick(seq.audioTracks, opts.audio);
	const submixIds = !opts.submix.enabled
		? []
		: opts.submix.target === 'unassigned'
			? unassignedSubmixes(seq).map((t) => t.id)
			: (seq.submixTracks ?? []).filter((t) => t.id === opts.submix.target).map((t) => t.id);
	// A sequence keeps at least one video and one audio track (empty-track deletions keep the first one).
	let error: string | undefined;
	const keep = (all: readonly Track[], gone: Track[], choice: DeleteChoice) => {
		if (gone.length < all.length) return gone;
		if (choice.target === 'empty') return gone.slice(1);
		error = 'A sequence needs at least one video and one audio track.';
		return [];
	};
	const v = keep(seq.videoTracks, video, opts.video);
	const a = keep(seq.audioTracks, audio, opts.audio);
	const ids = [...v, ...a].map((t) => t.id);
	const clips = Object.values(seq.clips).filter((c) => ids.includes(c.trackId)).length;
	return { trackIds: ids, submixIds, clips, ...(error ? { error } : {}) };
}

function Section(props: { title: string; children: ReactNode }) {
	return (
		<fieldset className="flex flex-col gap-2 rounded-pr-control border border-pr-border-subtle p-3">
			<legend className="px-1 font-semibold text-pr-strong">{props.title}</legend>
			{props.children}
		</fieldset>
	);
}

function Row(props: { label: string; htmlFor?: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2">
			<label className="text-pr-muted" htmlFor={props.htmlFor}>
				{props.label}
			</label>
			<div className="flex items-center gap-2">{props.children}</div>
		</div>
	);
}

type DialogProps = { session: EditorSession; sequenceId: string };

function seqOf(session: EditorSession, id: string): Sequence | null {
	return (session.getCommitted().sequences[id] as Sequence | undefined) ?? null;
}

function AddTracksDialog(props: HostedDialogProps<DialogProps>) {
	const seq = seqOf(props.session, props.sequenceId);
	const ids = { v: useId(), a: useId(), s: useId() };
	const [v, setV] = useState({ count: 1, index: seq?.videoTracks.length ?? 0 });
	const [a, setA] = useState({
		count: 1,
		index: seq?.audioTracks.length ?? 0,
		type: 'stereo' as AudioChannelFormat,
	});
	const [s, setS] = useState({
		count: 0,
		index: seq?.submixTracks?.length ?? 0,
		type: 'stereo' as AudioChannelFormat,
	});
	const [error, setError] = useState<string | null>(null);
	if (!seq) return null;
	const count = (n: string) => {
		const x = Number.parseInt(n, 10);
		return Number.isFinite(x) ? Math.max(0, Math.min(99, x)) : 0;
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Add Tracks"
			size="medium"
			primaryLabel="OK"
			primaryDisabled={v.count + a.count + s.count === 0}
			onPrimary={() => {
				const cmds = addTracksCommands(seq, { video: v, audio: a, submix: s });
				const r = props.session.apply({
					label: 'Add Tracks',
					origin: 'user',
					sequenceId: seq.id,
					commands: cmds,
				});
				if (!r.ok) {
					setError(r.errors[0]?.message ?? 'The tracks could not be added.');
					return false;
				}
				props.close(true);
				return false;
			}}
			data-testid="add-tracks-dialog"
		>
			<div className="flex flex-col gap-3">
				<Section title="Video Tracks">
					<Row label="Add" htmlFor={ids.v}>
						<TextField
							id={ids.v}
							type="number"
							min={0}
							max={99}
							className="w-16"
							value={v.count}
							data-testid="add-video-count"
							onChange={(e) => setV({ ...v, count: count(e.target.value) })}
						/>
						<span>video track(s)</span>
					</Row>
					<Row label="Placement">
						<Select
							label="Video placement"
							className="w-64"
							value={String(v.index)}
							onValueChange={(x) => setV({ ...v, index: Number(x) })}
							options={placementOptions(seq.videoTracks, 'video')}
						/>
					</Row>
				</Section>
				<Section title="Audio Tracks">
					<Row label="Add" htmlFor={ids.a}>
						<TextField
							id={ids.a}
							type="number"
							min={0}
							max={99}
							className="w-16"
							value={a.count}
							data-testid="add-audio-count"
							onChange={(e) => setA({ ...a, count: count(e.target.value) })}
						/>
						<span>audio track(s)</span>
					</Row>
					<Row label="Placement">
						<Select
							label="Audio placement"
							className="w-64"
							value={String(a.index)}
							onValueChange={(x) => setA({ ...a, index: Number(x) })}
							options={placementOptions(seq.audioTracks, 'audio')}
						/>
					</Row>
					<Row label="Track Type">
						<Select
							label="Audio track type"
							className="w-40"
							value={a.type}
							onValueChange={(x) => setA({ ...a, type: x as AudioChannelFormat })}
							options={TRACK_TYPES}
						/>
					</Row>
				</Section>
				<Section title="Audio Submix Tracks">
					<Row label="Add" htmlFor={ids.s}>
						<TextField
							id={ids.s}
							type="number"
							min={0}
							max={99}
							className="w-16"
							value={s.count}
							data-testid="add-submix-count"
							onChange={(e) => setS({ ...s, count: count(e.target.value) })}
						/>
						<span>audio submix track(s)</span>
					</Row>
					<Row label="Placement">
						<Select
							label="Submix placement"
							className="w-64"
							value={String(s.index)}
							onValueChange={(x) => setS({ ...s, index: Number(x) })}
							options={placementOptions(seq.submixTracks ?? [], 'submix')}
						/>
					</Row>
					<Row label="Track Type">
						<Select
							label="Submix track type"
							className="w-40"
							value={s.type}
							onValueChange={(x) => setS({ ...s, type: x as AudioChannelFormat })}
							options={TRACK_TYPES}
						/>
					</Row>
				</Section>
				{error ? (
					<p role="alert" className="text-pr-small text-pr-danger">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

function trackOptions(
	list: readonly Track[],
	kind: 'video' | 'audio' | 'submix',
	first: { value: string; label: string },
) {
	return [
		first,
		...list.map((t, i) => ({
			value: t.id,
			label: `${kindName(kind)} ${i + 1}${t.name ? ` (${t.name})` : ''}`,
		})),
	];
}

function DeleteTracksDialog(props: HostedDialogProps<DialogProps>) {
	const seq = seqOf(props.session, props.sequenceId);
	const [v, setV] = useState<DeleteChoice>({ enabled: false, target: 'empty' });
	const [a, setA] = useState<DeleteChoice>({ enabled: false, target: 'empty' });
	const [s, setS] = useState<DeleteChoice>({ enabled: false, target: 'unassigned' });
	const [error, setError] = useState<string | null>(null);
	if (!seq) return null;
	const plan = deleteTracksPlan(seq, { video: v, audio: a, submix: s });
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Delete Tracks"
			size="medium"
			primaryLabel="OK"
			primaryDisabled={!v.enabled && !a.enabled && !s.enabled}
			onPrimary={async () => {
				const p = deleteTracksPlan(seq, { video: v, audio: a, submix: s });
				if (p.error) {
					setError(p.error);
					return false;
				}
				if (!p.trackIds.length && !p.submixIds.length) {
					setError('No track matches: nothing to delete.');
					return false;
				}
				if (
					p.clips > 0 &&
					!(await confirmDialog({
						title: 'Delete tracks with clips?',
						body: `The tracks hold ${p.clips} clip${p.clips === 1 ? '' : 's'}; they are deleted with them. You can undo this.`,
						confirmLabel: 'Delete Tracks',
					}))
				)
					return false;
				const cmds: CommandInput[] = [];
				if (p.trackIds.length)
					cmds.push({ type: 'track.remove', sequenceId: seq.id, trackIds: p.trackIds, force: p.clips > 0 });
				for (const id of p.submixIds)
					cmds.push({ type: 'mixer.removeSubmix', sequenceId: seq.id, stripId: id });
				const r = props.session.apply({
					label: 'Delete Tracks',
					origin: 'user',
					sequenceId: seq.id,
					commands: cmds,
				});
				if (!r.ok) {
					setError(r.errors[0]?.message ?? 'The tracks could not be deleted.');
					return false;
				}
				props.close(true);
				return false;
			}}
			data-testid="delete-tracks-dialog"
		>
			<div className="flex flex-col gap-3">
				<Section title="Video Tracks">
					<Checkbox
						checked={v.enabled}
						onCheckedChange={(c) => setV({ ...v, enabled: c })}
						label="Delete Video Tracks"
					/>
					<Select
						label="Video tracks to delete"
						className="w-64"
						disabled={!v.enabled}
						value={v.target}
						onValueChange={(x) => setV({ ...v, target: x })}
						options={trackOptions(seq.videoTracks, 'video', { value: 'empty', label: 'All Empty Tracks' })}
					/>
				</Section>
				<Section title="Audio Tracks">
					<Checkbox
						checked={a.enabled}
						onCheckedChange={(c) => setA({ ...a, enabled: c })}
						label="Delete Audio Tracks"
					/>
					<Select
						label="Audio tracks to delete"
						className="w-64"
						disabled={!a.enabled}
						value={a.target}
						onValueChange={(x) => setA({ ...a, target: x })}
						options={trackOptions(seq.audioTracks, 'audio', { value: 'empty', label: 'All Empty Tracks' })}
					/>
				</Section>
				<Section title="Audio Submix Tracks">
					<Checkbox
						checked={s.enabled}
						disabled={!(seq.submixTracks ?? []).length}
						onCheckedChange={(c) => setS({ ...s, enabled: c })}
						label="Delete Audio Submix Tracks"
					/>
					<Select
						label="Submix tracks to delete"
						className="w-64"
						disabled={!s.enabled}
						value={s.target}
						onValueChange={(x) => setS({ ...s, target: x })}
						options={trackOptions(seq.submixTracks ?? [], 'submix', {
							value: 'unassigned',
							label: 'All Unassigned Tracks',
						})}
					/>
				</Section>
				<p className="text-pr-small text-pr-muted" role="status" data-testid="delete-tracks-summary">
					{plan.error ??
						(plan.trackIds.length + plan.submixIds.length
							? `${plan.trackIds.length + plan.submixIds.length} track(s) will be deleted${plan.clips ? `, with ${plan.clips} clip(s)` : ''}.`
							: 'Nothing selected.')}
				</p>
				{error ? (
					<p role="alert" className="text-pr-small text-pr-danger">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerTrackDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(ADD_TRACKS_DIALOG, AddTracksDialog);
	registerDialog(DELETE_TRACKS_DIALOG, DeleteTracksDialog);
}
