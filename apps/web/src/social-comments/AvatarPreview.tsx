// The small round avatar shown in the `social-avatar` control: a project image (its engine poster), a generated
// avatar (the same `generatedAvatar` description the template draws) or the neutral default silhouette.
import { generatedAvatar } from '@jasper/mg-templates';
import { cx, Icon } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { t } from '../i18n/runtime.ts';

export type AvatarChoice =
	| { kind: 'media'; mediaId: string }
	| { kind: 'generated'; seed: number }
	| { kind: 'default' }
	/** A value the control does not understand (shown as the default; the next pick replaces it). */
	| { kind: 'invalid' };

/** Reads an `avatar` param value without trusting it. */
export function avatarChoice(value: unknown): AvatarChoice {
	if (value === null || value === undefined) return { kind: 'default' };
	if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };
	const v = value as { mediaId?: unknown; generated?: unknown };
	if (typeof v.mediaId === 'string' && v.mediaId) return { kind: 'media', mediaId: v.mediaId };
	if (
		typeof v.generated === 'number' &&
		Number.isInteger(v.generated) &&
		v.generated >= 0 &&
		v.generated <= 0xffff_ffff
	)
		return { kind: 'generated', seed: v.generated };
	return { kind: 'invalid' };
}

const SIZE = 32;

export function AvatarPreview(props: {
	choice: AvatarChoice | null;
	/** Display name for the initials of a generated avatar. */
	name: string;
	/** URLs to try for a media avatar, in order (poster, then the original); empty: not available. */
	imageUrls: readonly string[];
	missing?: boolean;
}) {
	const { choice } = props;
	const [failed, setFailed] = useState(0);
	const urlsKey = props.imageUrls.join('\n');
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new candidate list starts over
	useEffect(() => setFailed(0), [urlsKey]);
	const imageUrl = props.imageUrls[failed] ?? null;
	const ring = 'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full';
	const box = { width: SIZE, height: SIZE };
	if (choice?.kind === 'generated') {
		const g = generatedAvatar(choice.seed, props.name);
		return (
			<span
				className={ring}
				role="img"
				aria-label={t('Generated avatar')}
				// document colours of the generated avatar (data, not UI chrome)
				style={{
					...box,
					background: `linear-gradient(${g.background.angleDeg}deg, ${g.background.from}, ${g.background.to})`,
					color: g.foreground,
				}}
				data-testid="social-avatar-preview"
				data-avatar-kind="generated"
			>
				{g.style === 'initials' ? (
					<span className="font-pr text-pr-ui font-semibold">{g.initials}</span>
				) : (
					<Icon id="media.avatar" size={20} />
				)}
			</span>
		);
	}
	if (choice?.kind === 'media' && imageUrl) {
		return (
			<img
				src={imageUrl}
				alt={t('Avatar image')}
				className={cx(ring, 'object-cover')}
				style={box}
				onError={() => setFailed((n) => n + 1)}
				data-testid="social-avatar-preview"
				data-avatar-kind="media"
			/>
		);
	}
	return (
		<span
			className={cx(
				ring,
				'border border-pr-border-strong bg-pr-field-deep',
				props.missing ? 'text-pr-warning' : 'text-pr-icon',
			)}
			role="img"
			aria-label={
				choice?.kind === 'media'
					? t('Avatar image')
					: choice === null
						? t('Multiple values')
						: t('Default avatar')
			}
			style={box}
			data-testid="social-avatar-preview"
			data-avatar-kind={choice?.kind ?? 'mixed'}
		>
			<Icon id={choice?.kind === 'media' ? 'media.image' : 'media.avatar'} size={18} />
		</span>
	);
}
