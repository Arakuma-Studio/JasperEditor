// polish (Premiere: File ▸ Get Properties for ▸ Selection, Ctrl+Shift+H): what the selected media files are — path,
// type, size, picture and sound format, duration — read from the project's media records and the engine's location
// of each file. Read-only.
import type { EngineClient } from '@jasper/engine-client';
import { FLICKS_PER_SECOND, type MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Dialog, type HostedDialogProps, registerDialog } from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../../i18n/runtime.ts';
import { mediaKeyOf } from '../../import/assets.ts';

export const MEDIA_PROPERTIES_DIALOG = 'project.mediaProperties';

export type MediaPropertiesProps = {
	session: EditorSession;
	engine: EngineClient;
	mediaIds: string[];
};

function bytes(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n) || n < 0) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = n;
	let u = 0;
	while (v >= 1000 && u < units.length - 1) {
		v /= 1000;
		u++;
	}
	return `${u === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]} (${n.toLocaleString()} bytes)`;
}

function clock(seconds: number): string {
	const s = Math.max(0, seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s - h * 3600 - m * 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${r.toFixed(3).padStart(6, '0')}`;
}

export type MediaFact = { label: string; value: string };

/** The facts of one medium, in the order Premiere's Properties window lists them. */
export function mediaFacts(asset: MediaAsset, path: string | null | undefined): MediaFact[] {
	const out: MediaFact[] = [];
	const add = (label: string, value: string | null | undefined) => {
		if (value) out.push({ label, value });
	};
	const video = asset.probe.streams.find((x) => x.type === 'video');
	const audio = asset.probe.streams.filter((x) => x.type === 'audio');
	add(t('File Path'), path ?? (path === null ? t('Offline') : undefined));
	add(t('Type'), [asset.kind, asset.container].filter(Boolean).join(' · '));
	add(t('File Size'), bytes(asset.sizeBytes));
	if (video && video.type === 'video') {
		const rotated = asset.probe.rotationDegrees === 90 || asset.probe.rotationDegrees === 270;
		add(
			t('Image Size'),
			`${rotated ? video.height : video.width} × ${rotated ? video.width : video.height}${rotated ? ` (rotated ${asset.probe.rotationDegrees}°)` : ''}`,
		);
		if (asset.kind !== 'image' && video.frameRate.den > 0) {
			const fps = video.frameRate.num / video.frameRate.den;
			add(
				t('Frame Rate'),
				`${Number(fps.toFixed(3))} fps${asset.probe.variableFrameRate ? ' (variable)' : ''}`,
			);
		}
		add(
			t('Pixel Aspect Ratio'),
			Number((video.pixelAspect.num / video.pixelAspect.den).toFixed(4)).toString(),
		);
		add(t('Video Codec'), video.codec);
		add(t('Pixel Format'), `${video.pixelFormat} · ${video.bitDepth}-bit`);
		add(
			t('Colour'),
			`${video.color.primaries} / ${video.color.transfer} / ${video.color.matrix} (${video.color.range === 'pc' ? 'full' : 'limited'} range)`,
		);
		if (video.fieldOrder && video.fieldOrder !== 'progressive' && video.fieldOrder !== 'unknown')
			add(
				t('Field Order'),
				video.fieldOrder === 'tt' || video.fieldOrder === 'tb'
					? t('Upper field first')
					: t('Lower field first'),
			);
		add(t('Alpha'), asset.probe.hasAlpha ? t('Yes') : t('No'));
	}
	audio.forEach((a, i) => {
		if (a.type !== 'audio') return;
		add(
			audio.length > 1 ? t('Audio {0}', i + 1) : t('Audio'),
			`${a.sampleRate} Hz · ${a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} channels`}${a.channelLayout ? ` (${a.channelLayout})` : ''} · ${a.codec}`,
		);
	});
	if (asset.probe.durationFlicks !== null && asset.probe.durationFlicks > 0)
		add(t('Total Duration'), clock(asset.probe.durationFlicks / FLICKS_PER_SECOND));
	add(t('Start Timecode'), asset.probe.startTimecode);
	return out;
}

function MediaPropertiesDialog(props: HostedDialogProps<MediaPropertiesProps>) {
	const { session, engine, mediaIds } = props;
	const assets = useMemo(() => {
		const doc = session.getCommitted();
		return mediaIds.map((id) => doc.media[id] as MediaAsset | undefined).filter((a): a is MediaAsset => !!a);
	}, [session, mediaIds]);
	/** media id → path on the engine host (null = offline, absent = not known yet / not exposed). */
	const [paths, setPaths] = useState<Record<string, string | null>>({});
	useEffect(() => {
		let live = true;
		for (const a of assets) {
			const key = mediaKeyOf(a);
			if (!key) continue;
			engine
				.call('mediaLocation', { params: { mediaKey: key } })
				.then((loc) => live && setPaths((p) => ({ ...p, [a.id]: loc.exists ? loc.path : null })))
				.catch(() => undefined);
		}
		return () => {
			live = false;
		};
	}, [engine, assets]);
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Properties"
			size="medium"
			cancelLabel="Close"
			data-testid="media-properties-dialog"
		>
			<div className="flex max-h-[60vh] flex-col gap-4 overflow-auto pr-1">
				{assets.length === 0 ? <p className="text-pr-muted">Nothing selected.</p> : null}
				{assets.map((a) => (
					<section key={a.id} className="flex flex-col gap-1" data-testid="media-properties">
						<h3 className="text-pr-strong" data-no-i18n="">
							{a.originalName}
						</h3>
						<dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-0.5 text-pr-small">
							{mediaFacts(a, paths[a.id]).map((f) => (
								<div key={f.label} className="contents">
									<dt className="text-pr-muted">{f.label}</dt>
									<dd className="min-w-0 break-words pr-tabular select-text" data-no-i18n="">
										{f.value}
									</dd>
								</div>
							))}
						</dl>
					</section>
				))}
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerMediaPropertiesDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(MEDIA_PROPERTIES_DIALOG, MediaPropertiesDialog);
}
