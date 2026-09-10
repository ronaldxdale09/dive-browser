//! Driving a page: clicks, typing, key presses, scrolling and waiting.
//!
//! Clicks, typing and key presses dispatch real input events through CDP, so
//! a page's own handlers, focus rules and event ordering behave the way they
//! do for a person. Scrolling uses the page context because CEF can silently
//! drop the response to CDP's `mouseWheel` command and stall the action.
//!
//! Actions are announced to the chrome before they happen ([`AgentPointer`])
//! so the person watching sees a cursor move to the target instead of the
//! page changing under them with no explanation.

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};

/// Where an agent is about to act, so the chrome can draw a cursor there.
/// Emitted just before the input is dispatched. The `move` phase arrives
/// first, then `click` once the pointer has notionally arrived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct AgentPointer {
    /// Tab being driven.
    pub tab_id: TabId,
    /// `move`, `click` or `type`.
    pub phase: String,
    /// Viewport x in CSS pixels.
    pub x: f64,
    /// Viewport y in CSS pixels.
    pub y: f64,
    /// What is being acted on, for the label beside the cursor.
    pub label: String,
}

/// How long the cursor is shown travelling to its target before the click
/// lands. Short enough not to slow a run down noticeably, long enough that
/// the movement reads as deliberate rather than as a flicker.
const CURSOR_TRAVEL_MS: u64 = 140;

/// Modifier bits CDP expects.
const ALT: u8 = 1;
const CTRL: u8 = 2;
const META: u8 = 4;
const SHIFT: u8 = 8;

/// Turn modifier names into the bitmask `Input.dispatchKeyEvent` wants.
pub fn modifier_mask(modifiers: &[String]) -> AppResult<u8> {
    let mut mask = 0;
    for modifier in modifiers {
        mask |= match modifier.trim().to_ascii_lowercase().as_str() {
            "alt" | "option" => ALT,
            "control" | "ctrl" => CTRL,
            "meta" | "cmd" | "command" | "super" => META,
            "shift" => SHIFT,
            other => {
                return Err(AppError::new(format!(
                    "unknown modifier {other:?}; use Meta, Control, Alt or Shift"
                )));
            }
        };
    }
    Ok(mask)
}

/// The platform chord for "select everything in this field".
const SELECT_ALL_MODIFIER: u8 = if cfg!(target_os = "macos") {
    META
} else {
    CTRL
};

/// `(code, windowsVirtualKeyCode, text)` for a named key.
///
/// The virtual key code matters: Chromium routes shortcuts and caret motion
/// off it, and a key event without one is delivered but ignored by most
/// pages.
fn named_key(key: &str) -> Option<(&'static str, i64, &'static str)> {
    Some(match key {
        "Enter" | "Return" => ("Enter", 13, "\r"),
        "Tab" => ("Tab", 9, "\t"),
        "Escape" | "Esc" => ("Escape", 27, ""),
        "Backspace" => ("Backspace", 8, ""),
        "Delete" => ("Delete", 46, ""),
        "ArrowUp" => ("ArrowUp", 38, ""),
        "ArrowDown" => ("ArrowDown", 40, ""),
        "ArrowLeft" => ("ArrowLeft", 37, ""),
        "ArrowRight" => ("ArrowRight", 39, ""),
        "Home" => ("Home", 36, ""),
        "End" => ("End", 35, ""),
        "PageUp" => ("PageUp", 33, ""),
        "PageDown" => ("PageDown", 34, ""),
        "Space" => ("Space", 32, " "),
        _ => return None,
    })
}

/// The `keyDown`/`keyUp` parameter pair for one key press.
pub fn key_events(key: &str, modifiers: u8) -> AppResult<(Value, Value)> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::new("key is required"));
    }
    let (normalized, code, vk, text) = if let Some((code, vk, text)) = named_key(key) {
        (code.to_owned(), code.to_owned(), vk, text.to_owned())
    } else {
        let mut chars = key.chars();
        let (Some(c), None) = (chars.next(), chars.next()) else {
            return Err(AppError::new(format!(
                "unknown key {key:?}; use a single character or a name like Enter, Escape, Tab or ArrowDown"
            )));
        };
        let code = if c.is_ascii_alphabetic() {
            format!("Key{}", c.to_ascii_uppercase())
        } else if c.is_ascii_digit() {
            format!("Digit{c}")
        } else {
            String::new()
        };
        let vk = i64::from(u32::from(c.to_ascii_uppercase()));
        (c.to_string(), code, vk, c.to_string())
    };
    // A modified key is a shortcut, not text: sending `text` alongside Meta
    // would insert the character as well as firing the chord.
    let printable = modifiers & (CTRL | META) == 0;
    let down = json!({
        "type": if text.is_empty() || !printable { "rawKeyDown" } else { "keyDown" },
        "key": normalized,
        "code": code,
        "windowsVirtualKeyCode": vk,
        "modifiers": modifiers,
        "text": if printable { text.clone() } else { String::new() },
    });
    let up = json!({
        "type": "keyUp",
        "key": normalized,
        "code": code,
        "windowsVirtualKeyCode": vk,
        "modifiers": modifiers,
    });
    Ok((down, up))
}

/// Announce an action, pausing only when someone can actually see it.
///
/// Animating a background tab would cost every automated run a fifth of a
/// second per click for nobody's benefit.
async fn announce(app: Option<&AppHandle<Runtime>>, hint: &AgentPointer, visible: bool) {
    if let Some(app) = app {
        let _ = hint.emit(app);
    }
    if visible {
        tokio::time::sleep(std::time::Duration::from_millis(CURSOR_TRAVEL_MS)).await;
    }
}

/// Click at a viewport coordinate.
pub async fn click_at(
    session: &CdpSession,
    app: Option<&AppHandle<Runtime>>,
    tab: TabId,
    x: f64,
    y: f64,
    label: &str,
    visible: bool,
) -> AppResult<()> {
    announce(
        app,
        &AgentPointer {
            tab_id: tab,
            phase: "move".into(),
            x,
            y,
            label: label.to_owned(),
        },
        visible,
    )
    .await;
    announce(
        app,
        &AgentPointer {
            tab_id: tab,
            phase: "click".into(),
            x,
            y,
            label: label.to_owned(),
        },
        false,
    )
    .await;
    for (index, event) in mouse_events(x, y).into_iter().enumerate() {
        // Give CEF one event-loop turn with the button held. Sending down and
        // up back-to-back can be acknowledged by CDP without Blink producing
        // a DOM click.
        if index == 2 {
            tokio::time::sleep(std::time::Duration::from_millis(16)).await;
        }
        session
            .call("Input.dispatchMouseEvent", event)
            .await
            .map_err(AppError::new)?;
    }
    Ok(())
}

/// Move the pointer to a point and leave it there, for hover menus,
/// tooltips and `:hover` styles.
pub async fn hover_at(
    session: &CdpSession,
    app: Option<&AppHandle<Runtime>>,
    tab: TabId,
    x: f64,
    y: f64,
    label: &str,
    visible: bool,
) -> AppResult<()> {
    announce(
        app,
        &AgentPointer {
            tab_id: tab,
            phase: "move".into(),
            x,
            y,
            label: label.to_owned(),
        },
        visible,
    )
    .await;
    let [moved, _, _] = mouse_events(x, y);
    session
        .call("Input.dispatchMouseEvent", moved)
        .await
        .map_err(AppError::new)?;
    Ok(())
}

/// Drag from one point to another with the button held.
///
/// The press, the moves and the release are separate events with a real
/// pause between them, because that is the shape drag libraries listen for:
/// one that jumps straight from press to release at the destination reads as
/// a click, and one with no delay is often dropped as a stray pointer event.
/// Native HTML5 drag-and-drop is a different mechanism and is not driven
/// here; pointer-based dragging is what the JavaScript libraries use.
pub async fn drag_between(
    session: &CdpSession,
    app: Option<&AppHandle<Runtime>>,
    tab: TabId,
    from: (f64, f64),
    to: (f64, f64),
    label: &str,
    visible: bool,
) -> AppResult<()> {
    /// Enough intermediate moves for a distance threshold to be crossed and
    /// for the dragged thing to be seen travelling.
    const STEPS: u32 = 10;
    let (x0, y0) = from;
    let (x1, y1) = to;
    announce(
        app,
        &AgentPointer {
            tab_id: tab,
            phase: "move".into(),
            x: x0,
            y: y0,
            label: label.to_owned(),
        },
        visible,
    )
    .await;
    let send = |event: serde_json::Value| async {
        session
            .call("Input.dispatchMouseEvent", event)
            .await
            .map(|_| ())
            .map_err(AppError::new)
    };
    send(json!({"type": "mouseMoved", "x": x0, "y": y0, "button": "none", "buttons": 0, "pointerType": "mouse"})).await?;
    send(json!({"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": "mouse"})).await?;
    tokio::time::sleep(std::time::Duration::from_millis(32)).await;
    for step in 1..=STEPS {
        let t = f64::from(step) / f64::from(STEPS);
        let x = x0 + (x1 - x0) * t;
        let y = y0 + (y1 - y0) * t;
        send(json!({"type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": "mouse"})).await?;
        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
    }
    announce(
        app,
        &AgentPointer {
            tab_id: tab,
            phase: "click".into(),
            x: x1,
            y: y1,
            label: label.to_owned(),
        },
        false,
    )
    .await;
    send(json!({"type": "mouseReleased", "x": x1, "y": y1, "button": "left", "buttons": 0, "clickCount": 1, "pointerType": "mouse"})).await?;
    Ok(())
}

fn mouse_events(x: f64, y: f64) -> [serde_json::Value; 3] {
    [
        json!({
            "type": "mouseMoved",
            "x": x,
            "y": y,
            "button": "none",
            "buttons": 0,
            "pointerType": "mouse"
        }),
        json!({
            "type": "mousePressed",
            "x": x,
            "y": y,
            "button": "left",
            "buttons": 1,
            "clickCount": 1,
            "pointerType": "mouse"
        }),
        json!({
            "type": "mouseReleased",
            "x": x,
            "y": y,
            "button": "left",
            "buttons": 0,
            "clickCount": 1,
            "pointerType": "mouse"
        }),
    ]
}

/// Insert text into whatever has focus, optionally replacing it first and
/// pressing Enter afterwards.
pub async fn type_text(
    session: &CdpSession,
    text: &str,
    clear: bool,
    submit: bool,
) -> AppResult<()> {
    if clear {
        let (down, up) = key_events("a", SELECT_ALL_MODIFIER)?;
        // `commands` is what makes Chromium treat the chord as an editing
        // command rather than as a keystroke the page has to interpret.
        let mut down = down;
        down["commands"] = json!(["selectAll"]);
        session
            .call("Input.dispatchKeyEvent", down)
            .await
            .map_err(AppError::new)?;
        session
            .call("Input.dispatchKeyEvent", up)
            .await
            .map_err(AppError::new)?;
    }
    if !text.is_empty() {
        session
            .call("Input.insertText", json!({"text": text}))
            .await
            .map_err(AppError::new)?;
    } else if clear {
        // Clearing with nothing to insert still has to empty the field.
        let (down, up) = key_events("Delete", 0)?;
        session
            .call("Input.dispatchKeyEvent", down)
            .await
            .map_err(AppError::new)?;
        session
            .call("Input.dispatchKeyEvent", up)
            .await
            .map_err(AppError::new)?;
    }
    if submit {
        press(session, "Enter", 0).await?;
    }
    Ok(())
}

/// Press one key against whatever has focus.
pub async fn press(session: &CdpSession, key: &str, modifiers: u8) -> AppResult<()> {
    let (down, up) = key_events(key, modifiers)?;
    session
        .call("Input.dispatchKeyEvent", down)
        .await
        .map_err(AppError::new)?;
    session
        .call("Input.dispatchKeyEvent", up)
        .await
        .map_err(AppError::new)?;
    Ok(())
}

fn scroll_expression(x: f64, y: f64, delta_x: f64, delta_y: f64) -> String {
    format!(
        r"(() => {{
  const dx = {delta_x};
  const dy = {delta_y};
  const canScroll = (el, axis, delta) => {{
    if (!delta) return false;
    const style = getComputedStyle(el);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    if (!/(auto|scroll|overlay)/.test(overflow)) return false;
    const position = axis === 'x' ? el.scrollLeft : el.scrollTop;
    const maximum = axis === 'x'
      ? el.scrollWidth - el.clientWidth
      : el.scrollHeight - el.clientHeight;
    return delta < 0 ? position > 0 : position < maximum;
  }};
  let el = document.elementFromPoint({x}, {y});
  while (el && el !== document.body && el !== document.documentElement) {{
    if (canScroll(el, 'x', dx) || canScroll(el, 'y', dy)) {{
      el.scrollBy({{ left: dx, top: dy, behavior: 'instant' }});
      return 'element';
    }}
    const root = el.getRootNode?.();
    el = el.parentElement || root?.host || null;
  }}
  window.scrollBy({{ left: dx, top: dy, behavior: 'instant' }});
  return 'window';
}})()"
    )
}

/// Scroll by a delta at a point, preferring the nearest scrollable ancestor.
pub async fn scroll(
    session: &CdpSession,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
) -> AppResult<()> {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": scroll_expression(x, y, delta_x, delta_y),
                "returnByValue": true,
            }),
        )
        .await
        .map_err(AppError::new)?;
    if let Some(message) = result["exceptionDetails"]["exception"]["description"]
        .as_str()
        .or_else(|| result["exceptionDetails"]["text"].as_str())
    {
        return Err(AppError::new(format!("scroll failed: {message}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_accept_the_names_people_write() {
        assert_eq!(modifier_mask(&[]).unwrap(), 0);
        assert_eq!(modifier_mask(&["Meta".into()]).unwrap(), META);
        assert_eq!(modifier_mask(&["cmd".into()]).unwrap(), META);
        assert_eq!(modifier_mask(&["Control".into()]).unwrap(), CTRL);
        assert_eq!(modifier_mask(&["ctrl".into()]).unwrap(), CTRL);
        assert_eq!(
            modifier_mask(&["Shift".into(), "Alt".into()]).unwrap(),
            SHIFT | ALT
        );
        let error = modifier_mask(&["Hyper".into()]).unwrap_err().message;
        assert!(error.contains("Meta"), "{error}");
    }

    #[test]
    fn named_keys_carry_a_virtual_key_code() {
        // Without the virtual key code the event is delivered and ignored.
        let (down, up) = key_events("Enter", 0).unwrap();
        assert_eq!(down["windowsVirtualKeyCode"], 13);
        assert_eq!(down["key"], "Enter");
        assert_eq!(down["text"], "\r");
        assert_eq!(up["type"], "keyUp");

        let (down, _) = key_events("Escape", 0).unwrap();
        assert_eq!(down["windowsVirtualKeyCode"], 27);
        // Escape inserts nothing, so it is a raw key rather than text.
        assert_eq!(down["type"], "rawKeyDown");

        let (down, _) = key_events("ArrowDown", 0).unwrap();
        assert_eq!(down["code"], "ArrowDown");
        assert_eq!(down["windowsVirtualKeyCode"], 40);
    }

    #[test]
    fn single_characters_become_text_with_a_physical_code() {
        let (down, _) = key_events("a", 0).unwrap();
        assert_eq!(down["type"], "keyDown");
        assert_eq!(down["code"], "KeyA");
        assert_eq!(down["text"], "a");

        let (down, _) = key_events("7", 0).unwrap();
        assert_eq!(down["code"], "Digit7");
    }

    #[test]
    fn a_modified_key_is_a_shortcut_and_inserts_nothing() {
        // Meta+A has to select all, not type an "a" as well.
        let (down, _) = key_events("a", META).unwrap();
        assert_eq!(down["text"], "");
        assert_eq!(down["type"], "rawKeyDown");
        assert_eq!(down["modifiers"], META);

        // Shift is not a command modifier, so Shift+a still types.
        let (down, _) = key_events("a", SHIFT).unwrap();
        assert_eq!(down["text"], "a");
    }

    #[test]
    fn unusable_keys_are_refused_with_a_hint() {
        assert!(key_events("", 0).is_err());
        assert!(key_events("   ", 0).is_err());
        let error = key_events("Enterr", 0).unwrap_err().message;
        assert!(error.contains("Enter"), "{error}");
        // A bare modifier is not a press.
        assert!(key_events("Shift", 0).is_err());
        // A multi-character string that is not a known name is a typo.
        assert!(key_events("abc", 0).is_err());
    }

    #[test]
    fn mouse_click_tracks_the_pressed_button_state() {
        let [moved, pressed, released] = mouse_events(10.5, 20.25);
        assert_eq!(moved["type"], "mouseMoved");
        assert_eq!(moved["buttons"], 0);
        assert_eq!(pressed["type"], "mousePressed");
        assert_eq!(pressed["button"], "left");
        assert_eq!(pressed["buttons"], 1);
        assert_eq!(pressed["clickCount"], 1);
        assert_eq!(released["type"], "mouseReleased");
        assert_eq!(released["buttons"], 0);
    }

    #[test]
    fn scroll_finds_a_scrollable_ancestor_before_falling_back_to_the_window() {
        let script = scroll_expression(10.5, 20.25, -3.0, 400.0);
        assert!(script.contains("document.elementFromPoint(10.5, 20.25)"));
        assert!(script.contains("el.scrollBy"));
        assert!(script.contains("window.scrollBy"));
        assert!(script.contains("const dx = -3"));
        assert!(script.contains("const dy = 400"));
    }
}
