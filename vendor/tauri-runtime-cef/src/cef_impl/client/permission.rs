// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#[path = "permission_context.rs"]
mod context;

use cef::*;
use std::{
  collections::HashMap,
  sync::{Arc, Mutex},
  time::{Duration, Instant},
};

const DEADLINE: Duration = Duration::from_secs(30);
type Answer = Box<dyn FnOnce(Option<bool>) + Send>;
type Handler = Arc<dyn Fn(NativePermissionRequest) + Send + Sync>;
type Cancel = Arc<dyn Fn(u64) + Send + Sync>;
type Navigation = Arc<dyn Fn(Option<String>, bool) + Send + Sync>;

/// Weak handle to a native permission cache; does not retain a Browser or context.
#[derive(Clone)]
pub struct PermissionContext(std::sync::Weak<context::ContextLease>);
impl PermissionContext {
  pub fn is_alive(&self) -> bool {
    self.0.strong_count() != 0
  }
  /// Process-local cache identity for deduplicating weak reset handles.
  pub fn identity(&self) -> usize {
    self.0.as_ptr() as usize
  }

  /// UI-only reset. False means the context has already been destroyed.
  pub fn reset(&self, origin: &str, kind: &str) -> Result<bool, String> {
    let Some(context) = self.0.upgrade() else {
      return Ok(false);
    };
    context.reset(origin, kind)?;
    Ok(true)
  }
}

/// Authenticated native request; frame identity is absent for CEF permission prompts.
#[derive(Clone)]
pub struct NativePermissionRequest {
  pub page_lifetime: bool,
  pub id: u64,
  pub origin: String,
  pub kinds: Vec<String>,
  pub frame_id: Option<String>,
  pub top_level_url: String,
  pub deadline: Instant,
  bridge: Arc<PermissionBridge>,
}
impl NativePermissionRequest {
  /// Must be checked on CEF UI immediately before persisting a user answer.
  pub fn can_respond(&self) -> bool {
    cef::currently_on(ThreadId::UI) != 0
      && self
        .bridge
        .state
        .lock()
        .unwrap()
        .pending
        .get(&self.id)
        .is_some_and(|pending| Instant::now() < pending.deadline && (pending.valid)())
  }
  pub fn is_pending(&self) -> bool {
    self
      .bridge
      .state
      .lock()
      .unwrap()
      .pending
      .contains_key(&self.id)
  }
  /// Resolve the original callback exactly once, on CEF's UI thread.
  pub fn respond(self, allowed: Option<bool>) {
    if cef::currently_on(ThreadId::UI) != 0 {
      self.bridge.complete(self.id, allowed);
      return;
    }
    let mut task = PermissionTask::new(self.bridge, self.id, allowed);
    cef::post_task(ThreadId::UI, Some(&mut task));
  }
}
struct Pending {
  frame_id: Option<String>,
  prompt_id: Option<u64>,
  deadline: Instant,
  valid: Box<dyn Fn() -> bool + Send>,
  answer: Answer,
}
#[derive(Default)]
struct State {
  context: Option<Arc<context::ContextLease>>,
  next_id: u64,
  handler: Option<Handler>,
  cancel: Option<Cancel>,
  navigation: Option<Navigation>,
  pending: HashMap<u64, Pending>,
}
/// Per-native-webview policy and one-shot callbacks. No process-global grants.
#[derive(Default)]
pub struct PermissionBridge {
  state: Mutex<State>,
}
impl PermissionBridge {
  pub fn permission_context(&self) -> Option<PermissionContext> {
    self
      .state
      .lock()
      .unwrap()
      .context
      .as_ref()
      .map(|context| PermissionContext(Arc::downgrade(context)))
  }
  pub fn initialize_context(&self, context: &RequestContext) -> Result<(), String> {
    self.state.lock().unwrap().context = Some(context::ContextLease::acquire(context)?);
    Ok(())
  }
  pub fn reconcile_permission_cache_for_diagnostics(&self) -> Result<(), String> {
    self
      .state
      .lock()
      .unwrap()
      .context
      .as_ref()
      .ok_or_else(|| "Permission context unavailable".to_owned())?
      .reconcile_for_diagnostics()
  }
  pub fn reset_permission_cache(&self, origin: &str, kind: &str) -> Result<(), String> {
    self
      .state
      .lock()
      .unwrap()
      .context
      .as_ref()
      .ok_or_else(|| "Permission context unavailable".to_owned())?
      .reset(origin, kind)
  }
  pub fn install(&self, handler: Handler, cancel: Cancel, navigation: Navigation) {
    let mut state = self.state.lock().unwrap();
    state.handler = Some(handler);
    state.cancel = Some(cancel);
    state.navigation = Some(navigation);
  }
  fn complete(&self, id: u64, allowed: Option<bool>) {
    let (pending, cancel) = {
      let mut state = self.state.lock().unwrap();
      (state.pending.remove(&id), state.cancel.clone())
    };
    if let Some(pending) = pending {
      let allowed = allowed.filter(|_| Instant::now() < pending.deadline && (pending.valid)());
      (pending.answer)(allowed);
      if let Some(cancel) = cancel {
        cancel(id);
      }
    }
  }
  pub fn navigating(&self, frame: Option<&Frame>) {
    let frame_id = frame.map(|frame| CefString::from(&frame.identifier()).to_string());
    let main = frame.is_none_or(|frame| frame.is_main() != 0);
    self.invalidate(frame_id, main);
  }
  fn invalidate(&self, frame_id: Option<String>, main: bool) {
    let (ids, navigation) = {
      let state = self.state.lock().unwrap();
      (
        state
          .pending
          .iter()
          .filter(|(_, request)| main || request.frame_id.is_none() || request.frame_id == frame_id)
          .map(|(id, _)| *id)
          .collect::<Vec<_>>(),
        state.navigation.clone(),
      )
    };
    for id in ids {
      self.complete(id, None);
    }
    if let Some(navigation) = navigation {
      navigation(frame_id, main);
    }
  }
}
wrap_task! {
  struct PermissionTask { bridge: Arc<PermissionBridge>, id: u64, allowed: Option<bool> }
  impl Task { fn execute(&self) { self.bridge.complete(self.id, self.allowed); } }
}
fn media_kinds(mask: u32) -> Option<Vec<String>> {
  use cef::sys::cef_media_access_permission_types_t as M;
  let audio = M::CEF_MEDIA_PERMISSION_DEVICE_AUDIO_CAPTURE as u32;
  let video = M::CEF_MEDIA_PERMISSION_DEVICE_VIDEO_CAPTURE as u32;
  let display = (M::CEF_MEDIA_PERMISSION_DESKTOP_AUDIO_CAPTURE as u32)
    | (M::CEF_MEDIA_PERMISSION_DESKTOP_VIDEO_CAPTURE as u32);
  if mask == 0 || mask & !(audio | video | display) != 0 {
    return None;
  }
  let mut kinds = Vec::new();
  if mask & audio != 0 {
    kinds.push("microphone".into());
  }
  if mask & video != 0 {
    kinds.push("camera".into());
  }
  if mask & display != 0 {
    kinds.push("display_capture".into());
  }
  Some(kinds)
}
fn prompt_kinds(mask: u32) -> Option<Vec<String>> {
  use cef::sys::cef_permission_request_types_t as P;
  let supported = [
    (P::CEF_PERMISSION_TYPE_CAMERA_STREAM as u32, "camera"),
    (P::CEF_PERMISSION_TYPE_CLIPBOARD as u32, "clipboard_read"),
    (P::CEF_PERMISSION_TYPE_GEOLOCATION as u32, "geolocation"),
    (P::CEF_PERMISSION_TYPE_MIC_STREAM as u32, "microphone"),
    (P::CEF_PERMISSION_TYPE_NOTIFICATIONS as u32, "notifications"),
  ];
  let known = supported.iter().fold(0, |bits, (bit, _)| bits | bit);
  if mask == 0 || mask & !known != 0 {
    return None;
  }
  Some(
    supported
      .iter()
      .filter(|(bit, _)| mask & bit != 0)
      .map(|(_, kind)| (*kind).to_owned())
      .collect(),
  )
}
fn provenance_agrees(requesting: &str, top: &str, frame: Option<&str>) -> bool {
  canonical_origin(frame.unwrap_or(top)).as_deref() == Some(requesting)
}
fn origin(value: Option<&CefString>) -> Option<String> {
  canonical_origin(&value?.to_string())
}
fn canonical_origin(value: &str) -> Option<String> {
  let parsed = url::Url::parse(value).ok()?;
  if !matches!(parsed.scheme(), "http" | "https")
    || parsed.host_str().is_none()
    || !parsed.username().is_empty()
    || parsed.password().is_some()
  {
    return None;
  }
  Some(parsed.origin().ascii_serialization())
}
impl PermissionBridge {
  fn submit(
    self: &Arc<Self>,
    browser: &Browser,
    frame: Option<&Frame>,
    origin: String,
    kinds: Vec<String>,
    prompt_id: Option<u64>,
    answer: Answer,
  ) {
    let top_level_url = browser
      .main_frame()
      .map(|frame| CefString::from(&frame.url()).to_string())
      .unwrap_or_default();
    let frame_id = frame.map(|frame| CefString::from(&frame.identifier()).to_string());
    let frame_url = frame.map(|frame| CefString::from(&frame.url()).to_string());
    // Prompt APIs expose no frame. Reject a different requesting origin instead
    // of assuming Chromium's TOP_ORIGIN_ONLY persistence key matches DIVE's key.
    // Media exposes a frame, but CEF falls back to main when RFH lookup fails.
    if (prompt_id.is_some() && browser.frame_count() != 1)
      || !provenance_agrees(&origin, &top_level_url, frame_url.as_deref())
    {
      answer(None);
      return;
    }
    let check_browser = browser.clone();
    let check_frame = frame.cloned();
    let check_top = top_level_url.clone();
    let deadline = Instant::now() + DEADLINE;
    let id = {
      let mut state = self.state.lock().unwrap();
      state.next_id += 1;
      let id = state.next_id;
      state.pending.insert(
        id,
        Pending {
          frame_id: frame_id.clone(),
          prompt_id,
          deadline,
          answer,
          valid: Box::new(move || {
            check_browser.is_valid() != 0
              && check_browser
                .main_frame()
                .is_some_and(|frame| CefString::from(&frame.url()).to_string() == check_top)
              && check_frame.as_ref().is_none_or(|frame| {
                frame.is_valid() != 0
                  && Some(CefString::from(&frame.url()).to_string()) == frame_url
              })
          }),
        },
      );
      id
    };
    self.publish(NativePermissionRequest {
      page_lifetime: prompt_id.is_none(),
      id,
      origin,
      kinds,
      frame_id,
      top_level_url,
      deadline,
      bridge: self.clone(),
    });
  }
  fn publish(self: &Arc<Self>, request: NativePermissionRequest) {
    let handler = self.state.lock().unwrap().handler.clone();
    if let Some(handler) = handler {
      let mut timeout = PermissionTask::new(self.clone(), request.id, None);
      if cef::post_delayed_task(ThreadId::UI, Some(&mut timeout), 30_000) == 0 {
        self.complete(request.id, None);
        return;
      }
      handler(request);
    } else {
      self.complete(request.id, None);
    }
  }
  fn dismissed(&self, prompt_id: u64) {
    let ids = self
      .state
      .lock()
      .unwrap()
      .pending
      .iter()
      .filter(|(_, request)| request.prompt_id == Some(prompt_id))
      .map(|(id, _)| *id)
      .collect::<Vec<_>>();
    // CEF already dismissed the native callback; only forget it and notify UI.
    for id in ids {
      let (pending, cancel) = {
        let mut state = self.state.lock().unwrap();
        (state.pending.remove(&id), state.cancel.clone())
      };
      if pending.is_some() {
        if let Some(cancel) = cancel {
          cancel(id);
        }
      }
    }
  }
}
wrap_permission_handler! {
  pub struct TauriCefPermissionHandler { bridge: Arc<PermissionBridge> }
  impl PermissionHandler {
    fn on_request_media_access_permission(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, requesting_origin: Option<&CefString>, requested_permissions: u32, callback: Option<&mut MediaAccessCallback>) -> i32 {
      let Some(callback)=callback else {return 1;};
      if let (Some(browser),Some(frame),Some(origin),Some(kinds))=(browser,frame,origin(requesting_origin),media_kinds(requested_permissions)) {
        let callback=callback.clone();
        self.bridge.submit(browser,Some(frame),origin,kinds,None,Box::new(move |allow|{if allow == Some(true) {callback.cont(requested_permissions);} else {callback.cancel();}}));
      } else {callback.cancel();}
      1
    }
    fn on_show_permission_prompt(&self, browser: Option<&mut Browser>, prompt_id: u64, requesting_origin: Option<&CefString>, requested_permissions: u32, callback: Option<&mut PermissionPromptCallback>) -> i32 {
      let Some(callback)=callback else {return 1;};
      if let (Some(browser),Some(origin),Some(kinds))=(browser,origin(requesting_origin),prompt_kinds(requested_permissions)) {
        let callback=callback.clone();
        self.bridge.submit(browser,None,origin,kinds,Some(prompt_id),Box::new(move |allow|callback.cont(match allow {Some(true)=>PermissionRequestResult::ACCEPT,Some(false)=>PermissionRequestResult::DENY,None=>PermissionRequestResult::DISMISS})));
      } else {callback.cont(PermissionRequestResult::DISMISS);}
      1
    }
    fn on_dismiss_permission_prompt(&self, _browser: Option<&mut Browser>, prompt_id: u64, _result: PermissionRequestResult) {
      self.bridge.dismissed(prompt_id);
    }
  }
}
/// Keep diagnostics from silently bypassing the app's permission policy.
pub(crate) fn filter_command_line_args(args: &mut Vec<(String, Option<String>)>) {
  args.retain(|(name, _)| {
    let flag = name
      .trim_start_matches('-')
      .split('=')
      .next()
      .unwrap_or_default();
    let blocked = matches!(
      flag,
      "enable-media-stream"
        | "use-fake-ui-for-media-stream"
        | "auto-accept-camera-and-microphone-capture"
    );
    if blocked {
      log::warn!("Ignoring Chromium switch {flag}: it bypasses native permission policy");
    }
    !blocked
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn origin_provenance_rejects_cross_origin_prompt_and_media_frame_fallback() {
    assert!(provenance_agrees(
      "https://a.test",
      "https://a.test/path",
      None
    ));
    assert!(!provenance_agrees(
      "https://child.test",
      "https://a.test",
      None
    ));
    assert!(provenance_agrees(
      "https://child.test",
      "https://a.test",
      Some("https://child.test/frame")
    ));
    assert!(!provenance_agrees(
      "https://child.test",
      "https://a.test",
      Some("https://a.test")
    ));
    assert!(!provenance_agrees(
      "https://child.test",
      "https://a.test",
      Some("about:blank")
    ));
  }
  #[test]
  fn missing_application_handler_denies_original_native_request_immediately() {
    let bridge = Arc::new(PermissionBridge::default());
    let answers = Arc::new(Mutex::new(Vec::new()));
    let observed = answers.clone();
    bridge.state.lock().unwrap().pending.insert(
      1,
      Pending {
        frame_id: None,
        prompt_id: None,
        deadline: Instant::now() + DEADLINE,
        valid: Box::new(|| true),
        answer: Box::new(move |allow| observed.lock().unwrap().push(allow)),
      },
    );
    bridge.publish(NativePermissionRequest {
      page_lifetime: false,
      id: 1,
      origin: "https://example.test".into(),
      kinds: vec!["camera".into()],
      frame_id: None,
      top_level_url: "https://example.test".into(),
      deadline: Instant::now() + DEADLINE,
      bridge: bridge.clone(),
    });
    assert_eq!(*answers.lock().unwrap(), vec![None]);
    assert!(bridge.state.lock().unwrap().pending.is_empty());
  }
  #[test]
  fn diagnostic_switches_cannot_bypass_native_policy() {
    let mut flags = vec![
      ("--enable-media-stream".into(), None),
      ("use-fake-ui-for-media-stream".into(), None),
      ("--auto-accept-camera-and-microphone-capture".into(), None),
      ("--disable-gpu".into(), None),
    ];
    filter_command_line_args(&mut flags);
    assert_eq!(flags, vec![("--disable-gpu".into(), None)]);
  }
  #[test]
  fn unknown_native_bits_never_partially_grant_known_capabilities() {
    assert!(media_kinds(0).is_none());
    assert!(media_kinds(1 | 16).is_none());
    assert!(prompt_kinds(4 | 2).is_none());
    assert!(prompt_kinds(0).is_none());
    assert_eq!(media_kinds(3).unwrap(), vec!["microphone", "camera"]);
    assert_eq!(media_kinds(12).unwrap(), vec!["display_capture"]);
  }
  #[test]
  fn late_invalid_or_duplicate_answers_cannot_grant() {
    let bridge = PermissionBridge::default();
    let answers = Arc::new(Mutex::new(Vec::new()));
    for (id, deadline, valid) in [
      (1, Instant::now() - Duration::from_secs(1), true),
      (2, Instant::now() + DEADLINE, false),
      (3, Instant::now() + DEADLINE, true),
    ] {
      let answers = answers.clone();
      bridge.state.lock().unwrap().pending.insert(
        id,
        Pending {
          frame_id: None,
          prompt_id: None,
          deadline,
          valid: Box::new(move || valid),
          answer: Box::new(move |allow| answers.lock().unwrap().push((id, allow))),
        },
      );
    }
    for id in 1..=3 {
      bridge.complete(id, Some(true));
      bridge.complete(id, Some(true));
    }
    assert_eq!(
      *answers.lock().unwrap(),
      vec![(1, None), (2, None), (3, Some(true))]
    );
  }
  #[test]
  fn frame_navigation_cancels_affected_and_ambiguous_requests() {
    let bridge = PermissionBridge::default();
    let answers = Arc::new(Mutex::new(Vec::new()));
    for (id, frame) in [(1, Some("frame-a")), (2, Some("frame-b")), (3, None)] {
      let answers = answers.clone();
      bridge.state.lock().unwrap().pending.insert(
        id,
        Pending {
          frame_id: frame.map(str::to_owned),
          prompt_id: None,
          deadline: Instant::now() + DEADLINE,
          valid: Box::new(|| true),
          answer: Box::new(move |allow| answers.lock().unwrap().push((id, allow))),
        },
      );
    }
    bridge.invalidate(Some("frame-a".into()), false);
    assert_eq!(
      bridge
        .state
        .lock()
        .unwrap()
        .pending
        .keys()
        .copied()
        .collect::<Vec<_>>(),
      vec![2]
    );
    bridge.invalidate(None, true);
    assert!(bridge.state.lock().unwrap().pending.is_empty());
    assert!(
      answers
        .lock()
        .unwrap()
        .iter()
        .all(|(_, allow)| allow.is_none())
    );
  }
  #[test]
  fn native_prompt_dismissal_does_not_continue_an_already_dismissed_callback() {
    let bridge = PermissionBridge::default();
    let dismissed = Arc::new(Mutex::new(Vec::new()));
    let observed = dismissed.clone();
    bridge.state.lock().unwrap().cancel =
      Some(Arc::new(move |id| observed.lock().unwrap().push(id)));
    bridge.state.lock().unwrap().pending.insert(
      1,
      Pending {
        frame_id: None,
        prompt_id: Some(99),
        deadline: Instant::now() + DEADLINE,
        valid: Box::new(|| true),
        answer: Box::new(|_| panic!("CEF already dismissed callback")),
      },
    );
    bridge.dismissed(99);
    bridge.dismissed(99);
    bridge.complete(1, Some(true));
    assert_eq!(*dismissed.lock().unwrap(), vec![1]);
  }
}
