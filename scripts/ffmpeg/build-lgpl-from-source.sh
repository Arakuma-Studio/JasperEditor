#!/usr/bin/env bash
# Reproducible LGPL FFmpeg 7.1 build from pinned sources (ARCHITECTURE D-13, docs/wp-notes/wp-lgpl.md).
# The only way to get an LGPL build for macOS (there is no BtbN macOS build); also works on Linux.
# Called by `pnpm ffmpeg:lgpl --from-source` (default on macOS):
#
#   build-lgpl-from-source.sh <workdir> <prefix>
#
# Needs: a C/C++ toolchain (Xcode command line tools on macOS), make, cmake, pkg-config, curl, tar, node.
# nasm is built from source for x86_64. Dependencies are built as static PIC archives and folded into the
# shared libav* libraries, so the result only depends on system libraries (libc, libm, zlib, frameworks).
#
# FFmpeg is configured WITHOUT --enable-gpl, --enable-nonfree and --enable-version3 (→ LGPL-2.1-or-later):
#   encoders: libopenh264 (H.264), libvpx (VP8/VP9), libsvtav1 (AV1), libopus, native aac, prores_ks, png
#   filters:  vidstabdetect/vidstabtransform from libvidstab built from the pinned post-relicense commit
#             (LGPL-2.1-or-later since August 2026, manifest.json `vidstab`); FFmpeg 7.1's configure still
#             lists libvidstab as GPL, so patches/configure-libvidstab-lgpl.patch moves it to the plain
#             external library list (FFmpeg's own vf_vidstab*.c / vidstabutils.c are LGPL-2.1+). The pin is
#             recorded in <prefix>/share/jasper/libvidstab.json and ends up in BUILDINFO.json, which
#             check-lgpl.mjs requires before it accepts --enable-libvidstab.
#   shared libraries with the Remotion 4.0.499 ABI (libavcodec 61, libavformat 61, libavutil 59, …)
#   Linux: ffmpeg/ffprobe get a placeholder RPATH that the assembly step rewrites to $ORIGIN;
#   macOS: install names @rpath/…, rpath @loader_path.
#
# Environment: JOBS (parallel jobs), SKIP_SVTAV1=1 (no AV1 encoder), SKIP_VIDSTAB=1 (no vid.stab: the
# engine then stabilises with deshake).
set -euo pipefail

WORK="${1:?usage: build-lgpl-from-source.sh <workdir> <prefix>}"
PREFIX="${2:?usage: build-lgpl-from-source.sh <workdir> <prefix>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$HERE/manifest.json"
OS="$(uname -s)"
ARCH="$(uname -m)"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}"
DEPS="$WORK/deps"
TOOLS="$WORK/tools"
mkdir -p "$WORK/dl" "$WORK/src" "$DEPS" "$TOOLS/bin"
export PATH="$TOOLS/bin:$PATH"
export PKG_CONFIG_PATH="$DEPS/lib/pkgconfig:$DEPS/lib64/pkgconfig"
export CFLAGS="-O2 -fPIC ${CFLAGS:-}"
export CXXFLAGS="-O2 -fPIC ${CXXFLAGS:-}"
if [ "$OS" = "Darwin" ]; then
	export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
fi

pin() { node -e "const m=require(process.argv[1]).source.packages[process.argv[2]];process.stdout.write(m[process.argv[3]])" "$MANIFEST" "$1" "$2"; }

sha256() {
	if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch <name>: downloads the pinned tarball, verifies sha256, extracts to $WORK/src/<name>; prints the dir.
fetch() {
	local name="$1" url sum file dir
	url="$(pin "$name" url)"
	sum="$(pin "$name" sha256)"
	file="$WORK/dl/$name-$(basename "$url")"
	if [ ! -f "$file" ] || [ "$(sha256 "$file")" != "$sum" ]; then
		echo "[source] downloading $url" >&2
		curl -fsSL -o "$file.partial" "$url"
		mv "$file.partial" "$file"
	fi
	if [ "$(sha256 "$file")" != "$sum" ]; then
		echo "[source] checksum mismatch for $url (expected $sum)" >&2
		exit 1
	fi
	dir="$WORK/src/$name"
	rm -rf "$dir" && mkdir -p "$dir"
	tar -xf "$file" -C "$dir" --strip-components=1
	echo "$dir"
}

stamp() { [ -f "$WORK/.done-$1" ]; }
done_() { touch "$WORK/.done-$1"; }

X86=0
case "$ARCH" in x86_64 | amd64) X86=1 ;; esac

if [ "$X86" = 1 ] && ! stamp nasm; then
	d="$(fetch nasm)"
	(cd "$d" && ./configure --prefix="$TOOLS" >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
	done_ nasm
fi

if ! stamp opus; then
	d="$(fetch opus)"
	(cd "$d" && ./configure --prefix="$DEPS" --disable-shared --enable-static --with-pic --disable-doc \
		--disable-extra-programs >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
	done_ opus
fi

if ! stamp libvpx; then
	d="$(fetch libvpx)"
	vpx_as=()
	[ "$X86" = 1 ] && vpx_as=(--as=nasm)
	(cd "$d" && ./configure --prefix="$DEPS" --disable-shared --enable-static --enable-pic "${vpx_as[@]}" \
		--disable-examples --disable-tools --disable-docs --disable-unit-tests --enable-vp9-highbitdepth \
		>/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
	done_ libvpx
fi

if ! stamp openh264; then
	d="$(fetch openh264)"
	(cd "$d" && make -j"$JOBS" PREFIX="$DEPS" BUILDTYPE=Release install-static >/dev/null)
	done_ openh264
fi

if [ "${SKIP_SVTAV1:-0}" != 1 ] && ! stamp svtav1; then
	d="$(fetch svtav1)"
	cmake -S "$d" -B "$d/build" -DCMAKE_INSTALL_PREFIX="$DEPS" -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF \
		-DBUILD_APPS=OFF -DBUILD_TESTING=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
		>/dev/null
	cmake --build "$d/build" -j "$JOBS" >/dev/null
	cmake --install "$d/build" >/dev/null
	done_ svtav1
fi

vs() { node -e "const v=require(process.argv[1]).vidstab;const x=v[process.argv[2]];process.stdout.write(Array.isArray(x)?x.join('\n'):String(x))" "$MANIFEST" "$1"; }

if [ "${SKIP_VIDSTAB:-0}" != 1 ] && ! stamp vidstab; then
	d="$(fetch vidstab)"
	if [ ! -f "$d/RELICENSE.md" ] || ! grep -q 'SPDX-License-Identifier: LGPL-2.1-or-later' "$d/src/libvidstab.c"; then
		echo "[source] refusing: the pinned vid.stab source is not the LGPL relicensed tree" >&2
		exit 1
	fi
	mapfile -t vs_flags < <(vs cmake)
	cmake -S "$d" -B "$d/build" -DCMAKE_INSTALL_PREFIX="$DEPS" -DCMAKE_INSTALL_LIBDIR=lib \
		-DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON "${vs_flags[@]}" >/dev/null
	cmake --build "$d/build" -j "$JOBS" >/dev/null
	cmake --install "$d/build" >/dev/null
	cp "$d/COPYING.LESSER" "$DEPS/LICENSE-libvidstab.txt"
	done_ vidstab
fi

d="$(fetch ffmpeg)"
extra=()
[ "${SKIP_SVTAV1:-0}" != 1 ] && extra+=(--enable-libsvtav1)
if [ "${SKIP_VIDSTAB:-0}" != 1 ]; then
	patch -d "$d" -p1 --forward <"$HERE/$(vs configurePatch)" >/dev/null
	extra+=(--enable-libvidstab)
fi
if [ "$OS" = "Darwin" ]; then
	extra+=(--install-name-dir=@rpath "--extra-ldexeflags=-Wl,-rpath,@loader_path"
		"--extra-ldsoflags=-Wl,-rpath,@loader_path" --enable-videotoolbox --enable-audiotoolbox)
else
	# A literal $ORIGIN does not survive configure + make + sh quoting reliably: link a long placeholder
	# rpath that fetch-or-build-lgpl.mjs rewrites to $ORIGIN in place (rewriteElfRpath).
	extra+=("--extra-ldexeflags=-Wl,-rpath,/__jasper_rpath_placeholder__/lib")
fi
echo "[source] configuring FFmpeg $(pin ffmpeg url)" >&2
(cd "$d" && ./configure \
	--prefix="$PREFIX" \
	--pkg-config-flags=--static \
	--extra-cflags="-I$DEPS/include" \
	--extra-ldflags="-L$DEPS/lib" \
	--enable-shared --disable-static \
	--disable-doc --disable-debug --disable-ffplay \
	--disable-autodetect --enable-zlib --enable-pthreads \
	--enable-libopenh264 --enable-libvpx --enable-libopus \
	"${extra[@]}")
(cd "$d" && make -j"$JOBS" >/dev/null && make install >/dev/null)
cp "$d/COPYING.LGPLv2.1" "$PREFIX/LICENSE.txt"
if [ "${SKIP_VIDSTAB:-0}" != 1 ]; then
	mkdir -p "$PREFIX/share/jasper"
	cp "$DEPS/LICENSE-libvidstab.txt" "$PREFIX/LICENSE-libvidstab.txt"
	node -e "const v=require(process.argv[1]).vidstab;const p=require(process.argv[1]).source.packages.vidstab;
process.stdout.write(JSON.stringify({commit:v.commit,date:v.commitDate,version:v.version,license:v.license,
repository:v.repository,relicenseRecord:v.relicenseRecord,relicenseIssue:v.relicenseIssue,archive:p.url,
archiveSha256:p.sha256,cmake:v.cmake,configurePatch:v.configurePatch},null,2)+'\n')" "$MANIFEST" \
		>"$PREFIX/share/jasper/libvidstab.json"
fi

if grep -Eq -- '--enable-(gpl|nonfree)' "$d/ffbuild/config.mak"; then
	echo "[source] refusing: the configured FFmpeg is GPL/nonfree" >&2
	exit 1
fi
echo "[source] done: $PREFIX" >&2
