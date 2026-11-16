#!/usr/bin/env bash
# Rubber Band Library -> WebAssembly: the Pitch Shifter's optional `rubberband-r3` engine.
#
#   scripts/rubberband-wasm/build.sh [outdir]      default outdir: packages/audio-fx/wasm
#
#   Builds Rubber Band 4 (GPL-2.0-or-later; tag, commit and archive sha256 pinned in manifest.json) from its
#   single-file build (single/RubberBandSingle.cpp: built-in FFT and resampler, no threads, no timing) plus a
#   two-function glue (glue.cpp, GPL-2.0-or-later) into ONE reactor-style wasm32 module, `rubberband.wasm`:
#   no `_start`, only WASI preview1 imports that packages/audio-fx/src/effects/pitch/rubberband.ts stubs, so it
#   loads with a plain WebAssembly.Instance in Node (the engine's mixer) and in the preview's AudioWorklet.
#
#   Licence boundary (AGENTS.md §2): Rubber Band is GPL; it is allowed only inside this separate module, which
#   the application loads at run time and drives through Rubber Band's C API. FFmpeg is never configured with
#   librubberband and the `rubberband` filter is never generated.
#
#   wasi-sdk's libc++ has no C++ exceptions: shim.h (force-included) turns Rubber Band's `throw` statements
#   (allocation failure and programming errors only; the library has no try/catch) into abort(), a trap the host
#   catches. Toolchain: the wasi-sdk pin of scripts/vidstab-wasm/manifest.json, cached (gitignored) in
#   $RUBBERBAND_WASM_CACHE (default vendor/.cache/rubberband-wasm).
#
#   Outputs in <outdir>: rubberband.wasm, RUBBERBAND-WASM.json (pins, flags, sha256 of the .wasm),
#   LICENSE-rubberband.txt (COPYING of the pinned tree), NOTICE-rubberband.txt (source offer and rebuild route).
#
# Environment: RUBBERBAND_WASM_CACHE, RUBBERBAND_SRC (use this Rubber Band tree instead of the pinned archive;
# recorded as "modified"). Needs: bash, curl, tar, node, sha256sum|shasum.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MANIFEST="$HERE/manifest.json"
OUT="${1:-$ROOT/packages/audio-fx/wasm}"
CACHE="${RUBBERBAND_WASM_CACHE:-$ROOT/vendor/.cache/rubberband-wasm}"
mkdir -p "$CACHE" "$OUT"

m() { node -e "let v=require(process.argv[1]);for(const k of process.argv[2].split('.'))v=v[k];process.stdout.write(Array.isArray(v)?v.map((x)=>x+'\n').join(''):String(v))" "$MANIFEST" "$1"; }
sha256() {
	if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
download() {
	if [ -f "$3" ] && [ "$(sha256 "$3")" = "$2" ]; then return; fi
	echo "[rubberband-wasm] downloading $1" >&2
	curl -fsSL -o "$3.partial" "$1"
	local got
	got="$(sha256 "$3.partial")"
	if [ "$got" != "$2" ]; then
		rm -f "$3.partial"
		echo "[rubberband-wasm] sha256 mismatch for $1: $got != $2" >&2
		exit 1
	fi
	mv "$3.partial" "$3"
}

node -e "
const a=require(process.argv[1]), b=require(process.argv[2]);
if (JSON.stringify(a.toolchain)!==JSON.stringify(b.toolchain)) {
  console.error('[rubberband-wasm] manifest.json toolchain differs from scripts/vidstab-wasm/manifest.json'); process.exit(1);
}" "$MANIFEST" "$ROOT/scripts/vidstab-wasm/manifest.json"

case "$(uname -s)-$(uname -m)" in
Linux-x86_64) HOST=linux-x64 ;;
Linux-aarch64 | Linux-arm64) HOST=linux-arm64 ;;
Darwin-x86_64) HOST=darwin-x64 ;;
Darwin-arm64) HOST=darwin-arm64 ;;
MINGW* | MSYS* | CYGWIN*) HOST=win32-x64 ;;
*)
	echo "[rubberband-wasm] unsupported build host $(uname -s)-$(uname -m)" >&2
	exit 1
	;;
esac
TC_URL="$(m "toolchain.hosts.$HOST.url")"
TC_TAR="$CACHE/$(basename "$TC_URL")"
download "$TC_URL" "$(m "toolchain.hosts.$HOST.sha256")" "$TC_TAR"
TC_DIR="$CACHE/$(basename "$TC_URL" .tar.gz)"
if [ ! -x "$TC_DIR/bin/clang++" ] && [ ! -x "$TC_DIR/bin/clang++.exe" ]; then
	echo "[rubberband-wasm] extracting $(basename "$TC_TAR")" >&2
	tar -xzf "$TC_TAR" -C "$CACHE"
fi
CXX="$TC_DIR/bin/clang++"
SYSROOT="$TC_DIR/share/wasi-sysroot"

MODIFIED=false
VERSION="$(m rubberband.version)"
if [ -n "${RUBBERBAND_SRC:-}" ]; then
	SRC="$(cd "$RUBBERBAND_SRC" && pwd)"
	MODIFIED=true
else
	RB_TAR="$CACHE/rubberband-$VERSION.tar.gz"
	download "$(m rubberband.url)" "$(m rubberband.sha256)" "$RB_TAR"
	SRC="$CACHE/rubberband-$VERSION"
	if [ ! -f "$SRC/single/RubberBandSingle.cpp" ]; then
		rm -rf "$SRC"
		tar -xzf "$RB_TAR" -C "$CACHE"
	fi
fi

BUILD="$CACHE/build"
rm -rf "$BUILD"
mkdir -p "$BUILD"
FLAGS=()
while IFS= read -r f; do FLAGS+=("$f"); done < <(m cxxflags)
while IFS= read -r d; do FLAGS+=("-D$d"); done < <(m rubberband.defines)
FLAGS+=("--sysroot=$SYSROOT" "-ffile-prefix-map=$SRC=rubberband" "-ffile-prefix-map=$HERE=glue" "-I$SRC")
LDFLAGS=()
while IFS= read -r f; do LDFLAGS+=("$f"); done < <(m ldflags)
while IFS= read -r e; do LDFLAGS+=("-Wl,--export=$e"); done < <(m exports)
LIBS=()
while IFS= read -r l; do LIBS+=("$l"); done < <(m libs)

echo "[rubberband-wasm] compiling with $("$CXX" --version | head -1)" >&2
"$CXX" "${FLAGS[@]}" -include "$HERE/shim.h" -c "$SRC/$(m rubberband.source)" -o "$BUILD/rubberband.o"
"$CXX" "${FLAGS[@]}" -c "$HERE/glue.cpp" -o "$BUILD/glue.o"
"$CXX" "${FLAGS[@]}" "${LDFLAGS[@]}" "$BUILD/rubberband.o" "$BUILD/glue.o" "${LIBS[@]}" -o "$BUILD/rubberband.wasm"

cp "$BUILD/rubberband.wasm" "$OUT/rubberband.wasm"
chmod 644 "$OUT/rubberband.wasm"
cp "$SRC/COPYING" "$OUT/LICENSE-rubberband.txt"
WASM_SHA="$(sha256 "$OUT/rubberband.wasm")"
node -e "
const fs=require('fs');
const [manifestPath, out, wasmSha, modified, clangVersion]=process.argv.slice(1);
const m=require(manifestPath);
const bytes=fs.readFileSync(out+'/rubberband.wasm');
const mod=new WebAssembly.Module(bytes);
const info={
  file:'rubberband.wasm', sha256:wasmSha, bytes:bytes.length,
  rubberband:{...m.rubberband, modified:modified==='true'},
  glue:{files:['scripts/rubberband-wasm/glue.cpp','scripts/rubberband-wasm/shim.h'],license:'GPL-2.0-or-later'},
  toolchain:{name:m.toolchain.name,version:m.toolchain.version,tag:m.toolchain.tag,clang:clangVersion},
  cxxflags:m.cxxflags, ldflags:m.ldflags, libs:m.libs,
  imports:WebAssembly.Module.imports(mod).map(i=>i.module+'.'+i.name),
  exports:WebAssembly.Module.exports(mod).filter(e=>e.kind==='function').map(e=>e.name),
  rebuild:'scripts/rubberband-wasm/build.sh'
};
fs.writeFileSync(out+'/RUBBERBAND-WASM.json', JSON.stringify(info,null,2)+'\n');
" "$MANIFEST" "$OUT" "$WASM_SHA" "$MODIFIED" "$("$CXX" --version | head -1)"
if [ -x "$ROOT/node_modules/.bin/biome" ]; then
	"$ROOT/node_modules/.bin/biome" format --write "$OUT/RUBBERBAND-WASM.json" >/dev/null 2>&1 || true
fi

cat >"$OUT/NOTICE-rubberband.txt" <<NOTICE
Rubber Band Library in rubberband.wasm
======================================

rubberband.wasm contains the Rubber Band Library by Particular Programs Ltd / Breakfast Quay,
https://github.com/breakfastquay/rubberband, version $VERSION (tag $(m rubberband.tag), commit $(m rubberband.commit)),
licensed under the GNU General Public License version 2 or (at your option) any later version. The licence
text is in LICENSE-rubberband.txt. It is linked with a small glue layer of JasperEditor
(scripts/rubberband-wasm/glue.cpp and shim.h), licensed GPL-2.0-or-later as well.

JasperEditor uses this module only as the optional "Rubber Band R3" engine of its Pitch Shifter effect. The
module is a separate file loaded at run time; the application never compiles Rubber Band into its own code,
and its FFmpeg build does not include librubberband. Using a GPL component here is a deliberate decision of
the project's owner for a privately used editor.

Corresponding source: $(m rubberband.url)
(sha256 $(m rubberband.sha256)) and scripts/rubberband-wasm/ in the JasperEditor sources. Build details and
the sha256 of the shipped module: RUBBERBAND-WASM.json. To rebuild, or to use a modified Rubber Band:

    RUBBERBAND_SRC=/path/to/rubberband scripts/rubberband-wasm/build.sh /some/outdir

and replace rubberband.wasm with the result, or set JASPER_RUBBERBAND_WASM=/some/outdir/rubberband.wasm
for the engine.
NOTICE

echo "[rubberband-wasm] $OUT/rubberband.wasm ($(wc -c <"$OUT/rubberband.wasm") bytes, sha256 $WASM_SHA)" >&2
