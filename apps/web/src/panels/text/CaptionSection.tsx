// wp captions: Properties panel ▸ Caption section for selected caption clips — text and speaker of one caption, and
// its per-caption style overrides (size, colour, alignment, position; Reset clears them). Registered as a clip section.
import {
	type CaptionStyle,
	type CaptionsClip,
	captionClipSpeaker,
	captionClipText,
	type ProjectDocument,
	resolveCaptionStyle,
	type Sequence,
} from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { Button, ColorSwatch, Select, TextField, toast } from '@jasper/ui';
import { useState } from 'react';
import { type ClipSectionProps, clipSections } from '../../extensions/index.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { textPanelRequests } from './state.ts';

function CaptionSection({ session, clips, sequenceId }: ClipSectionProps) {
	const runtime = useShellRuntimeOrNull();
	const doc = useStoreSelector(session.store, (s) => s.transient ?? s.document) as ProjectDocument;
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	const caps = clips.filter((c): c is CaptionsClip => c.kind === 'captions');
	if (!seq || !caps.length) return null;
	const one = caps.length === 1 ? caps[0]! : null;
	const apply = (label: string, commands: unknown[]) => {
		const r = session.apply({ label, origin: 'user', sequenceId, commands: commands as never[] });
		if (!r.ok) toast({ kind: 'warning', title: `${label}: not possible`, detail: r.errors[0]?.message });
	};
	const track = seq.captionTracks.find((t) => t.id === caps[0]!.trackId);
	const style = resolveCaptionStyle(
		track?.styleDefaults,
		caps[0]!.style,
		Object.keys(doc.fonts)[0] ?? '',
		seq.settings.height,
	);
	const setStyle = (patch: Partial<CaptionStyle>) =>
		apply('Caption Style', [{ type: 'caption.setStyle', clipIds: caps.map((c) => c.id), style: patch }]);
	return (
		<div
			className="flex flex-col gap-1 px-2 py-1 text-pr-small text-pr-muted"
			data-testid="caption-properties"
		>
			{one ? (
				<CaptionTextField
					key={`${one.id}:${captionClipText(doc, one, seq.settings.frameRate)}`}
					text={captionClipText(doc, one, seq.settings.frameRate)}
					speaker={captionClipSpeaker(doc, one, seq.settings.frameRate) ?? ''}
					onCommit={(text, speaker) =>
						apply('Edit Caption', [
							{ type: 'caption.setText', clipId: one.id, text, speaker: speaker || null },
						])
					}
				/>
			) : null}
			<div className="flex flex-wrap items-center gap-1">
				Size
				<TextField
					type="number"
					aria-label="Caption font size"
					className="w-14"
					key={`size-${style.sizePx}`}
					defaultValue={Math.round(style.sizePx)}
					onBlur={(e) => {
						const v = Number(e.currentTarget.value);
						if (Number.isFinite(v) && v >= 4 && v !== style.sizePx) setStyle({ sizePx: v });
					}}
				/>
				<ColorSwatch
					label="Caption color"
					value={[...style.fill] as [number, number, number, number]}
					onChange={(c, ch) => ch.final && setStyle({ fill: c })}
				/>
				<Select
					label="Caption alignment"
					className="w-20"
					value={style.align === 'justify' ? 'center' : style.align}
					onValueChange={(v) => setStyle({ align: v as CaptionStyle['align'] })}
					options={[
						{ value: 'left', label: 'Left' },
						{ value: 'center', label: 'Center' },
						{ value: 'right', label: 'Right' },
					]}
				/>
				<Select
					label="Caption position"
					className="w-20"
					value={style.placement}
					onValueChange={(v) => setStyle({ placement: v as 'bottom' | 'middle' | 'top', linePct: null })}
					options={[
						{ value: 'bottom', label: 'Bottom' },
						{ value: 'middle', label: 'Middle' },
						{ value: 'top', label: 'Top' },
					]}
				/>
			</div>
			<div className="flex gap-1">
				<Button
					variant="quiet"
					onClick={() =>
						apply('Caption Style', [
							{ type: 'caption.setStyle', clipIds: caps.map((c) => c.id), reset: true },
						])
					}
				>
					Reset to Track Style
				</Button>
				<Button
					variant="quiet"
					onClick={() => {
						textPanelRequests.open('captions', caps[0]!.id);
						runtime?.services.get('shell')?.focusPanel('text');
					}}
				>
					Open in Text Panel
				</Button>
			</div>
		</div>
	);
}

function CaptionTextField(p: {
	text: string;
	speaker: string;
	onCommit(text: string, speaker: string): void;
}) {
	const [text, setText] = useState(p.text);
	const [speaker, setSpeaker] = useState(p.speaker);
	const commit = () => (text !== p.text || speaker !== p.speaker) && p.onCommit(text, speaker);
	return (
		<>
			<textarea
				className="w-full resize-none rounded-pr-control border border-pr-border-subtle bg-pr-field px-1 font-pr text-pr-ui text-pr-text outline-none focus:border-pr-focus"
				rows={Math.min(5, Math.max(2, text.split('\n').length))}
				value={text}
				onChange={(e) => setText(e.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(e) => e.stopPropagation()}
				aria-label="Caption text"
				data-testid="caption-properties-text"
			/>
			<TextField
				value={speaker}
				onChange={(e) => setSpeaker(e.currentTarget.value)}
				onBlur={commit}
				placeholder="Speaker"
				aria-label="Speaker"
			/>
		</>
	);
}

clipSections.register({
	id: 'caption',
	title: 'Caption',
	appliesTo: (clips) => clips.length > 0 && clips.every((c) => c.kind === 'captions'),
	component: CaptionSection,
	defaultOpen: true,
	order: 1,
});
