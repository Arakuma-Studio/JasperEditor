// Export warnings the engine composes, in the UI language (final carry-over cleanup, item 6). The engine sends a stable
// `code`, the values as `params` (`ExportWarningParamsSchema` in @jasper/api lists them per code) and its English
// `message` (for agents, logs and older engines). Known codes with readable params are said here with `t()` — in
// English exactly the engine's words —; anything else (an unknown code, missing or malformed params) shows the engine's
// message as it is (never nothing).
//
// The pattern for every other engine-composed message (planner blockers, job errors): add `params` next to the
// English text in the engine, document them on the schema, and add the code here (or to a sibling table).
import type { ExportWarningParams } from '@jasper/api';
import { t } from '../i18n/runtime.ts';

type Warning = { code: string; message: string; params?: ExportWarningParams | undefined };

const str = (p: ExportWarningParams, k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null);
const num = (p: ExportWarningParams, k: string): number | null =>
	typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : null;

/** The list of titles of a sound warning, with "…" when there are more than shown. */
const titles = (p: ExportWarningParams) => `${str(p, 'titles') ?? ''}${p.more === true ? '…' : ''}`;

function soundText(code: string, p: ExportWarningParams): string | null {
	const n = num(p, 'count');
	const licences = str(p, 'licences');
	if (n === null || n < 1 || licences === null) return null;
	switch (code) {
		case 'W_SOUND_CREDITS':
			return n === 1
				? t(
						'1 sound heard in this export needs a credit ({0}: {1}) and no credits file is written: choose a Credits format or credit it yourself',
						licences,
						titles(p),
					)
				: t(
						'{0} sounds heard in this export need a credit ({1}: {2}) and no credits file is written: choose a Credits format or credit them yourself',
						n,
						licences,
						titles(p),
					);
		case 'W_SOUND_LICENSE_NC':
			return n === 1
				? t('1 sound heard in this export is licensed for non-commercial use only ({0})', licences)
				: t('{0} sounds heard in this export are licensed for non-commercial use only ({1})', n, licences);
		case 'W_SOUND_SHARE_ALIKE':
			return n === 1
				? t(
						'1 sound heard in this export is ShareAlike ({0}: {1}): the video must be shared under CC BY-SA or a compatible licence',
						licences,
						titles(p),
					)
				: t(
						'{0} sounds heard in this export are ShareAlike ({1}: {2}): the video must be shared under CC BY-SA or a compatible licence',
						n,
						licences,
						titles(p),
					);
		default:
			return null;
	}
}

function checkText(p: ExportWarningParams): string | null {
	if (p.state === 'stale')
		switch (p.reason) {
			case 'mix':
				return t(
					'The last Sound Check of this sequence is out of date (the mix changed since): run it again to check what you deliver',
				);
			case 'preset':
				return t(
					'The last Sound Check of this sequence is out of date (the delivery target changed since): run it again to check what you deliver',
				);
			case 'settings':
				return t(
					'The last Sound Check of this sequence is out of date (cues, loudness or credits settings changed since): run it again to check what you deliver',
				);
			default:
				return null;
		}
	if (p.state !== 'failed') return null;
	const errors = num(p, 'errors');
	if (errors === null || errors < 1)
		return t('The last Sound Check of this sequence failed: review its findings before delivering');
	return errors === 1
		? t('The last Sound Check of this sequence failed (1 error): review its findings before delivering')
		: t('The last Sound Check of this sequence failed ({0} errors): review its findings before delivering', errors);
}

function formatText(code: string, p: ExportWarningParams): string | null {
	const requested = str(p, 'requested');
	const written = str(p, 'written');
	if (!requested || !written) return null;
	if (code === 'OUTPUT_CONTAINER_CHANGED') {
		const codec = str(p, 'codec');
		if (p.why === 'codec' && codec && str(p, 'accepts'))
			return t(
				'{0} was requested but {0} does not carry {1} ({0} takes {2}): the file is {3}',
				requested,
				codec,
				str(p, 'accepts'),
				written,
			);
		if (p.why === 'opus')
			return t(
				'{0} was requested but WebM needs Opus audio, which this ffmpeg build lacks: the file is {1}',
				requested,
				written,
			);
		if (p.why === 'muxer' && codec)
			return t('{0} was requested but {1} is written as {2} here: the file is {2}', requested, codec, written);
		return null;
	}
	const container = str(p, 'container');
	if (p.why === 'prores')
		return t('{0} audio was requested but ProRes masters carry PCM audio: the audio is {1}', requested, written);
	if (p.why === 'no-opus')
		return t('{0} audio was requested but this ffmpeg build has no Opus encoder: the audio is {1}', requested, written);
	if (p.why === 'container' && container)
		return requested === 'PCM'
			? t(
					'{0} audio was requested but {1} does not carry {0} audio (PCM needs MOV): the audio is {2}',
					requested,
					container,
					written,
				)
			: requested === 'Opus'
				? t(
						'{0} audio was requested but {1} does not carry {0} audio (Opus needs WebM): the audio is {2}',
						requested,
						container,
						written,
					)
				: t('{0} audio was requested but {1} does not carry {0} audio: the audio is {2}', requested, container, written);
	return null;
}

/** An export warning in the UI language (the engine's English message when it cannot be said from its params). */
export function exportWarningText(w: Warning): string {
	const p = w.params && typeof w.params === 'object' && !Array.isArray(w.params) ? w.params : null;
	if (!p) return w.message;
	const text =
		w.code === 'W_SOUND_CHECK_STALE'
			? checkText(p)
			: w.code === 'OUTPUT_CONTAINER_CHANGED' || w.code === 'AUDIO_CODEC_CHANGED'
				? formatText(w.code, p)
				: soundText(w.code, p);
	return text ?? w.message;
}
