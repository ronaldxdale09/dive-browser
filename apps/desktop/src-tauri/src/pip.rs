//! Picture in picture: the video keeps playing in a small window that floats
//! over everything else, while the browser gets on with something else.
//!
//! The engine has supported this all along -- `document.pictureInPictureEnabled`
//! is true in a Dive tab -- and Dive simply never offered it. Chromium's own
//! way in is a button inside the media controls, which a page is free not to
//! draw, so a browser has to have its own.
//!
//! `requestPictureInPicture` refuses without a user gesture, which is exactly
//! right: nothing should be able to throw a floating window over the person's
//! screen on its own. The command runs the request as a gesture because the
//! person pressed something to get here.

use dive_cdp::CdpSession;
use serde_json::json;

/// Picks the video worth watching and toggles it.
///
/// The largest playing video, or failing that the largest video at all: on a
/// page with an article video and three muted background loops, the one the
/// person means is the one that is running.
const TOGGLE: &str = r"
(async () => {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return 'left';
  }
  const area = (v) => v.getBoundingClientRect().width * v.getBoundingClientRect().height;
  const usable = [...document.querySelectorAll('video')]
    .filter((v) => v.readyState > 0 && !v.disablePictureInPicture);
  const playing = usable.filter((v) => !v.paused && !v.ended);
  const pick = (playing.length ? playing : usable).sort((a, b) => area(b) - area(a))[0];
  if (!pick) return 'none';
  try {
    await pick.requestPictureInPicture();
    return 'entered';
  } catch (error) {
    return 'refused: ' + error.message;
  }
})()
";

/// What happened, for the chrome to report.
pub fn describe(outcome: &str) -> &'static str {
    match outcome {
        "entered" => "Playing in picture in picture",
        "left" => "Back in the tab",
        "none" => "No video on this page to float",
        _ => "This video cannot be played in picture in picture",
    }
}

/// Toggle picture in picture for the tab's page.
pub async fn toggle(session: &CdpSession) -> String {
    let reply = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": TOGGLE,
                "awaitPromise": true,
                "returnByValue": true,
                // The person pressed a menu item or a key to get here, and
                // without this Chromium refuses the request outright.
                "userGesture": true,
            }),
        )
        .await;
    reply
        .ok()
        .and_then(|value| value["result"]["value"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "refused: the page did not answer".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_leaves_before_it_enters_and_prefers_what_is_playing() {
        // Toggling out first is what makes one command do both jobs.
        assert!(TOGGLE.contains("document.pictureInPictureElement"));
        assert!(TOGGLE.contains("exitPictureInPicture"));
        // A page that opts a video out is respected rather than overridden.
        assert!(TOGGLE.contains("disablePictureInPicture"));
        // The choice is the largest of whatever is running.
        assert!(TOGGLE.contains("!v.paused && !v.ended"));
        assert!(TOGGLE.contains("area(b) - area(a)"));
    }

    #[test]
    fn every_outcome_reads_as_a_sentence() {
        assert_eq!(describe("entered"), "Playing in picture in picture");
        assert_eq!(describe("left"), "Back in the tab");
        assert_eq!(describe("none"), "No video on this page to float");
        assert_eq!(
            describe("refused: NotAllowedError"),
            "This video cannot be played in picture in picture"
        );
    }
}
