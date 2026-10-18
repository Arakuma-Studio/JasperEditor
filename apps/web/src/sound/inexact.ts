// Library sounds registered as they are, not as sample-exact copies (WP6.5b: over 1 h, a copy over the engine's size
// cap, or not enough free disk; final carry-over cleanup, item 3): the editor says so when a sound is added (a warning
// toast), in Properties ▸ Sound (from the media's provenance) and in Sound Check (the INEXACT information).
import type { RegisterSoundResponse } from '@jasper/api';
import { LIBRARY_PAD_MAX_SECONDS, type LibraryInexactReason } from '@jasper/project';
import { toast as uiToast } from '@jasper/ui';
import { t } from '../i18n/runtime.ts';

type Inexact = NonNullable<RegisterSoundResponse['inexact']>;
const mb = (bytes: number) => Math.max(1, Math.ceil(bytes / 1_048_576));
const minutes = (sec: number) => Math.round(sec / 60);

/** Why a sound in the project is not sample-exact (its provenance's reason), for Properties ▸ Sound. */
export function inexactReasonText(reason: LibraryInexactReason): string {
	switch (reason) {
		case 'too-long':
			return t(
				'Not sample-exact: sounds over {0} min are used as they are (placement exact to a frame)',
				minutes(LIBRARY_PAD_MAX_SECONDS),
			);
		case 'too-large':
			return t('Not sample-exact: its sample-exact copy would be too large (placement exact to a frame)');
		default:
			return t(
				'Not sample-exact: there was not enough free disk space for its copy when it was added (placement exact to a frame; add it again to copy it)',
			);
	}
}

/** What the engine said about one registration, with its numbers, in the user's language. */
export function inexactDetail(x: Inexact): string {
	if (x.reason === 'too-long')
		return t(
			'Sounds over {0} min are used as they are: placement is exact to a frame, not to the sample',
			minutes(x.limitSeconds ?? LIBRARY_PAD_MAX_SECONDS),
		);
	if (x.reason === 'too-large')
		return x.bytes !== undefined && x.maxBytes !== undefined
			? t(
					'A sample-exact copy would take {0} MB (at most {1} MB): the sound is used as it is, placement exact to a frame',
					mb(x.bytes),
					mb(x.maxBytes),
				)
			: inexactReasonText('too-large');
	return x.bytes !== undefined && x.freeBytes !== undefined
		? t(
				'Not enough free disk space for a sample-exact copy ({0} MB needed, {1} MB free): the sound is used as it is, placement exact to a frame',
				mb(x.bytes),
				Math.floor(x.freeBytes / 1_048_576),
			)
		: inexactReasonText('disk-space');
}

/**
 * Warns once for the sounds of one registration that are not sample-exact (nothing when all are). Several: one toast
 * naming them, with the first one's reason.
 */
export function noticeInexactSounds(
	sounds: readonly { entry: { id: string; title?: string }; reg: Pick<RegisterSoundResponse, 'inexact' | 'library'> }[],
	toast: typeof uiToast = uiToast,
): void {
	const seen = new Set<string>();
	const hits = sounds.filter((s) => {
		if (!s.reg.inexact || seen.has(s.entry.id)) return false;
		seen.add(s.entry.id);
		return true;
	});
	if (!hits.length) return;
	const name = (s: (typeof hits)[number]) => s.entry.title || s.reg.library.title || s.entry.id;
	toast({
		kind: 'warning',
		title:
			hits.length === 1
				? t('“{0}” is not sample-exact', name(hits[0]!))
				: t('{0} sounds are not sample-exact', hits.length),
		detail:
			hits.length === 1
				? inexactDetail(hits[0]!.reg.inexact!)
				: `${hits
						.slice(0, 3)
						.map((s) => `“${name(s)}”`)
						.join(', ')}${hits.length > 3 ? '…' : ''}: ${inexactDetail(hits[0]!.reg.inexact!)}`,
		dedupeKey: `sound-inexact:${hits.map((s) => s.entry.id).join(',')}`,
		source: 'engine',
	});
}
