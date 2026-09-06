//! CEF asks Skip before headers, although protocol responses already contain the selected range.

pub(super) fn acknowledge_skip(
  status: u16,
  content_range: Option<&str>,
  body_length: usize,
  body_position: u64,
  bytes_to_skip: i64,
) -> Option<i64> {
  if status != 206 || body_position != 0 || bytes_to_skip <= 0 {
    return None;
  }
  let range = content_range?.strip_prefix("bytes ")?;
  let (bounds, total) = range.split_once('/')?;
  let (start, end) = bounds.split_once('-')?;
  let decimal = |value: &str| {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
      return None;
    }
    value.parse::<u64>().ok()
  };
  let (start, end, total) = (decimal(start)?, decimal(end)?, decimal(total)?);
  if start != bytes_to_skip as u64 || end >= total {
    return None;
  }
  let selected_length = end.checked_sub(start)?.checked_add(1)?;
  (u64::try_from(body_length).ok()? == selected_length).then_some(bytes_to_skip)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Cursor, Read};

  #[test]
  fn cef_skip_then_headers_then_reads_preserves_the_complete_selected_body() {
    // The original resource is larger; Tauri has already selected this range.
    let original: Vec<u8> = (0..=255).cycle().take(2048).collect();
    let mut body = Cursor::new(original[1025..1032].to_vec());
    let status = 206;
    let range = "bytes 1025-1031/2048";
    assert_eq!(
      acknowledge_skip(
        status,
        Some(range),
        body.get_ref().len(),
        body.position(),
        1025
      ),
      Some(1025)
    );
    // Header/body ownership stays with the protocol response. No second seek.
    assert_eq!(status, 206);
    assert_eq!(range, "bytes 1025-1031/2048");
    assert_eq!(body.position(), 0);
    let mut first = [0; 2];
    body.read_exact(&mut first).unwrap();
    assert_eq!(first, [1, 2]);
    let mut rest = Vec::new();
    body.read_to_end(&mut rest).unwrap();
    assert_eq!([first.to_vec(), rest].concat(), original[1025..1032]);
    assert_eq!(body.read(&mut first).unwrap(), 0);
  }

  #[test]
  fn only_a_complete_matching_partial_body_can_acknowledge_skip() {
    for (range, len, pos, skip) in [
      ("bytes 1025-1031/2048", 7, 0, 1024),
      ("bytes 1025-1031/2048", 6, 0, 1025),
      ("bytes 1025-1031/2048", 7, 1, 1025),
      ("bytes 1025-1031/2048", 7, 0, -1),
      ("bytes 0-6/2048", 7, 0, 0),
      ("bytes 1025-1031/1031", 7, 0, 1025),
      ("bytes 1031-1025/2048", 7, 0, 1031),
      ("bytes 1025-1031/*", 7, 0, 1025),
      ("bytes +1025-1031/2048", 7, 0, 1025),
      ("bytes 1025-1031/2048,2049-2050/4096", 7, 0, 1025),
    ] {
      assert_eq!(
        acknowledge_skip(206, Some(range), len, pos, skip),
        None,
        "{range}"
      );
    }
    assert_eq!(acknowledge_skip(206, None, 7, 0, 1025), None);
  }

  #[test]
  fn full_and_error_response_skip_behavior_remains_rejected() {
    for status in [200, 302, 403, 404, 416, 500] {
      assert_eq!(
        acknowledge_skip(status, Some("bytes 1025-1031/2048"), 7, 0, 1025),
        None
      );
    }
  }
}
