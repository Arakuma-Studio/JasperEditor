#!/usr/bin/env bash
# Short motion-graphics exports through the CLI (wp-note export-performance §16): builds the report's 1080×1350 @ 30
# designs (a photo with an eased push-in and a fade, a two-line "mask-reveal" title; with halftone + noise on the photo
# or not; 2 s and 6 s) in a running engine, then exports each one RUNS times with an empty layer cache and prints the
# wall time, the job's bake / encode phases, the CPU seconds of the engine's process tree and the 1-min load.
#
#   ENGINE_PID=<pid of the engine (its tree is sampled)> apps/engine/bench/mg-export.sh \
#     [--engine-url http://127.0.0.1:47501] [--appdir <its JASPER_APPDIR>] [--image <png>] [--runs 3] [--out <dir>]
#
# Start the engine as `JASPER_APPDIR=<dir> JASPER_DEV=1 JASPER_FFMPEG_LGPL_ONLY=1 pnpm exec tsx apps/engine/src/cli.ts
# --port 47501` from the checkout to measure; before / after = the same run from each checkout, alternately (one
# unmeasured warm-up export after each start). The §16 figures used the report's own 800×1000 photo; the default
# image is the `pnpm fixtures` still. Needs `pnpm mcp:build` (the CLI) and node; emptying the layer cache is the point.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/../../.." && pwd)
URL=http://127.0.0.1:47501 APPDIR=${JASPER_APPDIR:-} IMAGE=$HERE/fixtures/media/still.png RUNS=3 OUT=$(mktemp -d)
while [ $# -gt 0 ]; do
	case $1 in
	--engine-url) URL=$2; shift 2 ;; --appdir) APPDIR=$2; shift 2 ;; --image) IMAGE=$2; shift 2 ;;
	--runs) RUNS=$2; shift 2 ;; --out) OUT=$2; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;;
	esac
done
[ -n "$APPDIR" ] || { echo "--appdir (the engine's JASPER_APPDIR) is required" >&2; exit 2; }
[ -n "${ENGINE_PID:-}" ] || { echo "ENGINE_PID (the engine's process id) is required" >&2; exit 2; }
J() { node "$HERE/apps/mcp/dist/jasper.mjs" --engine-url "$URL" --appdir "$APPDIR" --request-timeout 900 "$@"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s.split("\n")[0]);const r=eval("v"+process.argv[1]);console.log(typeof r==="object"?JSON.stringify(r):r)})' "$1"; }
# CPU seconds of the engine's process tree while a flag file exists: every process is sampled each 0.5 s from /proc and
# counted with its last value (a browser killed with its process group is never reaped into a parent's times).
sample() { # <flag file> → prints CPU seconds when the flag is removed
	node -e '
		const fs = require("fs"); const [root, flag, hz] = [Number(process.argv[1]), process.argv[2], Number(process.argv[3])];
		const snap = () => {
			const kids = new Map(), t = new Map();
			for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
				let s; try { s = fs.readFileSync(`/proc/${p}/stat`, "utf8"); } catch { continue; }
				const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
				t.set(Number(p), Number(f[11]) + Number(f[12]));
				if (!kids.has(Number(f[1]))) kids.set(Number(f[1]), []);
				kids.get(Number(f[1])).push(Number(p));
			}
			const out = new Map(), st = [root];
			while (st.length) { const x = st.pop(); if (t.has(x)) out.set(x, t.get(x)); st.push(...(kids.get(x) ?? [])); }
			return out;
		};
		const start = snap(), last = new Map(start);
		const tick = () => {
			for (const [p, v] of snap()) last.set(p, v);
			if (fs.existsSync(flag)) return setTimeout(tick, 500);
			let sum = 0; for (const [p, v] of last) sum += v - (start.get(p) ?? 0);
			console.log((sum / hz).toFixed(1));
		};
		tick();' "$ENGINE_PID" "$1" "$(getconf CLK_TCK)"
}

design() { # <seconds> <fx 0|1> → project id
	local D=$1 FX=$2 P S M IMG
	P=$(J call create_project name=mg-bench-${D}s-fx${FX} preset=hd-1080p-30 --json | field '.projectId')
	S=$(J --project "$P" call get_project "{\"projectId\":\"$P\"}" --json | field '.sequences[0].sequenceId')
	J --project "$P" exec sequence.updateSettings "{\"sequenceId\":\"$S\",\"settings\":{\"width\":1080,\"height\":1350,\"backgroundColor\":[0.06,0.06,0.08,1]}}" >/dev/null
	M=$(J --project "$P" call import_media "{\"projectId\":\"$P\",\"paths\":[\"$IMAGE\"]}" --json | field '.imported[0].mediaId')
	IMG=$(J --project "$P" call add_clip "{\"projectId\":\"$P\",\"media\":\"$M\",\"at\":0,\"track\":\"V1\",\"sourceIn\":0,\"sourceOut\":$D}" --json | field '.created[0]')
	J --project "$P" call add_text "{\"projectId\":\"$P\",\"text\":\"SOFFY\\nSTUFF\",\"at\":0,\"duration\":\"${D}s\",\"sizePx\":200,\"font\":\"Oswald\",\"position\":[540,1100],\"animateIn\":{\"preset\":\"mask-reveal\",\"durationSeconds\":0.8,\"params\":{\"unit\":\"char\",\"stagger\":0.5,\"ease\":\"outExpo\"}}}" >/dev/null
	echo "{\"label\":\"push-in\",\"commands\":[{\"type\":\"keyframe.add\",\"target\":[\"clip\",\"$IMG\",\"transform\",\"scale\"],\"at\":{\"sequenceFrame\":0},\"value\":120,\"interpolation\":\"bezier\",\"easeOut\":{\"influence\":0.8,\"slope\":0}},{\"type\":\"keyframe.add\",\"target\":[\"clip\",\"$IMG\",\"transform\",\"scale\"],\"at\":{\"sequenceFrame\":45},\"value\":135,\"interpolation\":\"bezier\",\"easeIn\":{\"influence\":0.8,\"slope\":0}},{\"type\":\"keyframe.add\",\"target\":[\"clip\",\"$IMG\",\"opacity\"],\"at\":{\"sequenceFrame\":0},\"value\":0},{\"type\":\"keyframe.add\",\"target\":[\"clip\",\"$IMG\",\"opacity\"],\"at\":{\"sequenceFrame\":12},\"value\":100}]}" | J --project "$P" run - >/dev/null
	if [ "$FX" = 1 ]; then
		J --project "$P" call add_effect "{\"projectId\":\"$P\",\"clipId\":\"$IMG\",\"effectId\":\"jasper.s.half-tone\"}" >/dev/null
		J --project "$P" call add_effect "{\"projectId\":\"$P\",\"clipId\":\"$IMG\",\"effectId\":\"jasper.noise\"}" >/dev/null
	fi
	echo "$P"
}

declare -A PROJECT
for v in "2 0" "2 1" "6 0" "6 1"; do set -- $v; PROJECT["${1}s-fx$2"]=$(design "$1" "$2"); done
echo "# $(nproc) cores, $(date -u +%FT%TZ), engine $URL"
J --project "${PROJECT[2s-fx0]}" export --out "$OUT/warm-up.mp4" --json >/dev/null 2>&1 # browsers, bundle
for run in $(seq 1 "$RUNS"); do
	for v in 2s-fx0 2s-fx1 6s-fx0 6s-fx1; do
		rm -rf "$APPDIR/cache/layers/"*
		L0=$(cut -d' ' -f1 /proc/loadavg); FLAG=$OUT/sampling; touch "$FLAG"
		sample "$FLAG" >"$OUT/$v-$run.cpu" & S=$!
		T0=$(date +%s%N)
		J --project "${PROJECT[$v]}" export --out "$OUT/$v-$run.mp4" --json >"$OUT/$v-$run.json" 2>/dev/null
		T1=$(date +%s%N); rm -f "$FLAG"; wait $S; L1=$(cut -d' ' -f1 /proc/loadavg)
		ph=$(field '.result.timings.phases' <"$OUT/$v-$run.json")
		echo "$v run $run: wall $(((T1 - T0) / 1000000)) ms, cpu $(cat "$OUT/$v-$run.cpu") s, load $L0→$L1, job phases $ph"
	done
done
echo "# outputs in $OUT (compare decoded frames with: ffmpeg -i <file> -map 0:v -f framemd5 -)"
