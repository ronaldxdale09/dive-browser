//! Chromium 151 native permission cache reconciliation. This is independent of
//! DIVE's remembered decision store; resetting a cache never grants permission.
use cef::*;
use serde_json::{Value as Json, json};
use std::sync::{Arc, Mutex, Weak};

#[derive(Clone, Copy)]
struct Setting {
  name: &'static str,
  kind: &'static str,
  native: ContentSettingTypes,
}
const SETTINGS: &[Setting] = &[
  Setting {
    name: "media_stream_camera",
    kind: "camera",
    native: ContentSettingTypes::MEDIASTREAM_CAMERA,
  },
  Setting {
    name: "media_stream_mic",
    kind: "microphone",
    native: ContentSettingTypes::MEDIASTREAM_MIC,
  },
  Setting {
    name: "geolocation",
    kind: "geolocation",
    native: ContentSettingTypes::GEOLOCATION,
  },
  Setting {
    name: "geolocation_with_options",
    kind: "geolocation",
    native: ContentSettingTypes::GEOLOCATION_WITH_OPTIONS,
  },
  Setting {
    name: "notifications",
    kind: "notifications",
    native: ContentSettingTypes::NOTIFICATIONS,
  },
  Setting {
    name: "clipboard",
    kind: "clipboard_read",
    native: ContentSettingTypes::CLIPBOARD_READ_WRITE,
  },
];
fn ask(setting: Setting) -> Json {
  if setting.name == "geolocation_with_options" {
    json!({"approximate":3,"precise":3})
  } else {
    json!(3)
  }
}
const EMBARGO_PREF: &str = "profile.content_settings.exceptions.permission_autoblocking_data";
fn embargo_keys(kind: &str) -> &'static [&'static str] {
  match kind {
    "camera" => &["VideoCapture"],
    "microphone" => &["AudioCapture"],
    "geolocation" => &["Geolocation", "GeolocationApproximate"],
    "notifications" => &["Notifications"],
    "clipboard_read" => &["ClipboardReadWrite"],
    _ => &[],
  }
}
fn remove_embargo(value: &mut Json, kind: &str) {
  if let Some(dict) = value.as_object_mut() {
    for key in embargo_keys(kind) {
      dict.remove(*key);
    }
  }
}
trait Cache {
  fn write_pref(&self, name: &str, value: &Json) -> Result<(), String>;
  fn embargo(&self, origin: &str) -> Result<Json, String>;
  fn write_embargo(&self, origin: &str, value: &Json) -> Result<(), String>;
  fn pref(&self, name: &str) -> Result<Json, String>;
  fn clear_pref(&self, name: &str) -> Result<(), String>;
  fn setting(&self, origin: &str, setting: Setting) -> Result<Json, String>;
  fn clear_setting(&self, origin: &str, setting: Setting) -> Result<(), String>;
}
fn initialize(cache: &impl Cache) -> Result<(), String> {
  for setting in SETTINGS {
    for prefix in [
      "profile.content_settings.exceptions",
      "profile.content_settings.partitioned_exceptions",
      "profile.default_content_setting_values",
    ] {
      let name = format!("{prefix}.{}", setting.name);
      cache.clear_pref(&name)?;
      let expected = if prefix.contains("default") {
        ask(*setting)
      } else {
        json!({})
      };
      if cache.pref(&name)? != expected {
        return Err(format!(
          "Permission cache reset did not take effect: {name}"
        ));
      }
    }
  }
  let mut data = cache.pref(EMBARGO_PREF)?;
  if let Some(entries) = data.as_object_mut() {
    for entry in entries.values_mut() {
      if let Some(setting) = entry.get_mut("setting") {
        for setting_type in SETTINGS {
          remove_embargo(setting, setting_type.kind);
        }
      }
    }
  } else {
    return Err("Invalid native permission embargo preference".into());
  }
  cache.write_pref(EMBARGO_PREF, &data)?;
  if cache.pref(EMBARGO_PREF)? != data {
    return Err("Permission embargo reset did not take effect".into());
  }
  Ok(())
}
fn reset_origin(cache: &impl Cache, origin: &str, kind: &str) -> Result<(), String> {
  for setting in SETTINGS.iter().filter(|setting| setting.kind == kind) {
    cache.clear_setting(origin, *setting)?;
    if cache.setting(origin, *setting)? != ask(*setting) {
      return Err(format!(
        "Native permission reset did not take effect for {origin} ({kind})"
      ));
    }
  }
  let mut embargo = cache.embargo(origin)?;
  remove_embargo(&mut embargo, kind);
  cache.write_embargo(origin, &embargo)?;
  if cache.embargo(origin)? != embargo {
    return Err("Permission embargo reset did not take effect".into());
  }
  Ok(())
}

pub(super) struct ContextLease(RequestContext);
static CONTEXTS: Mutex<Vec<Weak<ContextLease>>> = Mutex::new(Vec::new());
impl ContextLease {
  pub(super) fn acquire(context: &RequestContext) -> Result<Arc<Self>, String> {
    if cef::currently_on(ThreadId::UI) == 0 {
      return Err("Permission context requires CEF UI".into());
    }
    let mut contexts = CONTEXTS.lock().unwrap();
    contexts.retain(|context| context.strong_count() > 0);
    for existing in contexts.iter().filter_map(Weak::upgrade) {
      if context.is_sharing_with(Some(&mut existing.0.clone())) != 0 {
        return Ok(existing);
      }
    }
    let lease = Arc::new(Self(context.clone()));
    initialize(lease.as_ref())?;
    contexts.push(Arc::downgrade(&lease));
    Ok(lease)
  }
  pub(super) fn reset(&self, origin: &str, kind: &str) -> Result<(), String> {
    if cef::currently_on(ThreadId::UI) == 0 {
      return Err("Permission context requires CEF UI".into());
    }
    reset_origin(self, origin, kind)
  }
}
fn json_value(mut value: Value) -> Result<Json, String> {
  let encoded = cef::write_json(Some(&mut value), JsonWriterOptions::DEFAULT);
  serde_json::from_str(&CefString::from(&encoded).to_string()).map_err(|error| error.to_string())
}
fn cef_value(value: &Json) -> Result<Value, String> {
  cef::parse_json(
    Some(&value.to_string().as_str().into()),
    JsonParserOptions::RFC,
  )
  .ok_or_else(|| "Invalid native permission JSON".into())
}
impl Cache for ContextLease {
  fn write_pref(&self, name: &str, value: &Json) -> Result<(), String> {
    // Default is a null CEF string pointer, invalid for this required out-param.
    let mut error = CefString::from("");
    let mut value = cef_value(value)?;
    if self
      .0
      .set_preference(Some(&name.into()), Some(&mut value), Some(&mut error))
      == 0
    {
      return Err(format!("Cannot write native preference {name}: {error}"));
    }
    Ok(())
  }
  fn embargo(&self, origin: &str) -> Result<Json, String> {
    let value = self.0.website_setting(
      Some(&origin.into()),
      Some(&CefString::from("")),
      ContentSettingTypes::PERMISSION_AUTOBLOCKER_DATA,
    );
    let value = value.map(json_value).transpose()?.unwrap_or(Json::Null);
    Ok(if value.is_null() { json!({}) } else { value })
  }
  fn write_embargo(&self, origin: &str, value: &Json) -> Result<(), String> {
    let mut value = cef_value(value)?;
    self.0.set_website_setting(
      Some(&origin.into()),
      Some(&CefString::from("")),
      ContentSettingTypes::PERMISSION_AUTOBLOCKER_DATA,
      Some(&mut value),
    );
    Ok(())
  }
  fn pref(&self, name: &str) -> Result<Json, String> {
    self
      .0
      .preference(Some(&name.into()))
      .ok_or_else(|| format!("Missing native preference {name}"))
      .and_then(json_value)
  }
  fn clear_pref(&self, name: &str) -> Result<(), String> {
    // Default is a null CEF string pointer, invalid for this required out-param.
    let mut error = CefString::from("");
    if self
      .0
      .set_preference(Some(&name.into()), None, Some(&mut error))
      == 0
    {
      return Err(format!("Cannot reset native preference {name}: {error}"));
    }
    Ok(())
  }
  fn setting(&self, origin: &str, setting: Setting) -> Result<Json, String> {
    let origin = CefString::from(origin);
    self
      .0
      .website_setting(Some(&origin), Some(&origin), setting.native)
      .ok_or_else(|| "Native permission setting unavailable".into())
      .and_then(json_value)
  }
  fn clear_setting(&self, origin: &str, setting: Setting) -> Result<(), String> {
    let origin = CefString::from(origin);
    self
      .0
      .set_website_setting(Some(&origin), Some(&origin), setting.native, None);
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;
  #[derive(Default)]
  struct Fake {
    prefs: Mutex<HashMap<String, Json>>,
    settings: Mutex<HashMap<(String, String), Json>>,
    fail: bool,
  }
  impl Cache for Fake {
    fn write_pref(&self, name: &str, value: &Json) -> Result<(), String> {
      if self.fail {
        return Err("native write failed".into());
      }
      self
        .prefs
        .lock()
        .unwrap()
        .insert(name.into(), value.clone());
      Ok(())
    }
    fn embargo(&self, origin: &str) -> Result<Json, String> {
      self.pref(origin)
    }
    fn write_embargo(&self, origin: &str, value: &Json) -> Result<(), String> {
      self.write_pref(origin, value)
    }
    fn pref(&self, name: &str) -> Result<Json, String> {
      Ok(
        self
          .prefs
          .lock()
          .unwrap()
          .get(name)
          .cloned()
          .unwrap_or_else(|| {
            if name.starts_with("profile.default_content") {
              if name.ends_with("geolocation_with_options") {
                json!({"approximate":3,"precise":3})
              } else {
                json!(3)
              }
            } else {
              json!({})
            }
          }),
      )
    }
    fn clear_pref(&self, name: &str) -> Result<(), String> {
      if self.fail {
        return Err("native reset failed".into());
      }
      self.prefs.lock().unwrap().remove(name);
      Ok(())
    }
    fn setting(&self, origin: &str, setting: Setting) -> Result<Json, String> {
      Ok(
        self
          .settings
          .lock()
          .unwrap()
          .get(&(origin.into(), setting.name.into()))
          .cloned()
          .unwrap_or_else(|| ask(setting)),
      )
    }
    fn clear_setting(&self, origin: &str, setting: Setting) -> Result<(), String> {
      if self.fail {
        return Err("native reset failed".into());
      }
      self
        .settings
        .lock()
        .unwrap()
        .remove(&(origin.into(), setting.name.into()));
      Ok(())
    }
  }
  #[test]
  fn startup_removes_only_supported_legacy_native_grants_and_verifies_failures() {
    let cache = Fake::default();
    cache.prefs.lock().unwrap().insert(EMBARGO_PREF.into(),json!({"https://a.test,*":{"setting":{"Notifications":{"dismiss_count":3},"Midi":{"dismiss_count":4}},"last_modified":"42"}}));
    cache.prefs.lock().unwrap().insert(
      "profile.content_settings.exceptions.notifications".into(),
      json!({"https://old.test,*":{"setting":1}}),
    );
    cache
      .prefs
      .lock()
      .unwrap()
      .insert("unrelated.setting".into(), json!(7));
    initialize(&cache).unwrap();
    assert_eq!(
      cache
        .pref("profile.content_settings.exceptions.notifications")
        .unwrap(),
      json!({})
    );
    assert_eq!(cache.pref("unrelated.setting").unwrap(), json!(7));
    assert_eq!(
      cache.pref(EMBARGO_PREF).unwrap(),
      json!({"https://a.test,*":{"setting":{"Midi":{"dismiss_count":4}},"last_modified":"42"}})
    );
    assert!(
      initialize(&Fake {
        fail: true,
        ..Fake::default()
      })
      .is_err()
    );
  }
  #[test]
  fn reset_clears_scalar_and_structured_origin_grants_without_changing_siblings() {
    let cache = Fake::default();
    for setting in SETTINGS {
      cache
        .settings
        .lock()
        .unwrap()
        .insert(("https://a.test".into(), setting.name.into()), json!(1));
      cache
        .settings
        .lock()
        .unwrap()
        .insert(("https://b.test".into(), setting.name.into()), json!(1));
    }
    cache.prefs.lock().unwrap().insert("https://a.test".into(),json!({"Geolocation":{"dismiss_count":3},"GeolocationApproximate":{"ignore_count":4},"Notifications":{"dismiss_count":2}}));
    reset_origin(&cache, "https://a.test", "geolocation").unwrap();
    assert_eq!(
      cache.embargo("https://a.test").unwrap(),
      json!({"Notifications":{"dismiss_count":2}})
    );
    for setting in SETTINGS
      .iter()
      .filter(|setting| setting.kind == "geolocation")
    {
      assert_eq!(
        cache.setting("https://a.test", *setting).unwrap(),
        ask(*setting)
      );
      assert_eq!(cache.setting("https://b.test", *setting).unwrap(), json!(1));
    }
    assert!(
      reset_origin(
        &Fake {
          fail: true,
          ..Fake::default()
        },
        "https://a.test",
        "notifications"
      )
      .is_err()
    );
  }
}
