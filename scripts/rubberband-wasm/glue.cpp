// The Pitch Shifter's Rubber Band engine (GPL-2.0-or-later, like the library it links): the C API of
// rubberband-c.h is exported as-is; these two helpers let the host allocate the planar float buffers it passes.
#include <cstdlib>
extern "C" {
__attribute__((export_name("rbx_malloc"))) void *rbx_malloc(unsigned long n) { return std::malloc(n); }
__attribute__((export_name("rbx_free"))) void rbx_free(void *p) { std::free(p); }
}
