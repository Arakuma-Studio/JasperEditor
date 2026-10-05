use jasper_mg_templates::Prepared;
use serde_json::json;

#[test]
fn user_text_remains_text_in_svg() {
    let spec = serde_json::from_value(json!({
        "template": {"id": "lower-third", "version": 1},
        "params": {"name": "A<script>alert(1)</script> & \"B\" 'C'\u{1}"},
        "width": 1920, "height": 1080,
        "fps": {"num": 30, "den": 1}, "durationFrames": 150
    }))
    .unwrap();
    let svg = Prepared::new(spec).unwrap().svg(60);
    let document = fframes::roxmltree::Document::parse(&svg).unwrap();
    assert!(
        !document
            .descendants()
            .any(|node| node.has_tag_name("script"))
    );
    assert!(document.descendants().any(|node| {
        node.is_text() && node.text() == Some("A<script>alert(1)</script> & \"B\" 'C'")
    }));
}
