// `@jasper/motion/templates` with the asset probe implementation added (test bundle alias).
import { splitEmoji } from '../../../mg-templates/src/emoji.ts';
import { ANIME_TEMPLATE_IMPLS as BASE, EmojiImage, emojiUrlOf } from '../../../motion/src/templates/index.ts';
import type { AnimeTemplateProps } from '../../../motion/src/templates/types.ts';
import { PROBE_FAMILY } from './probe-def.ts';

export * from '../../../motion/src/templates/index.ts';

/** Black text in the declared font and the emoji as pack images, moving with time (frames differ). */
function AssetProbe(p: AnimeTemplateProps) {
	const x = Math.round((p.timeMs / Math.max(1, p.totalMs)) * 120);
	return (
		<div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
			<div
				style={{
					position: 'absolute',
					left: 20 + x,
					top: 120,
					display: 'flex',
					alignItems: 'center',
					fontFamily: `"${PROBE_FAMILY}", monospace`,
					fontWeight: 700,
					fontSize: 96,
					lineHeight: '120px',
					color: '#000000',
					whiteSpace: 'pre',
				}}
			>
				{splitEmoji(String(p.params.title)).map((piece, i) =>
					piece.kind === 'text' ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: static test drawing
						<span key={i}>{piece.text}</span>
					) : (
						<EmojiImage
							// biome-ignore lint/suspicious/noArrayIndexKey: static test drawing
							key={i}
							url={emojiUrlOf(p.emojiUrls, 'apple', piece.grapheme)}
							size={96}
							alt={piece.grapheme}
							pack="apple"
						/>
					),
				)}
			</div>
		</div>
	);
}

export const ANIME_TEMPLATE_IMPLS = Object.freeze({ ...BASE, 'asset-probe@1': AssetProbe });
