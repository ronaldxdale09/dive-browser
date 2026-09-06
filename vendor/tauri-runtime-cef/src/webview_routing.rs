// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Delivery policy for work queued before a browser changes native windows.

pub(crate) fn resolve_owner<W: Copy>(
  requested: W,
  follows_browser: bool,
  contains_browser: impl FnOnce(W) -> bool,
  find_browser: impl FnOnce() -> Option<W>,
  closing: impl FnOnce(W) -> bool,
) -> Option<W> {
  let owner = if contains_browser(requested) {
    requested
  } else if follows_browser {
    find_browser()?
  } else {
    return None;
  };
  (!closing(owner)).then_some(owner)
}

#[cfg(test)]
mod tests {
  use super::resolve_owner;
  use std::collections::HashMap;

  fn deliver(
    windows: &HashMap<u32, Vec<u32>>,
    requested: u32,
    browser: u32,
    follows_browser: bool,
    closing: &[u32],
  ) -> Option<u32> {
    resolve_owner(
      requested,
      follows_browser,
      |window| windows.get(&window).is_some_and(|children| children.contains(&browser)),
      || windows.iter().find_map(|(window, children)| children.contains(&browser).then_some(*window)),
      |window| closing.contains(&window),
    )
  }

  #[test]
  fn queued_page_work_follows_the_exact_browser_after_reparent() {
    let windows = HashMap::from([(1, vec![10]), (2, vec![20])]);
    assert_eq!(deliver(&windows, 1, 20, true, &[]), Some(2));
  }

  #[test]
  fn page_work_survives_old_window_destruction() {
    let windows = HashMap::from([(2, vec![20])]);
    assert_eq!(deliver(&windows, 1, 20, true, &[1]), Some(2));
  }

  #[test]
  fn stale_geometry_focus_and_reparent_work_does_not_follow() {
    let windows = HashMap::from([(1, vec![10]), (2, vec![20])]);
    assert_eq!(deliver(&windows, 1, 20, false, &[]), None);
  }

  #[test]
  fn removed_browser_does_not_route_to_a_replacement_in_either_window() {
    let windows = HashMap::from([(1, vec![10]), (2, vec![21])]);
    assert_eq!(deliver(&windows, 1, 20, true, &[]), None);
  }

  #[test]
  fn closing_destination_rejects_queued_browser_work() {
    let windows = HashMap::from([(1, vec![10]), (2, vec![20])]);
    assert_eq!(deliver(&windows, 1, 20, true, &[2]), None);
    assert_eq!(deliver(&windows, 2, 20, true, &[2]), None);
  }

  #[test]
  fn unchanged_owner_does_not_scan_other_windows() {
    assert_eq!(resolve_owner(1, true, |_| true, || panic!("unnecessary scan"), |_| false), Some(1));
  }
}
