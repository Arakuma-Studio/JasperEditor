// social-comment@1 (social-comment design 2026-10-25 §7): one card per clip, its look chosen by `variant`
// (variants.ts → the per-platform cards), entering with the chosen entrance, optionally revealing its words one by
// one and ticking its like count up, and leaving with a short scale-down and fade. The timing is the shared schedule
// of @jasper/mg-templates (`socialCommentSchedule`, also the sound-design motion model's), built as paused anime.js
// timelines and seeked canonically per frame (S11:ANM-002/004): every frame is a pure function of the params and the
// content time.
import {
	resolveEmojiStyle,
	type SocialCommentParams,
	type SocialScheduleInput,
	socialCommentParamsSchema,
	socialCommentSchedule,
	socialCommentSegments,
	socialLikesTick,
	socialTickCount,
} from '@jasper/mg-templates';
import { useId, useMemo } from 'react';
import { useAnimeValues } from '../../runtime/index.ts';
import { DesignStage, templateFit } from '../common.tsx';
import type { AnimeTemplateProps } from '../types.ts';
import { socialAssetUrls } from './assets.tsx';
import { buildSocialComment, buildSocialTick, socialTickProgressAt } from './build.ts';
import type { SocialCardAnim, SocialCardAssets, SocialWordValues } from './contract.ts';
import { SocialStage } from './stage.tsx';
import { SOCIAL_VARIANT_IMPLS } from './variants.ts';

export type { SocialCardAnim, SocialCardAssets, SocialCardProps, SocialVariantImpl } from './contract.ts';
export { buildSocialComment, buildSocialTick, socialTickProgressAt } from './build.ts';

const DEFAULTS = socialCommentParamsSchema.parse({});

/** Params of a clip: the layer hands them parsed; anything else falls back to the defaults instead of throwing. */
function paramsOf(raw: Record<string, unknown>): SocialCommentParams {
	const parsed = socialCommentParamsSchema.safeParse(raw);
	return parsed.success ? parsed.data : DEFAULTS;
}

export function SocialComment(props: AnimeTemplateProps) {
	const p = paramsOf(props.params);
	const fit = templateFit(props.canvas);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the text and variant it reads
	const text = useMemo(() => socialCommentSegments(p.text, p.variant), [p.text, p.variant]);
	const tick = socialLikesTick(p);
	const input: SocialScheduleInput = {
		totalMs: props.totalMs,
		introMs: props.introMs,
		outroMs: props.outroMs,
		entrance: p.entrance,
		units: p.wordReveal ? text.units : 0,
		tick,
	};
	const buildKey = `social-comment@1|${JSON.stringify(input)}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by buildKey (it holds the whole input)
	const schedule = useMemo(() => socialCommentSchedule(input), [buildKey]);
	const values = useAnimeValues(buildKey, () => buildSocialComment(schedule), props.timeMs);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by buildKey
	const tickTimeline = useMemo(() => (schedule.tick ? buildSocialTick(schedule.tick) : null), [buildKey]);
	const progress = tickTimeline ? socialTickProgressAt(tickTimeline, props.timeMs) : 1;
	const anim: SocialCardAnim = {
		words: schedule.units > 0 ? (values.slice(1, 1 + schedule.units) as SocialWordValues[]) : null,
		likes: tick ? socialTickCount(p.likes, progress) : p.likes,
		heart:
			schedule.heartTarget !== null
				? (values[schedule.heartTarget] as Readonly<{ s: number; f: number }>)
				: null,
	};
	const scope = useId().replace(/[^A-Za-z0-9_-]/g, '_');
	const assets: SocialCardAssets = {
		...socialAssetUrls(props as Parameters<typeof socialAssetUrls>[0]),
		emojiPack: resolveEmojiStyle(p.variant, p.emojiStyle),
		idScope: `sc${scope}`,
	};
	const impl = SOCIAL_VARIANT_IMPLS[p.variant];
	const { entrance: _e, wordReveal: _w, likeTick: _l, likes: _n, ...layout } = p;
	return (
		<DesignStage fit={fit} label="social-comment@1">
			<SocialStage
				fit={fit}
				layoutKey={JSON.stringify(layout)}
				card={values[0]!}
				origin={p.entrance === 'grow-from-tail' ? impl.growOrigin : '50% 50%'}
			>
				<impl.Card params={p} text={text} anim={anim} assets={assets} />
			</SocialStage>
		</DesignStage>
	);
}
