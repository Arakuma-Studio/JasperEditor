// Commands of the text orientation and Warp Text (spec 19 TL-110, TL-111), shared by Properties and the Graphics menu.
import {
	type Clip,
	type Command,
	TEXT_WARP_EFFECT_ID,
	TITLE_LOOK_EFFECT_ID,
	type WarpStyle,
} from '@jasper/project';

type Effects = { effects?: { id: string; effectId: string }[] };

/** The clip's Warp Text instance, if any. */
export function warpEffectOf(c: Clip): { id: string } | null {
	return (c as Effects).effects?.find((e) => e.effectId === TEXT_WARP_EFFECT_ID) ?? null;
}

export const textClipsOf = (clips: readonly Clip[]) =>
	clips.filter((c): c is Extract<Clip, { kind: 'text' }> => c.kind === 'text');

/** Vertical text and a text path exclude each other (`clip.update` refuses): the reason, or null. */
export function verticalDisabledReason(clips: readonly Clip[]): string | null {
	return textClipsOf(clips).some((c) => c.pathOptions)
		? 'Text on a path cannot be vertical. Remove the path first.'
		: null;
}

export function writingModeCommands(clips: readonly Clip[], vertical: boolean): Command[] {
	return textClipsOf(clips).map(
		(c) =>
			({
				type: 'clip.update',
				clipId: c.id,
				patch: { content: { writingMode: vertical ? 'vertical' : 'horizontal' } },
			}) as Command,
	);
}

export function uprightCommands(clips: readonly Clip[], on: boolean): Command[] {
	return textClipsOf(clips).map(
		(c) => ({ type: 'clip.update', clipId: c.id, patch: { content: { tateChuYoko: on } } }) as Command,
	);
}

/**
 * Sets a warp style on every clip, or removes the warp (`null`). A new instance goes straight after the look when the
 * clip has one, so rims bend with the letters and effects the user added keep working on the warped title.
 */
export function warpStyleCommands(clips: readonly Clip[], style: WarpStyle | null): Command[] {
	return clips.flatMap((c): Command[] => {
		const fx = warpEffectOf(c);
		if (style === null) return fx ? [{ type: 'effect.remove', effectInstanceId: fx.id } as Command] : [];
		if (fx) return [{ type: 'param.set', target: ['effect', fx.id, 'style'], value: style } as Command];
		const list = (c as Effects).effects ?? [];
		const look = list.findIndex((e) => e.effectId === TITLE_LOOK_EFFECT_ID);
		return [
			{
				type: 'effect.add',
				target: { clipId: c.id },
				effectId: TEXT_WARP_EFFECT_ID,
				...(look >= 0 ? { index: look + 1 } : {}),
				params: { style },
			} as Command,
		];
	});
}
