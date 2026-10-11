// Track mattes (wp masks): a Track Matte Key reads another video track's composite at the same sequence frame.
//
// - Every clip of a matte track runs its layer through the fx chain (like a GPU-transition side) with a final
//   `matte tap` step: the finished picture (effects, masks, crop) + its placement (layer map, opacity) go to the
//   track's `TrackMatteHub`; the step passes the picture through (a visible matte track still draws), or clears it
//   for matte-only tracks (hidden tracks, `RenderSnapshot.matteTracks`).
// - The hub composites the pictures of one sequence frame into a sequence-sized canvas on the fx GPU host
//   (premultiplied "over", V1 → top order of the track's clips, projective placement with antialiased edges).
// - Fill layers bind it as a media input (`track:<trackId>`, `useTrackMattes`): renders hold a delayRender until
//   every clip of the matte track drew this exact frame (deterministic in any frame order); the Player shows the
//   latest composite.
import { matteClipsAt, type RenderSnapshot, type RenderVisualClip } from '@jasper/project';
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { continueRender, createEffect, delayRender, getRemotionEnvironment } from 'remotion';
import {
	compileShader,
	ensureCanvas,
	type FxHost,
	type FxTextureInput,
	fxHost,
	texture2d,
	upload,
} from './host.ts';

export type MatteTapMeta = {
	/** Sequence px → picture px (row-major 3×3), null = not placed (degenerate map). */
	compToCanvas: readonly number[] | null;
	opacity: number;
	/** Sequence frame the picture shows. */
	frame: number;
};

/** Where a matte track's clip delivers its finished picture. */
export type MatteTap = {
	readonly clipId: string;
	deliver(picture: CanvasImageSource, width: number, height: number, meta: MatteTapMeta): void;
};

type Picture = { canvas: HTMLCanvasElement; width: number; height: number; meta: MatteTapMeta };

/** Kinds whose layers run the fx chain (and so deliver a matte picture). */
const TAP_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'animated-image',
	'solid',
	'composition',
	'text',
	'shape',
	'motion-graphic',
]);

/** The pictures of one matte track and their composite. */
export class TrackMatteHub {
	private readonly pictures = new Map<string, Picture>();
	private readonly taps = new Map<string, MatteTap>();
	private readonly listeners = new Set<() => void>();
	private clips: readonly RenderVisualClip[] = [];
	private media: Readonly<RenderSnapshot['media']> = {};
	private composite: { canvas: HTMLCanvasElement; frame: number; version: number } | null = null;
	private version = 0;

	constructor(
		readonly trackId: string,
		private readonly size: { width: number; height: number },
	) {}

	/** The track's clips (bottom → top order is the track order) and the snapshot's media (offline = no picture). */
	setClips(clips: readonly RenderVisualClip[], media: Readonly<RenderSnapshot['media']>): void {
		this.clips = clips;
		this.media = media;
	}

	tap(clipId: string): MatteTap {
		const hit = this.taps.get(clipId);
		if (hit) return hit;
		const t: MatteTap = { clipId, deliver: (p, w, h, meta) => this.deliver(clipId, p, w, h, meta) };
		this.taps.set(clipId, t);
		return t;
	}

	subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};

	getVersion = (): number => this.version;

	/** The clips that must deliver for frame `f` (those whose layer draws a chain picture). */
	expected(f: number): RenderVisualClip[] {
		return matteClipsAt(this.clips, f).filter((c) => {
			if (!TAP_KINDS.has(c.kind) || c.baked) return false;
			const src = c.source as { mediaId?: string };
			return !src.mediaId || !!this.media[src.mediaId];
		});
	}

	/** The composite of frame `f` (renders: only when complete for exactly that frame; `latest`: whatever is there). */
	pictureAt(f: number, latest: boolean): { canvas: HTMLCanvasElement; version: number } | null {
		if (!latest && !this.ready(f)) return null;
		if (!this.composite || (!latest && this.composite.frame !== f)) this.recomposite(f);
		return this.composite ? { canvas: this.composite.canvas, version: this.composite.version } : null;
	}

	/** Every expected clip delivered a picture of frame `f`. */
	ready(f: number): boolean {
		return this.expected(f).every((c) => this.pictures.get(c.clipId)?.meta.frame === f);
	}

	private deliver(
		clipId: string,
		picture: CanvasImageSource,
		width: number,
		height: number,
		meta: MatteTapMeta,
	) {
		const prev = this.pictures.get(clipId);
		const canvas = prev?.canvas ?? document.createElement('canvas');
		const w = Math.max(1, Math.round(width));
		const h = Math.max(1, Math.round(height));
		if (canvas.width !== w) canvas.width = w;
		if (canvas.height !== h) canvas.height = h;
		const ctx = canvas.getContext('2d')!;
		ctx.globalCompositeOperation = 'copy';
		ctx.drawImage(picture, 0, 0, w, h);
		ctx.globalCompositeOperation = 'source-over';
		this.pictures.set(clipId, { canvas, width: w, height: h, meta });
		this.recomposite(meta.frame);
		for (const l of this.listeners) l();
	}

	private recomposite(f: number): void {
		const h = fxHost();
		if (!h) return;
		const layers = matteClipsAt(this.clips, f)
			.map((c) => this.pictures.get(c.clipId))
			.filter((p): p is Picture => !!p);
		const canvas = this.composite?.canvas ?? document.createElement('canvas');
		compositeMatte(h, layers, this.size, canvas);
		this.composite = { canvas, frame: f, version: ++this.version };
	}
}

const PLACE_SHADER = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_pic;
uniform mat3 u_place;
uniform vec2 u_picSize;
uniform vec2 u_size;
uniform float u_opacity;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec3 q = u_place * vec3(p, 1.0);
  float w = abs(q.z) < 1e-6 ? 1e-6 : q.z;
  vec2 c = q.xy / w;
  vec2 fw = max(fwidth(c), vec2(1e-4));
  vec2 e = min(c, u_picSize - c) / fw;
  float cover = clamp(e.x + 0.5, 0.0, 1.0) * clamp(e.y + 0.5, 0.0, 1.0);
  vec4 s = texture(u_pic, c / u_picSize);
  fragColor = q.z > 1e-6 ? s * (cover * u_opacity) : vec4(0.0);
}
`;

type PlaceGl = { program: WebGLProgram; tex: WebGLTexture; locs: Map<string, WebGLUniformLocation | null> };
const placePrograms = new WeakMap<FxHost, PlaceGl>();

function placeGl(h: FxHost): PlaceGl {
	const hit = placePrograms.get(h);
	if (hit) return hit;
	const { gl } = h;
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, PLACE_SHADER);
	if (typeof fs === 'string') throw new Error(`FX_SHADER_ERROR: track matte composite: ${fs}`);
	const p = gl.createProgram()!;
	gl.attachShader(p, h.vs);
	gl.attachShader(p, fs);
	gl.bindAttribLocation(p, 0, 'a_pos');
	gl.linkProgram(p);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
		throw new Error(`FX_SHADER_ERROR: track matte composite: ${gl.getProgramInfoLog(p) ?? 'link error'}`);
	const out: PlaceGl = { program: p, tex: texture2d(gl, gl.LINEAR), locs: new Map() };
	placePrograms.set(h, out);
	return out;
}

/** Composites matte pictures (premultiplied over, in order) into a `size` canvas. */
function compositeMatte(
	h: FxHost,
	layers: readonly Picture[],
	size: { width: number; height: number },
	out: HTMLCanvasElement,
): void {
	const { width: W, height: H } = size;
	if (out.width !== W) out.width = W;
	if (out.height !== H) out.height = H;
	const ctx = out.getContext('2d')!;
	ctx.clearRect(0, 0, W, H);
	if (layers.length === 0) return;
	const { gl } = h;
	if (h.lost || gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE: the fx GPU context is lost');
	const g = placeGl(h);
	const loc = (n: string) => {
		if (!g.locs.has(n)) g.locs.set(n, gl.getUniformLocation(g.program, n));
		return g.locs.get(n)!;
	};
	ensureCanvas(h, W, H);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, W, H);
	gl.disable(gl.DEPTH_TEST);
	gl.enable(gl.SCISSOR_TEST);
	gl.scissor(0, 0, W, H);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	gl.disable(gl.SCISSOR_TEST);
	gl.enable(gl.BLEND);
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(g.program);
	for (const l of layers) {
		const m = l.meta.compToCanvas;
		if (!m || !(l.meta.opacity > 0)) continue;
		upload(h, g.tex, l.canvas);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, g.tex);
		gl.uniform1i(loc('u_pic'), 0);
		// Row-major → GLSL column-major.
		gl.uniformMatrix3fv(loc('u_place'), false, [
			m[0]!,
			m[3]!,
			m[6]!,
			m[1]!,
			m[4]!,
			m[7]!,
			m[2]!,
			m[5]!,
			m[8]!,
		]);
		gl.uniform2f(loc('u_picSize'), l.width, l.height);
		gl.uniform2f(loc('u_size'), W, H);
		gl.uniform1f(loc('u_opacity'), Math.min(1, Math.max(0, l.meta.opacity)));
		const fl = loc('u_flipY');
		if (fl) gl.uniform1f(fl, 1);
		gl.bindVertexArray(h.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
	}
	gl.disable(gl.BLEND);
	ctx.globalCompositeOperation = 'copy';
	ctx.drawImage(h.canvas, 0, h.canvas.height - H, W, H, 0, 0, W, H);
	ctx.globalCompositeOperation = 'source-over';
}

/** trackId → hub, for the fill layers (provided by the composition). */
export const TrackMatteContext = createContext<ReadonlyMap<string, TrackMatteHub>>(new Map());

/** Media id under which a track matte is bound to a Track Matte Key's `u_matte`. */
export const trackMatteMediaId = (trackId: string) => `track:${trackId}`;

/**
 * The track-matte pictures a stage binds (`track:<id>` media inputs) at sequence frame `seqFrame`. Re-renders when a
 * hub composites; renders hold a delayRender until every needed matte is complete for this frame.
 */
export function useTrackMattes(
	trackIds: readonly string[],
	seqFrame: number,
): { media: Map<string, FxTextureInput>; key: string } {
	const hubs = useContext(TrackMatteContext);
	const rendering = getRemotionEnvironment().isRendering;
	const trackKey = trackIds.join('\n');
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the track ids' content, not the array identity
	const list = useMemo(
		() => trackIds.map((id) => hubs.get(id)).filter((h): h is TrackMatteHub => !!h),
		[hubs, trackKey],
	);
	const subscribe = useMemo(
		() => (cb: () => void) => {
			const offs = list.map((h) => h.subscribe(cb));
			return () => {
				for (const o of offs) o();
			};
		},
		[list],
	);
	const version = useSyncExternalStore(
		subscribe,
		() => list.map((h) => h.getVersion()).join(','),
		() => '',
	);
	const media = new Map<string, FxTextureInput>();
	let complete = true;
	for (const h of list) {
		const pic = h.pictureAt(seqFrame, !rendering);
		if (!pic) {
			complete = false;
			continue;
		}
		media.set(trackMatteMediaId(h.trackId), {
			source: pic.canvas,
			width: pic.canvas.width,
			height: pic.canvas.height,
			version: `${h.trackId}:${pic.version}`,
		});
	}
	// Renders: hold the frame until the mattes of this frame are complete (the chain's own draw then holds it until
	// it drew with them: its layout effect runs before this passive effect releases).
	const hold = useRef<number | null>(null);
	if (rendering && !complete && hold.current === null)
		hold.current = delayRender(`Track matte (${trackIds.join(', ')}) at frame ${seqFrame}`);
	useEffect(() => {
		if (complete && hold.current !== null) {
			continueRender(hold.current);
			hold.current = null;
		}
	});
	useEffect(
		() => () => {
			if (hold.current !== null) continueRender(hold.current);
		},
		[],
	);
	return { media, key: `${version}|${[...media.values()].map((m) => m.version).join(',')}` };
}

export type FxMatteTapParams = { key: string; tap: MatteTap; meta: MatteTapMeta; hide: boolean };

/** Hands the finished layer picture to its matte track's hub; passes it through (or clears it: matte-only). */
export const fxMatteTap = createEffect<FxMatteTapParams, null>({
	type: 'jasper.fx-matte-tap',
	label: 'Track matte source (fx chain)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p?.tap) throw new Error('fxMatteTap needs {key, tap, meta}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		params.tap.deliver(source as CanvasImageSource, width, height, params.meta);
		const ctx = target.getContext('2d')!;
		ctx.clearRect(0, 0, width, height);
		if (!params.hide) ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
	},
	cleanup: () => {},
});
