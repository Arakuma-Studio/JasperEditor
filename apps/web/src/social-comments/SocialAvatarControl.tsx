// `social-avatar`: the profile picture of a social comment — a project image (picker, drop from the Project panel or
// the desktop, Import…), a generated gradient avatar (with Reshuffle) or the platform's default silhouette — plus
// "Randomize identity", which writes a made-up display name, matching handle and generated avatar in ONE undo step
// (a different identity per selected clip).
import { avatarNameFor } from '@jasper/mg-templates';
import { cx, Icon, SegmentedControl } from '@jasper/ui';
import { type DragEvent, useState } from 'react';
import type { TemplateParamControlProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { useEngineOrNull } from '../state/engine.tsx';
import {
	AvatarMediaPicker,
	acceptsAvatarDrag,
	avatarFromDrop,
	avatarImageUrls,
	importAvatarFile,
} from './AvatarMediaPicker.tsx';
import { type AvatarChoice, AvatarPreview, avatarChoice } from './AvatarPreview.tsx';
import { useProjectDocument } from './hooks.ts';
import { identityPatch, randomSeed } from './params.ts';

type Mode = 'image' | 'generated' | 'default';

const modeOf = (c: AvatarChoice | null): Mode | null =>
	c === null ? null : c.kind === 'media' ? 'image' : c.kind === 'generated' ? 'generated' : 'default';

export function SocialAvatarControl(p: TemplateParamControlProps) {
	const doc = useProjectDocument();
	const engine = useEngineOrNull();
	const choice = p.mixed ? null : avatarChoice(p.value);
	const [imageMode, setImageMode] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [over, setOver] = useState(false);
	const mode: Mode | null = choice?.kind === 'media' ? 'image' : imageMode ? 'image' : modeOf(choice);
	const media = doc?.media ?? {};
	const mediaId = choice?.kind === 'media' ? choice.mediaId : null;
	const missing = mediaId !== null && !media[mediaId];
	// the name the card shows (Instagram / YouTube: the handle), so the preview's initials match the card's
	const name = avatarNameFor(p.params.variant, p.params);

	const write = (value: unknown): boolean => {
		const ok = p.onChange(value);
		setMessage(ok ? null : t('The change was refused'));
		return ok;
	};
	const pickMedia = (id: string) => {
		if (id === '') {
			setImageMode(false);
			write(null);
		} else if (write({ mediaId: id })) setImageMode(false);
	};
	const importFile = (file: File) => {
		setImporting(true);
		setMessage(null);
		void importAvatarFile(file, () => doc?.media ?? {}).then((r) => {
			setImporting(false);
			if ('error' in r) setMessage(r.error);
			else pickMedia(r.mediaId);
		});
	};
	const setMode = (m: Mode) => {
		setMessage(null);
		if (m === 'image') setImageMode(true);
		else {
			setImageMode(false);
			write(m === 'generated' ? { generated: randomSeed() } : null);
		}
	};
	const onDrop = (e: DragEvent) => {
		setOver(false);
		// the image picker inside handles its own drops first
		if (e.defaultPrevented || p.disabled || !acceptsAvatarDrag(e.dataTransfer)) return;
		e.preventDefault();
		const r = avatarFromDrop(e.dataTransfer, doc);
		if (!r) return;
		if (r.kind === 'refused') setMessage(r.message);
		else if (r.kind === 'file') importFile(r.file);
		else pickMedia(r.mediaId);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target for Project panel items and image files
		<div
			className={cx(
				'flex w-full min-w-0 flex-col gap-1 rounded-pr-control',
				over && 'outline outline-1 outline-pr-focus',
			)}
			onDragOver={(e) => {
				if (p.disabled || !acceptsAvatarDrag(e.dataTransfer)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = 'copy';
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={onDrop}
			data-social-avatar
			data-testid="social-avatar"
		>
			<div className="flex min-w-0 items-center gap-2">
				<AvatarPreview
					choice={choice}
					name={name}
					imageUrls={avatarImageUrls(media, mediaId, engine ? (k, v) => engine.client.mediaUrl(k, v) : null)}
					missing={missing}
				/>
				<SegmentedControl<Mode>
					label={t('Avatar source')}
					value={mode}
					disabled={p.disabled}
					onChange={setMode}
					options={[
						{
							value: 'image',
							label: t('Image'),
							title: t('A picture from the project'),
							testId: 'social-avatar-mode-image',
						},
						{
							value: 'generated',
							label: t('Generated'),
							title: t('A colour gradient with initials'),
							testId: 'social-avatar-mode-generated',
						},
						{
							value: 'default',
							label: t('Default'),
							title: t("The platform's default picture"),
							testId: 'social-avatar-mode-default',
						},
					]}
				/>
				<span className="ml-auto">
					<MiniButton
						label={t('Randomize Identity')}
						disabled={p.disabled}
						onClick={() => {
							const ok = p.onChangeParams(() => identityPatch(randomSeed()), {
								label: t('Randomize Identity'),
							});
							setMessage(ok ? null : t('The change was refused'));
							if (ok) setImageMode(false);
						}}
						data-testid="social-randomize-identity"
					>
						<Icon id="action.randomIdentity" size={14} />
					</MiniButton>
				</span>
			</div>
			{mode === 'image' && doc ? (
				<AvatarMediaPicker
					doc={doc}
					mediaId={mediaId}
					disabled={p.disabled}
					onPick={pickMedia}
					onImport={importFile}
					onRefused={setMessage}
					importing={importing}
				/>
			) : mode === 'generated' ? (
				<span className="flex min-w-0 items-center gap-1 text-pr-small text-pr-muted">
					<span className="min-w-0 flex-1 truncate">{t('Generated from the name')}</span>
					<MiniButton
						label={t('Reshuffle')}
						disabled={p.disabled}
						onClick={() => write({ generated: randomSeed() })}
						data-testid="social-avatar-reshuffle"
					>
						<Icon id="action.reshuffle" size={13} />
					</MiniButton>
				</span>
			) : mode === 'default' ? (
				<span className="text-pr-small text-pr-muted">
					{choice?.kind === 'invalid'
						? t('Unrecognised value: shown as the default picture')
						: t("The platform's default picture")}
				</span>
			) : (
				<span className="text-pr-small text-pr-muted">{t('Multiple values')}</span>
			)}
			{missing ? (
				<span className="text-pr-small text-pr-warning" data-testid="social-avatar-missing">
					{t('The image is no longer in the project')}
				</span>
			) : null}
			{message ? (
				<span role="alert" className="text-pr-small text-pr-danger" data-testid="social-avatar-message">
					{message}
				</span>
			) : null}
		</div>
	);
}
