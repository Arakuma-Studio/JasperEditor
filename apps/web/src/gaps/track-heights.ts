// Presets address tracks by position, leaving extra tracks unchanged. Presets are global preferences;
// a sequence's current heights belong to its saved view state.
import { clampHeight } from '../panels/timeline/model/layout.ts';

export type TrackHeightPreset = { id: string; name: string; video: number[]; audio: number[] };

const KEY = 'jasper:track-height-presets';
export const MAX_PRESETS = 20;

/** Per-track height choices (track header ▸ Track Height). */
export const TRACK_HEIGHT_SIZES: { id: string; label: string; px: number }[] = [
	{ id: 'minimized', label: 'Minimized', px: 20 },
	{ id: 'small', label: 'Small', px: 32 },
	{ id: 'medium', label: 'Medium', px: 48 },
	{ id: 'large', label: 'Large', px: 72 },
	{ id: 'xlarge', label: 'Extra Large', px: 108 },
	{ id: 'huge', label: 'Huge', px: 160 },
];

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Tolerant parse: drops malformed entries, clamps heights, caps counts. */
export function parsePresets(raw: unknown): TrackHeightPreset[] {
	if (!Array.isArray(raw)) return [];
	const out: TrackHeightPreset[] = [];
	for (const p of raw.slice(0, MAX_PRESETS)) {
		if (!p || typeof p !== 'object') continue;
		const o = p as Record<string, unknown>;
		if (typeof o.id !== 'string' || typeof o.name !== 'string') continue;
		const nums = (v: unknown) =>
			Array.isArray(v)
				? v.slice(0, 99).map((x) => (typeof x === 'number' && Number.isFinite(x) ? clampHeight(x) : 32))
				: [];
		out.push({ id: o.id, name: o.name.slice(0, 60) || 'Preset', video: nums(o.video), audio: nums(o.audio) });
	}
	return out;
}

let cache: TrackHeightPreset[] | null = null;
const listeners = new Set<() => void>();

export const trackHeightPresets = {
	list(): TrackHeightPreset[] {
		if (!cache) {
			try {
				cache = parsePresets(JSON.parse(storage()?.getItem(KEY) ?? '[]'));
			} catch {
				cache = [];
			}
		}
		return cache;
	},
	set(next: TrackHeightPreset[]): void {
		cache = parsePresets(next);
		try {
			storage()?.setItem(KEY, JSON.stringify(cache));
		} catch {
			/* quota / private mode: kept in memory */
		}
		for (const l of [...listeners]) l();
	},
	save(name: string, video: number[], audio: number[]): TrackHeightPreset {
		const list = this.list();
		const existing = list.find((p) => p.name === name);
		const preset: TrackHeightPreset = {
			id: existing?.id ?? `thp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			name: name.trim().slice(0, 60) || 'Preset',
			video: video.map(clampHeight),
			audio: audio.map(clampHeight),
		};
		const next = existing ? list.map((p) => (p.id === existing.id ? preset : p)) : [...list, preset];
		if (next.length > MAX_PRESETS) next.splice(0, next.length - MAX_PRESETS);
		this.set(next);
		return preset;
	},
	rename(id: string, name: string): void {
		this.set(this.list().map((p) => (p.id === id ? { ...p, name: name.trim().slice(0, 60) || p.name } : p)));
	},
	remove(id: string): void {
		this.set(this.list().filter((p) => p.id !== id));
	},
	move(id: string, dir: -1 | 1): void {
		const list = [...this.list()];
		const i = list.findIndex((p) => p.id === id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= list.length) return;
		[list[i], list[j]] = [list[j]!, list[i]!];
		this.set(list);
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

/** The view-state heights a preset gives a sequence (tracks beyond the preset keep their height). */
export function presetHeights(
	preset: Pick<TrackHeightPreset, 'video' | 'audio'>,
	seq: { videoTracks: { id: string }[]; audioTracks: { id: string }[] },
	current: Readonly<Record<string, number>>,
): Record<string, number> {
	const out = { ...current };
	seq.videoTracks.forEach((t, i) => {
		const h = preset.video[i];
		if (h !== undefined) out[t.id] = clampHeight(h);
	});
	seq.audioTracks.forEach((t, i) => {
		const h = preset.audio[i];
		if (h !== undefined) out[t.id] = clampHeight(h);
	});
	return out;
}
