// Each source channel maps to at most one clip channel, and each clip channel takes at most one source.
// An unmapped clip channel is silent. Project-item edits affect future placements; timeline edits retain clip count.
import {
	CLIP_CHANNEL_FORMATS,
	type ClipChannelFormat,
	type ClipChannels,
	clipChannelName,
	formatOfCount,
	type MediaAsset,
	matrixOfRouting,
	routingFromMatrix,
	type Sequence,
	sourceChannels,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useState } from 'react';

export const AUDIO_CHANNELS_DIALOG = 'gaps.audioChannels';

export type AudioChannelsTarget =
	| { kind: 'clips'; sequenceId: string; clipIds: string[] }
	| { kind: 'items'; itemIds: string[] };

/** The media and current routing of a target (null when it is not one media with audio). */
export function routingOf(
	session: EditorSession,
	t: AudioChannelsTarget,
): { asset: MediaAsset; clips: ClipChannels[]; fixedCount: boolean } | null {
	const doc = session.getCommitted();
	if (t.kind === 'clips') {
		const seq = doc.sequences[t.sequenceId] as Sequence | undefined;
		const clips = t.clipIds.map((id) => seq?.clips[id]).filter((c) => c?.kind === 'audio');
		if (!clips.length || new Set(clips.map((c) => c.mediaId)).size !== 1) return null;
		const asset = doc.media[clips[0]!.mediaId];
		return asset ? { asset, clips: clips.map((c) => c.channels), fixedCount: true } : null;
	}
	const items = t.itemIds.map((id) => doc.items[id]).filter((i) => i?.kind === 'media');
	if (!items.length || new Set(items.map((i) => i.mediaId)).size !== 1) return null;
	const asset = doc.media[items[0]!.mediaId];
	if (!asset || !sourceChannels(asset).length) return null;
	const s = asset.probe.streams.find((x) => x.type === 'audio');
	const def: ClipChannels[] =
		s && s.type === 'audio' ? [{ streamIndex: s.index, map: s.channels >= 2 ? [0, 1] : [0] }] : [];
	return { asset, clips: items[0]!.audioChannels?.clips ?? def, fixedCount: false };
}

function AudioChannelsDialog(
	props: HostedDialogProps<{ session: EditorSession; target: AudioChannelsTarget }>,
) {
	const r = routingOf(props.session, props.target);
	const [format, setFormat] = useState<ClipChannelFormat>(() => formatOfCount(r?.clips[0]?.map.length ?? 2));
	const [count, setCount] = useState(r?.clips.length ?? 1);
	const [assign, setAssign] = useState<([number, number] | null)[]>(() =>
		r ? matrixOfRouting(r.asset, r.clips) : [],
	);
	const [error, setError] = useState<string | null>(null);
	if (!r) return null;
	const rows = sourceChannels(r.asset);
	const n = CLIP_CHANNEL_FORMATS[format];
	const toggle = (row: number, clip: number, ch: number) => {
		setError(null);
		setAssign((a) => {
			const next = a.map((x) => (x && x[0] === clip && x[1] === ch ? null : x));
			next[row] = a[row] && a[row]![0] === clip && a[row]![1] === ch ? null : [clip, ch];
			return next;
		});
	};
	const changeShape = (f: ClipChannelFormat, c: number) => {
		const nn = CLIP_CHANNEL_FORMATS[f];
		setAssign((a) => a.map((x) => (x && x[0] < c && x[1] < nn ? x : null)));
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Modify Clip — Audio Channels"
			size="large"
			primaryLabel="OK"
			onPrimary={() => {
				const built = routingFromMatrix(r.asset, format, count, assign);
				if ('error' in built) {
					setError(built.error);
					return false;
				}
				const t = props.target;
				const cmd =
					t.kind === 'clips'
						? {
								type: 'clip.setAudioChannels',
								sequenceId: t.sequenceId,
								clipIds: t.clipIds,
								channels: built.clips,
							}
						: { type: 'item.setAudioChannels', itemIds: t.itemIds, clips: built.clips };
				const res = props.session.apply({
					label: 'Audio Channels',
					origin: 'user',
					...(t.kind === 'clips' ? { sequenceId: t.sequenceId } : {}),
					commands: [cmd] as never[],
				});
				if (!res.ok) {
					setError(res.errors[0]?.message ?? 'The routing was refused.');
					return false;
				}
				props.close(true);
				return false;
			}}
			data-testid="audio-channels-dialog"
		>
			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-4">
					<span className="text-pr-muted">Clip Channel Format</span>
					<Select
						label="Clip channel format"
						className="w-32"
						value={format}
						onValueChange={(v) => {
							setFormat(v as ClipChannelFormat);
							changeShape(v as ClipChannelFormat, count);
						}}
						options={[
							{ value: 'mono', label: 'Mono' },
							{ value: 'stereo', label: 'Stereo' },
							{ value: '5.1', label: '5.1' },
						]}
					/>
					<span className="text-pr-muted">Number of Audio Clips</span>
					<TextField
						aria-label="Number of audio clips"
						data-testid="audio-clip-count"
						type="number"
						min={1}
						max={32}
						className="w-16"
						disabled={r.fixedCount}
						title={r.fixedCount ? 'Clips in a sequence keep their number (as in Premiere)' : undefined}
						value={count}
						onChange={(e) => {
							const c = Math.max(1, Math.min(32, Number.parseInt(e.target.value, 10) || 1));
							setCount(c);
							changeShape(format, c);
						}}
					/>
				</div>
				<div className="max-h-[50vh] overflow-auto rounded-pr-control border border-pr-border-subtle">
					<table className="w-full border-collapse text-pr-small">
						<thead>
							<tr>
								<th className="sticky left-0 bg-pr-panel-alt px-2 py-1 text-left">Media Source Channel</th>
								{Array.from({ length: count }, (_, k) =>
									Array.from({ length: n }, (_, c) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: the columns are fixed grid positions (clip k, channel c)
										<th key={`${k}-${c}`} className="bg-pr-panel-alt px-1 py-1 text-center font-normal">
											Clip {k + 1}
											<br />
											{clipChannelName(n, c)}
										</th>
									)),
								)}
							</tr>
						</thead>
						<tbody>
							{rows.map((row, ri) => (
								<tr key={`${row.streamIndex}-${row.channel}`} className="border-t border-pr-border-subtle">
									<td className="sticky left-0 bg-pr-panel px-2 py-1">{row.label}</td>
									{Array.from({ length: count }, (_, k) =>
										Array.from({ length: n }, (_, c) => {
											const on = !!assign[ri] && assign[ri]![0] === k && assign[ri]![1] === c;
											return (
												// biome-ignore lint/suspicious/noArrayIndexKey: the cells are fixed grid positions (clip k, channel c)
												<td key={`${k}-${c}`} className="px-1 py-1 text-center">
													<input
														type="checkbox"
														aria-label={`${row.label} to Clip ${k + 1} ${clipChannelName(n, c)}`}
														checked={on}
														onChange={() => toggle(ri, k, c)}
													/>
												</td>
											);
										}),
									)}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="text-pr-small text-pr-dim">
					A clip channel with no source channel plays silence. Each clip takes its channels from one stream.
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
export function registerAudioChannelsDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(AUDIO_CHANNELS_DIALOG, AudioChannelsDialog);
}
