//! JasperEditor motion-graphic templates for fframes (ARCHITECTURE D-12, §10.2; R-FF Design C).
//!
//! Every template reads its parameters from the runtime JSON spec; nothing is recompiled per edit.
//! [`AnyTemplate`] dispatches to the selected template and implements [`fframes::Video`] for each
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

fframes::include_media_dir!(pub struct MgMedia, "crates/jasper-mg-templates/media");

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
            TemplateParams::TitleCard(p) => title_card::render_svg(p, &ft, &self.fit, "mg"),
        }
    }

    /// The design canvas this spec renders with.
    pub fn canvas(&self) -> (u32, u32) {
        (self.fit.design_w as u32, self.fit.design_h as u32)
    }
}

/// Template dispatch implementing `fframes::Video` for one design canvas `W`x`H`.
#[derive(Debug)]
pub enum AnyTemplate<'a, const W: usize, const H: usize> {
    LowerThird(&'a Prepared),
    TitleCard(&'a Prepared),
}

impl<'a, const W: usize, const H: usize> AnyTemplate<'a, W, H> {
    pub fn new(prepared: &'a Prepared) -> Self {
        match prepared.params {
            TemplateParams::LowerThird(_) => Self::LowerThird(prepared),
            TemplateParams::TitleCard(_) => Self::TitleCard(prepared),
        }
    }

    pub fn prepared(&self) -> &'a Prepared {
        match self {
            Self::LowerThird(p) | Self::TitleCard(p) => p,
        }
    }
}

impl<const W: usize, const H: usize> Video for AnyTemplate<'_, W, H> {
    const FPS: usize = 30;
    const WIDTH: usize = W;
    const HEIGHT: usize = H;
    const BACKGROUND_COLOR: Color = Color::TRANSPARENT;

    fn duration(&self) -> Duration<'_> {
        Duration::Frames(self.prepared().spec.duration_frames as usize)
    }

    fn audio(&self) -> AudioMap<'_> {
        // Motion graphics are silent; audio lives on the JasperEditor timeline (R-FF §2.5).
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        Svgr::from(self.prepared().svg(frame.index as u32))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(template: &str, params: Value, w: u32, h: u32) -> MgSpec {
        let id = template.split('@').next().unwrap();
        MgSpec::parse(
            &json!({"template": {"id": id, "version": 1}, "params": params, "width": w, "height": h,
                    "fps": {"num": 30, "den": 1}, "durationFrames": 150})
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn params_default_and_reject_unknown_fields() {
        let p = Prepared::new(spec("lower-third", json!({"name": "Ana"}), 1920, 1080)).unwrap();
        match &p.params {
            TemplateParams::LowerThird(lt) => {
                assert_eq!(lt.name, "Ana");
                assert_eq!(lt.title, LowerThirdParams::default().title);
            }
            _ => panic!("wrong template"),
        }
        assert!(Prepared::new(spec("lower-third", json!({"nope": 1}), 1920, 1080)).is_err());
        assert!(
            Prepared::new(spec(
                "lower-third",
                json!({"accentColor": [2, 0, 0, 1]}),
                1920,
                1080
            ))
            .is_err()
        );
        assert!(
            Prepared::new(spec(
                "title-card",
                json!({"alignment": "justify"}),
                1920,
                1080
            ))
            .is_err()
        );
        let mut unknown = spec("title-card", json!({}), 1920, 1080);
        unknown.template.version = 9;
        assert!(Prepared::new(unknown).is_err());
    }

    #[test]
    fn schema_lists_both_templates_with_matching_defaults() {
        let s = schema_json();
        let list = s["templates"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        for t in list {
            let props = t["paramsSchema"]["properties"].as_object().unwrap();
            let defaults = t["defaults"].as_object().unwrap();
            assert_eq!(props.len(), defaults.len(), "{}", t["id"]);
            for (k, v) in props {
                assert_eq!(&v["default"], &defaults[k], "{} {k}", t["id"]);
            }
            assert_eq!(
                t["canvases"],
                json!(["1920x1080", "1080x1920", "1080x1080"])
            );
        }
    }

    #[test]
    fn svg_is_deterministic_and_well_formed() {
        for id in ["lower-third", "title-card"] {
            let p = Prepared::new(spec(id, json!({}), 1280, 720)).unwrap();
            for f in [0, 75, 149] {
                let a = p.svg(f);
                assert_eq!(a, p.svg(f));
                assert!(a.starts_with(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1280\" height=\"720\""
                ));
                assert!(a.ends_with("</svg>"));
            }
            assert_eq!(p.canvas(), (1920, 1080));
        }
    }
}
