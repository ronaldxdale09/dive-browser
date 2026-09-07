//! The live page rectangles left visible around chrome overlays.
//! Subtraction yields disjoint holes, including when dialogs overlap.
pub(crate) fn uncovered(pages: &[[f64; 4]], overlays: &[[f64; 4]]) -> Vec<[f64; 4]> {
    let mut holes = pages.to_vec();
    for [ox, oy, ow, oh] in overlays {
        holes = holes
            .into_iter()
            .flat_map(|[x, y, w, h]| {
                let left = x.max(*ox);
                let top = y.max(*oy);
                let right = (x + w).min(ox + ow);
                let bottom = (y + h).min(oy + oh);
                if left >= right || top >= bottom {
                    return vec![[x, y, w, h]];
                }
                [
                    [x, y, w, top - y],
                    [x, bottom, w, y + h - bottom],
                    [x, top, left - x, bottom - top],
                    [right, top, x + w - right, bottom - top],
                ]
                .into_iter()
                .filter(|rect| rect[2] > 0.0 && rect[3] > 0.0)
                .collect()
            })
            .collect();
    }
    holes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_dialogs_never_cut_each_other_out() {
        let holes = uncovered(
            &[[0.0, 0.0, 100.0, 100.0]],
            &[[50.0, 0.0, 50.0, 60.0], [40.0, 40.0, 60.0, 60.0]],
        );
        let area: f64 = holes.iter().map(|r| r[2] * r[3]).sum();
        assert!((area - 4400.0).abs() < f64::EPSILON);
        for [x, y, w, h] in holes {
            assert!(!(x < 100.0 && x + w > 50.0 && y < 60.0 && y + h > 0.0));
            assert!(!(x < 100.0 && x + w > 40.0 && y < 100.0 && y + h > 40.0));
        }
    }
    #[test]
    fn outside_partial_and_full_cover_are_clipped_to_the_page() {
        let page = [[10.0, 20.0, 100.0, 80.0]];
        assert_eq!(uncovered(&page, &[[200.0, 200.0, 10.0, 10.0]]), page);
        assert!(uncovered(&page, &[[0.0, 0.0, 500.0, 500.0]]).is_empty());
        assert_eq!(
            uncovered(&page, &[[0.0, 0.0, 30.0, 100.0]]),
            vec![[30.0, 20.0, 80.0, 80.0]]
        );
    }
}
