// Alpha-channel handling shared by the native export and the proxy generator.
import type { MediaProbe } from '@jasper/project';

type AlphaDecoder = 'libvpx' | 'libvpx-vp9';

/**
 * Decoder override for an input whose alpha the default decoder would drop: VP8/VP9 keep alpha in Matroska
 * BlockAdditions, which FFmpeg's native `vp8`/`vp9` decoders ignore (the layer would cover everything below
 * it with black) and the libvpx wrappers decode. Everything else (ProRes 4444, QuickTime Animation, PNG)
 * already decodes with alpha. Pass it as `-c:v <decoder>` in front of the input.
 */
export function alphaDecoder(
	probe: Pick<MediaProbe, 'hasAlpha' | 'streams'> | null | undefined,
): AlphaDecoder | null {
	if (!probe?.hasAlpha) return null;
	const vs = probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') return null;
	return vs.codec === 'vp9' ? 'libvpx-vp9' : vs.codec === 'vp8' ? 'libvpx' : null;
}
