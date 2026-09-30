//! Shared building blocks of the `jasper-mg` templates (ARCHITECTURE §10.2).
//!
//! Everything here is plain math and string building with no fframes dependency, so it is easy to
//! test and to mirror exactly in TypeScript (`@jasper/mg-templates/src/core.ts`). The TS twins use
//! the same formulas, the same constants and the same number formatting, which keeps the Player
//! preview (browser SVG) and the exported master (tiny-skia raster) visually equivalent.

pub mod anim;
pub mod canvas;
pub mod schema;
pub mod spec;
pub mod svg;
pub mod text;

pub use anim::*;
pub use canvas::*;
pub use spec::*;
pub use svg::*;
pub use text::*;

/// Font stack used by every template. `Inter` is embedded in the binary (OFL, see
/// `crates/jasper-mg-templates/FONTS-OFL.txt`); browsers fall back to the listed families.
pub const FONT_FAMILY: &str = "Inter, 'Inter 24pt', 'Source Sans 3', sans-serif";
