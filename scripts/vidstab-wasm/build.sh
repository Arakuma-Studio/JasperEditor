#!/usr/bin/env bash
# vid.stab -> WebAssembly (the cross-platform stabiliser of jasper-proc, spec S07 PST-001..003, D-25).
#
#   scripts/vidstab-wasm/build.sh [outdir]      default outdir: apps/engine/src/processing/proc/vidstab
#
#   Builds libvidstab from the pinned post-relicense commit (LGPL-2.1-or-later, manifest.json `vidstab`,
#   the same pin as scripts/ffmpeg/manifest.json) plus our glue (glue.c, LGPL-2.1-or-later) into ONE
#   reactor-style wasm32 module, `vidstab.wasm`: no `_start`, only a handful of WASI imports that the
#   TypeScript loader (apps/engine/src/processing/proc/vidstab/wasm.ts) stubs, so it loads with a plain
#   WebAssembly.instantiate on Linux, Windows and macOS alike (no native build, no node:wasi).
#
#   Toolchain: wasi-sdk (clang + wasi-libc), version and per-host archive sha256 pinned in manifest.json,
#   downloaded into a gitignored cache ($VIDSTAB_WASM_CACHE, default vendor/.cache/vidstab-wasm). The
#   vid.stab source archive is sha256-verified. LP solver: the builtin interior point solver (GLPK is GPL
#   and never linked); no OpenMP (parallelism comes from several module instances in worker threads).
#   WASM SIMD (-msimd128) is on: vid.stab has no wasm kernels, so glue.c installs wasm_simd128 ports of
#   its SAD/contrast kernels (bit-identical results to the scalar C) and the 16-bit warp is SIMD too.
#
#   Outputs in <outdir>: vidstab.wasm, VIDSTAB-WASM.json (pins, flags, sha256 of the .wasm),
#   LICENSE-vidstab.txt (COPYING.LESSER of the pinned tree), NOTICE-vidstab.txt (the LGPL relinking route).
#
#   LGPL relinking: vidstab.wasm is a separate, replaceable file. Anyone can rebuild it from the
#   corresponding source with this script (or a modified vid.stab: VIDSTAB_SRC=<dir> skips the download)
#   and drop it in place of the shipped file, or point JASPER_VIDSTAB_WASM at it.
#
# Environment: JOBS (parallel compile jobs, default min(cores, 6)), VIDSTAB_WASM_CACHE (download + work
# dir), VIDSTAB_SRC (use this vid.stab tree instead of the pinned archive; recorded as "modified").
# Needs: bash, curl, tar, node, sha256sum|shasum.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MANIFEST="$HERE/manifest.json"
OUT="${1:-$ROOT/apps/engine/src/processing/proc/vidstab}"
CACHE="${VIDSTAB_WASM_CACHE:-$ROOT/vendor/.cache/vidstab-wasm}"
NCPU="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
JOBS="${JOBS:-$((NCPU < 6 ? NCPU : 6))}"
mkdir -p "$CACHE" "$OUT"

m() { node -e "let v=require(process.argv[1]);for(const k of process.argv[2].split('.'))v=v[k];process.stdout.write(Array.isArray(v)?v.map((x)=>x+'\n').join(''):String(v))" "$MANIFEST" "$1"; }
sha256() {
	if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
# download <url> <sha256> <file>
download() {
	if [ -f "$3" ] && [ "$(sha256 "$3")" = "$2" ]; then return; fi
	echo "[vidstab-wasm] downloading $1" >&2
	curl -fsSL -o "$3.partial" "$1"
	local got
	got="$(sha256 "$3.partial")"
	if [ "$got" != "$2" ]; then
		rm -f "$3.partial"
		echo "[vidstab-wasm] sha256 mismatch for $1: $got != $2" >&2
		exit 1
	fi
	mv "$3.partial" "$3"
}

COMMIT="$(m vidstab.commit)"
VS_SHA="$(m vidstab.sha256)"
node -e "
const a=require(process.argv[1]), b=require(process.argv[2]);
if (a.vidstab.commit!==b.vidstab.commit || a.vidstab.sha256!==b.source.packages.vidstab.sha256) {
  console.error('[vidstab-wasm] manifest.json vid.stab pin differs from scripts/ffmpeg/manifest.json'); process.exit(1);
}" "$MANIFEST" "$ROOT/scripts/ffmpeg/manifest.json"

case "$(uname -s)-$(uname -m)" in
Linux-x86_64) HOST=linux-x64 ;;
Linux-aarch64 | Linux-arm64) HOST=linux-arm64 ;;
Darwin-x86_64) HOST=darwin-x64 ;;
Darwin-arm64) HOST=darwin-arm64 ;;
MINGW* | MSYS* | CYGWIN*) HOST=win32-x64 ;;
*)
	echo "[vidstab-wasm] unsupported build host $(uname -s)-$(uname -m)" >&2
	exit 1
	;;
esac
TC_URL="$(m "toolchain.hosts.$HOST.url")"
TC_SHA="$(m "toolchain.hosts.$HOST.sha256")"
TC_TAR="$CACHE/$(basename "$TC_URL")"
download "$TC_URL" "$TC_SHA" "$TC_TAR"
TC_DIR="$CACHE/$(basename "$TC_URL" .tar.gz)"
if [ ! -x "$TC_DIR/bin/clang" ] && [ ! -x "$TC_DIR/bin/clang.exe" ]; then
	echo "[vidstab-wasm] extracting $(basename "$TC_TAR")" >&2
	tar -xzf "$TC_TAR" -C "$CACHE"
fi
CC="$TC_DIR/bin/clang"
SYSROOT="$TC_DIR/share/wasi-sysroot"

MODIFIED=false
if [ -n "${VIDSTAB_SRC:-}" ]; then
	SRC="$(cd "$VIDSTAB_SRC" && pwd)"
	MODIFIED=true
else
	VS_TAR="$CACHE/vid.stab-$COMMIT.tar.gz"
	download "$(m vidstab.url)" "$VS_SHA" "$VS_TAR"
	SRC="$CACHE/vid.stab-$COMMIT"
	if [ ! -f "$SRC/src/libvidstab.c" ]; then
		rm -rf "$SRC"
		tar -xzf "$VS_TAR" -C "$CACHE"
	fi
fi

BUILD="$CACHE/build"
rm -rf "$BUILD"
mkdir -p "$BUILD/obj"
# libvidstab_version.h from version.cmake (what CMake's configure_file does)
MAJ="$(sed -n 's/^set(MAJOR_VERSION \([0-9]*\)).*/\1/p' "$SRC/version.cmake")"
MIN="$(sed -n 's/^set(MINOR_VERSION \([0-9]*\)).*/\1/p' "$SRC/version.cmake")"
PAT="$(sed -n 's/^set(PATCH_VERSION \([0-9]*\)).*/\1/p' "$SRC/version.cmake")"
sed -e "s/@MAJOR_VERSION@/$MAJ/g" -e "s/@MINOR_VERSION@/$MIN/g" -e "s/@PATCH_VERSION@/$PAT/g" \
	"$SRC/src/libvidstab_version.h.in" >"$BUILD/libvidstab_version.h"

CFLAGS=()
while IFS= read -r f; do CFLAGS+=("$f"); done < <(m cflags)
while IFS= read -r d; do CFLAGS+=("-D$d"); done < <(m vidstab.defines)
# reproducible: no build paths in the output (asserts are off via NDEBUG; this covers the rest)
CFLAGS+=("--sysroot=$SYSROOT" "-ffile-prefix-map=$SRC=vid.stab" "-ffile-prefix-map=$HERE=glue" "-I$SRC/src" "-I$BUILD")
LDFLAGS=()
while IFS= read -r f; do LDFLAGS+=("$f"); done < <(m ldflags)

SOURCES=()
while IFS= read -r s; do SOURCES+=("$SRC/src/$s"); done < <(m vidstab.sources)
SOURCES+=("$HERE/glue.c")

echo "[vidstab-wasm] compiling ${#SOURCES[@]} files with $("$CC" --version | head -1) (jobs $JOBS)" >&2
export CC BUILD
printf '%s\n' "${SOURCES[@]}" | xargs -P "$JOBS" -I{} sh -c '
	src="$1"; shift
	obj="$BUILD/obj/$(basename "$src" .c).o"
	"$CC" "$@" -c "$src" -o "$obj"
' _ {} "${CFLAGS[@]}"

"$CC" "${CFLAGS[@]}" "${LDFLAGS[@]}" "$BUILD"/obj/*.o -o "$BUILD/vidstab.wasm"

cp "$BUILD/vidstab.wasm" "$OUT/vidstab.wasm"
chmod 644 "$OUT/vidstab.wasm"
cp "$SRC/COPYING.LESSER" "$OUT/LICENSE-vidstab.txt"
WASM_SHA="$(sha256 "$OUT/vidstab.wasm")"
node -e "
const fs=require('fs');
const [manifestPath, out, wasmSha, modified, clangVersion]=process.argv.slice(1);
const m=require(manifestPath);
const bytes=fs.readFileSync(out+'/vidstab.wasm');
const mod=new WebAssembly.Module(bytes);
const info={
  file:'vidstab.wasm',
  sha256:wasmSha,
  bytes:bytes.length,
  vidstab:{repository:m.vidstab.repository,commit:m.vidstab.commit,commitDate:m.vidstab.commitDate,version:m.vidstab.version,
    license:m.vidstab.license,archive:m.vidstab.url,archiveSha256:m.vidstab.sha256,modified:modified==='true',
    lpSolver:'builtin (interior point)',openmp:false,sources:m.vidstab.sources,defines:m.vidstab.defines},
  glue:{file:'scripts/vidstab-wasm/glue.c',license:'LGPL-2.1-or-later'},
  toolchain:{name:m.toolchain.name,version:m.toolchain.version,tag:m.toolchain.tag,clang:clangVersion,
    archives:m.toolchain.hosts},
  cflags:m.cflags,ldflags:m.ldflags,simd:m.cflags.includes('-msimd128'),
  imports:WebAssembly.Module.imports(mod).map(i=>i.module+'.'+i.name),
  exports:WebAssembly.Module.exports(mod).filter(e=>e.kind==='function').map(e=>e.name),
  rebuild:'scripts/vidstab-wasm/build.sh'
};
fs.writeFileSync(out+'/VIDSTAB-WASM.json', JSON.stringify(info,null,2)+'\n');
" "$MANIFEST" "$OUT" "$WASM_SHA" "$MODIFIED" "$("$CC" --version | head -1)"

# keep the committed JSON in the repository's formatting (best effort: biome is a dev dependency)
if [ -x "$ROOT/node_modules/.bin/biome" ]; then
	"$ROOT/node_modules/.bin/biome" format --write "$OUT/VIDSTAB-WASM.json" >/dev/null 2>&1 || true
fi

cat >"$OUT/NOTICE-vidstab.txt" <<EOF
vid.stab (libvidstab) in vidstab.wasm
=====================================

vidstab.wasm contains libvidstab, the video stabilisation library by Georg Martius and contributors,
https://github.com/georgmartius/vid.stab, commit $COMMIT (version $(m vidstab.version)),
licensed under the GNU Lesser General Public License version 2.1 or (at your option) any later version
(relicensed from GPL in August 2026: RELICENSE.md and issue #165 upstream). The licence text is in
LICENSE-vidstab.txt. It is linked with a small glue layer of JasperEditor (scripts/vidstab-wasm/glue.c),
licensed LGPL-2.1-or-later as well.

Corresponding source: $(m vidstab.url)
(sha256 $VS_SHA) and scripts/vidstab-wasm/ in the JasperEditor sources. Build details and the sha256 of
the shipped module: VIDSTAB-WASM.json.

Replacing the library (LGPL section 6): vidstab.wasm is a separate file that JasperEditor loads at run time;
nothing of it is compiled into the application. To use a modified vid.stab, rebuild the module with

    VIDSTAB_SRC=/path/to/your/vid.stab scripts/vidstab-wasm/build.sh /some/outdir

and either replace vidstab.wasm next to jasper-proc.mjs with the result or set the environment variable
JASPER_VIDSTAB_WASM=/some/outdir/vidstab.wasm. The module interface is the vsx_* functions of glue.c.
EOF

echo "[vidstab-wasm] $OUT/vidstab.wasm ($(wc -c <"$OUT/vidstab.wasm") bytes, sha256 $WASM_SHA)" >&2
