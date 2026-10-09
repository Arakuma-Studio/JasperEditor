//! JasperEditor motion-graphic templates for fframes (ARCHITECTURE D-12, §10.2; R-FF Design C).
//!
//! Every template reads its parameters from the runtime JSON spec; nothing is recompiled per edit.
//! [`AnyTemplate`] implements [`fframes::Video`] for a prepared template on each
//! design canvas through const generics (`AnyTemplate<1920, 1080>`, `<1080, 1920>`, `<1080, 1080>`).
//! Other output sizes are drawn by the canvas with the closest aspect ratio, scaled uniformly.
//!
//! Frame rate: `Video::FPS` is an associated const and fframes' `RenderOptions::override_fps` is an
//! integer that `Previewer` ignores, so neither can express 29.97 fps. The templates therefore take
//! their time base from the spec (`FrameTime`, rational fps) and give fframes the duration in frames
//! (`Duration::Frames`). `FPS` below is only used by fframes' own timeline helpers, which we do not
//! call.
pub mod lower_third;
pub mod title_card;

use fframes::{AudioMap, Color, Duration, FFramesContext, Frame, Svgr, Video};
use jasper_mg_core::{Fit, MgSpec, SpecError, canvas_labels, fit_canvas, spec_error};
use serde::Serialize;
use serde_json::{Value, json};

pub use lower_third::LowerThirdParams;
pub use title_card::TitleCardParams;

// `.media/` = the media files of `media/` without their attribution sidecars, staged by build.rs.
fframes::include_media_dir!(pub struct MgMedia, "crates/jasper-mg-templates/.media");

/// Renderer version, part of the render cache key (S04:MG-011). Bump when any template's output
/// changes for the same spec.
pub const RENDERER_VERSION: &str = "jasper-mg/0.1.0";

/// Validated parameters of one template.
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateParams {
    LowerThird(LowerThirdParams),
    TitleCard(TitleCardParams),
}

/// Catalog entry printed by `jasper-mg schema`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: &'static str,
    pub version: u32,
    pub name: &'static str,
    pub category: &'static str,
    pub params_schema: Value,
    pub defaults: Value,
    pub intro_frames: u32,
    pub outro_frames: u32,
    pub default_duration_seconds: f64,
    pub canvases: Vec<String>,
}

pub fn catalog() -> Vec<TemplateInfo> {
    vec![
        TemplateInfo {
            id: lower_third::ID,
            version: lower_third::VERSION,
            name: lower_third::NAME,
            category: lower_third::CATEGORY,
            params_schema: lower_third::params_schema(),
            defaults: serde_json::to_value(LowerThirdParams::default())
                .expect("defaults serialize"),
            intro_frames: lower_third::INTRO_FRAMES,
            outro_frames: lower_third::OUTRO_FRAMES,
            default_duration_seconds: lower_third::DEFAULT_DURATION_SECONDS,
            canvases: canvas_labels(),
        },
        TemplateInfo {
            id: title_card::ID,
            version: title_card::VERSION,
            name: title_card::NAME,
            category: title_card::CATEGORY,
            params_schema: title_card::params_schema(),
            defaults: serde_json::to_value(TitleCardParams::default()).expect("defaults serialize"),
            intro_frames: title_card::INTRO_FRAMES,
            outro_frames: title_card::OUTRO_FRAMES,
            default_duration_seconds: title_card::DEFAULT_DURATION_SECONDS,
            canvases: canvas_labels(),
        },
    ]
}

/// `{"templates": [...]}` as printed by `jasper-mg schema`.
pub fn schema_json() -> Value {
    json!({ "templates": catalog() })
}

impl TemplateParams {
    /// Parses and validates `spec.params` for `spec.template` (unknown fields are rejected, missing
    /// ones take the template defaults).
    pub fn from_spec(spec: &MgSpec) -> Result<Self, SpecError> {
        let params = Value::Object(spec.params.clone());
        let bad =
            |e: serde_json::Error| spec_error(format!("invalid params for {}: {e}", key(spec)));
        match (spec.template.id.as_str(), spec.template.version) {
            (lower_third::ID, lower_third::VERSION) => {
                let p: LowerThirdParams = serde_json::from_value(params).map_err(bad)?;
                p.validate()?;
                Ok(Self::LowerThird(p))
            }
            (title_card::ID, title_card::VERSION) => {
                let p: TitleCardParams = serde_json::from_value(params).map_err(bad)?;
                p.validate()?;
                Ok(Self::TitleCard(p))
            }
            _ => Err(spec_error(format!("unknown template {}", key(spec)))),
        }
    }
}

fn key(spec: &MgSpec) -> String {
    format!("{}@{}", spec.template.id, spec.template.version)
}

/// A spec with parsed params and the canvas fit: everything a frame needs, precomputed.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub spec: MgSpec,
    pub params: TemplateParams,
    pub fit: Fit,
}

impl Prepared {
    pub fn new(spec: MgSpec) -> Result<Self, SpecError> {
        spec.validate()?;
        let params = TemplateParams::from_spec(&spec)?;
        let fit = fit_canvas(spec.width, spec.height);
        Ok(Self { spec, params, fit })
    }

    /// SVG markup of output frame `index` (what fframes rasterizes and what the TS twin mirrors).
    pub fn svg(&self, index: u32) -> String {
        let ft = self.spec.frame_time(index);
        match &self.params {
            TemplateParams::LowerThird(p) => lower_third::render_svg(p, &ft, &self.fit, "mg"),
            TemplateParams::TitleCard(p) => title_card::render_svg(p, &ft, &self.fit),
        }
    }

    /// The design canvas this spec renders with.
    pub fn canvas(&self) -> (u32, u32) {
        (self.fit.design_w as u32, self.fit.design_h as u32)
    }
}

/// A prepared template implementing `fframes::Video` for one design canvas `W`x`H`.
#[derive(Debug)]
pub struct AnyTemplate<'a, const W: usize, const H: usize> {
    prepared: &'a Prepared,
}

impl<'a, const W: usize, const H: usize> AnyTemplate<'a, W, H> {
    pub fn new(prepared: &'a Prepared) -> Self {
        Self { prepared }
    }
}

impl<const W: usize, const H: usize> Video for AnyTemplate<'_, W, H> {
    const FPS: usize = 30;
    const WIDTH: usize = W;
    const HEIGHT: usize = H;
    const BACKGROUND_COLOR: Color = Color::TRANSPARENT;

    fn duration(&self) -> Duration<'_> {
        Duration::Frames(self.prepared.spec.duration_frames as usize)
    }

    fn audio(&self) -> AudioMap<'_> {
        // Motion graphics are silent; audio lives on the JasperEditor timeline (R-FF §2.5).
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        Svgr::from(self.prepared.svg(frame.index as u32))
    }
}
