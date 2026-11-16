// Force-included into the Rubber Band build (scripts/rubberband-wasm/build.sh): wasi-sdk's libc++ has no C++
// exceptions, and Rubber Band only throws on allocation failure and programming errors (no try/catch anywhere in
// the library). Every `throw X` becomes abort(): the module traps, the host catches the RuntimeError and the
// Pitch Shifter falls back to Signalsmith with a warning.
#ifndef JASPER_RUBBERBAND_SHIM_H
#define JASPER_RUBBERBAND_SHIM_H
#ifdef __cplusplus
#include <cstdlib>
#include <new>
#include <stdexcept>
#include <vector>
#include <map>
#include <set>
#include <string>
#include <iostream>
#include <sstream>
#include <functional>
#include <memory>
#include <algorithm>
#include <cmath>
#define throw ::abort(), (void)
#endif
#endif
