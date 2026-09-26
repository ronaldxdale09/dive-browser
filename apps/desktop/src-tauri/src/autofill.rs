//! Addresses and payment cards, for the forms that ask for them.
//!
//! Dive already remembered what was typed into a field and offered it back,
//! which fills a name but not a checkout: those want a street, a city and a
//! postcode together, and a card number that is not lying in a database.
//!
//! An address is ordinary data and lives in the store whole. A card does not:
//! the row keeps the last four digits, and the number itself is a keychain
//! item under the row's id, the way a password is. Filling one is always the
//! person's own click -- nothing here fills a form on its own.

use dive_core::{Address, Card, ProfileId, Timestamp};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

const SERVICE: &str = "app.dive.browser.cards";

fn entry(id: &str) -> AppResult<keyring_core::Entry> {
    keyring_core::Entry::new(SERVICE, id).map_err(AppError::new)
}

/// A card as it is saved: the number is here, on its way to the keychain,
/// and nowhere else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CardDraft {
    pub label: String,
    pub cardholder: String,
    /// Digits, with or without the spaces a person types.
    pub number: String,
    pub expiry_month: u32,
    pub expiry_year: u32,
}

/// What a page gets to fill a checkout: an address, a card without its
/// number, or a card with one when the person picked it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CardFill {
    pub cardholder: String,
    pub number: String,
    pub expiry_month: u32,
    pub expiry_year: u32,
}

/// Just the digits of a typed card number.
pub fn digits(number: &str) -> String {
    number.chars().filter(char::is_ascii_digit).collect()
}

/// Whether a card number passes the Luhn check every issuer's numbers do.
/// A typo caught here is one that would have failed at the checkout.
pub fn luhn_ok(number: &str) -> bool {
    let digits = digits(number);
    if !(12..=19).contains(&digits.len()) {
        return false;
    }
    let sum: u32 = digits
        .chars()
        .rev()
        .enumerate()
        .map(|(index, c)| {
            let value = c.to_digit(10).unwrap_or(0);
            if index.is_multiple_of(2) {
                value
            } else if value > 4 {
                value * 2 - 9
            } else {
                value * 2
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

/// The card network a number belongs to, by the prefixes the networks own.
pub fn brand_of(number: &str) -> String {
    let digits = digits(number);
    let two: u32 = digits.get(0..2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let four: u32 = digits.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(0);
    match digits.as_bytes().first() {
        Some(b'4') => "visa".into(),
        Some(b'5') if (51..=55).contains(&two) => "mastercard".into(),
        Some(b'2') if (2221..=2720).contains(&four) => "mastercard".into(),
        Some(b'3') if two == 34 || two == 37 => "amex".into(),
        Some(b'6') if digits.starts_with("6011") || two == 65 => "discover".into(),
        _ => String::new(),
    }
}

/// A card's expiry as saved: a real month and a four-digit year, not in the
/// past. A two-digit year is the one printed on the card, so "30" means
/// 2030; read as the year 30 it was refused as long expired.
pub fn normalize_expiry(month: u32, year: u32, now: (u32, u32)) -> Result<(u32, u32), String> {
    if !(1..=12).contains(&month) {
        return Err(format!(
            "{month} is not a valid month; use a number from 1 to 12"
        ));
    }
    let year = if year < 100 { 2000 + year } else { year };
    if !(2000..=2100).contains(&year) {
        return Err(format!(
            "{year} is not a valid year; use two or four digits, like 30 or 2030"
        ));
    }
    if (year, month) < (now.1, now.0) {
        return Err(format!("that expiry date ({month:02}/{year}) has passed"));
    }
    Ok((month, year))
}

/// Save an address. A new one gets an id; an existing id is updated.
pub fn save_address(
    state: &AppState,
    profile: ProfileId,
    mut address: Address,
) -> AppResult<Address> {
    if address.label.trim().is_empty() && address.name.trim().is_empty() {
        return Err(AppError::new("an address needs a name or a label"));
    }
    if address.id.is_empty() {
        address.id = dive_core::TabId::new().to_string();
        address.created_at = Timestamp::now().to_rfc3339();
    }
    address.profile_id = profile.to_string();
    lock(&state.store).upsert_address(&address)?;
    Ok(address)
}

/// Save a card: the listing row in the store, the number in the keychain.
pub fn save_card(state: &AppState, profile: ProfileId, draft: &CardDraft) -> AppResult<Card> {
    let number = digits(&draft.number);
    if !luhn_ok(&number) {
        return Err(AppError::new("that does not look like a card number"));
    }
    let now = Timestamp::now();
    let (expiry_month, expiry_year) = normalize_expiry(
        draft.expiry_month,
        draft.expiry_year,
        current_month_year(now),
    )
    .map_err(AppError::new)?;
    let card = Card {
        id: dive_core::TabId::new().to_string(),
        profile_id: profile.to_string(),
        label: draft.label.trim().chars().take(60).collect(),
        cardholder: draft.cardholder.trim().chars().take(100).collect(),
        last4: number
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
        brand: brand_of(&number),
        expiry_month,
        expiry_year,
        created_at: now.to_rfc3339(),
        last_used_at: None,
        uses: 0,
    };
    // The keychain first: a row whose number never made it is a card that
    // silently fails to fill, which is worse than a save that failed.
    entry(&card.id)?
        .set_password(&number)
        .map_err(AppError::new)?;
    if let Err(error) = lock(&state.store).upsert_card(&card) {
        let _ = entry(&card.id).and_then(|e| e.delete_credential().map_err(AppError::new));
        return Err(error.into());
    }
    Ok(card)
}

/// The card's details, number included, for one fill the person asked for.
pub fn card_fill(state: &AppState, profile: ProfileId, id: &str) -> AppResult<CardFill> {
    let card = {
        let store = lock(&state.store);
        store
            .cards(profile)?
            .into_iter()
            .find(|card| card.id == id)
            .ok_or_else(|| AppError::new("no such card"))?
    };
    let number = entry(id)?
        .get_password()
        .map_err(|error| AppError::new(format!("the card number could not be read: {error}")))?;
    lock(&state.store).card_used(id, Timestamp::now())?;
    Ok(CardFill {
        cardholder: card.cardholder,
        number,
        expiry_month: card.expiry_month,
        expiry_year: card.expiry_year,
    })
}

/// Forget a card, keychain item and all.
pub fn delete_card(state: &AppState, profile: ProfileId, id: &str) -> AppResult<bool> {
    let mine = lock(&state.store)
        .cards(profile)?
        .iter()
        .any(|card| card.id == id);
    if !mine {
        return Ok(false);
    }
    // The number goes first, and the row only once it has. Removing the row
    // first and ignoring a refused keychain delete left the number in the OS
    // store with nothing in Dive that could ever name it again.
    delete_card_secret(id).map_err(|error| {
        AppError::new(format!(
            "the card number could not be removed, so the card was kept: {}",
            error.message
        ))
    })?;
    Ok(lock(&state.store).remove_card(profile, id)?)
}

/// Remove the number behind card `id`, whose row is about to go with its
/// profile. An item already gone counts as removed.
pub fn delete_card_secret(id: &str) -> AppResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(AppError::new(error)),
    }
}

/// Put a saved address, or a card, into the tab's form. Returns how many
/// fields were filled -- zero means nothing on the page looked like one.
pub async fn fill_into(
    state: &AppState,
    tab_id: dive_core::TabId,
    what: &str,
    value: &serde_json::Value,
) -> AppResult<u32> {
    let session = {
        let host = lock(&state.host);
        host.as_ref()
            .and_then(|host| {
                host.sessions()
                    .into_iter()
                    .find_map(|(id, session)| (id == tab_id).then_some(session))
            })
            .ok_or_else(|| AppError::new("this tab is not loaded"))?
    };
    let source = crate::pagescript::build("autofill.js", &[]);
    let _ = session
        .call(
            "Runtime.evaluate",
            serde_json::json!({"expression": source}),
        )
        .await;
    let expression = format!("window.__diveFill{what}({value})");
    let result = session
        .call(
            "Runtime.evaluate",
            serde_json::json!({"expression": expression, "returnByValue": true}),
        )
        .await
        .map_err(|error| AppError::new(format!("this form could not be filled: {error}")))?;
    Ok(result["result"]["value"]["filled"]
        .as_u64()
        .unwrap_or(0)
        .try_into()
        .unwrap_or(u32::MAX))
}

fn current_month_year(now: Timestamp) -> (u32, u32) {
    let text = now.to_rfc3339();
    let year = text.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(2000);
    let month = text.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(1);
    (month, year)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catches_a_mistyped_card_number() {
        // Test numbers every payment processor publishes.
        assert!(luhn_ok("4242 4242 4242 4242"));
        assert!(luhn_ok("5555555555554444"));
        assert!(luhn_ok("378282246310005"));
        // One digit wrong, which is what a typo looks like.
        assert!(!luhn_ok("4242424242424241"));
        assert!(!luhn_ok("1234"));
        assert!(!luhn_ok(""));
        assert!(!luhn_ok("not a card"));
    }

    #[test]
    fn names_the_network_from_the_number() {
        assert_eq!(brand_of("4242424242424242"), "visa");
        assert_eq!(brand_of("5555 5555 5555 4444"), "mastercard");
        assert_eq!(brand_of("2223003122003222"), "mastercard");
        assert_eq!(brand_of("378282246310005"), "amex");
        assert_eq!(brand_of("6011111111111117"), "discover");
        assert_eq!(brand_of("9999999999999999"), "");
    }

    #[test]
    fn refuses_an_expiry_that_has_passed() {
        let now = (9, 2026);
        assert_eq!(normalize_expiry(9, 2026, now), Ok((9, 2026)));
        assert_eq!(normalize_expiry(1, 2030, now), Ok((1, 2030)));
        assert!(
            normalize_expiry(8, 2026, now)
                .unwrap_err()
                .contains("passed")
        );
        assert!(
            normalize_expiry(12, 2025, now)
                .unwrap_err()
                .contains("passed")
        );
        // Not a month at all.
        assert!(
            normalize_expiry(0, 2030, now)
                .unwrap_err()
                .contains("not a valid month")
        );
        assert!(
            normalize_expiry(13, 2030, now)
                .unwrap_err()
                .contains("not a valid month")
        );
        assert!(
            normalize_expiry(6, 1999, now)
                .unwrap_err()
                .contains("not a valid year")
        );
    }

    #[test]
    fn a_two_digit_year_is_this_century() {
        let now = (9, 2026);
        assert_eq!(normalize_expiry(9, 30, now), Ok((9, 2030)));
        assert_eq!(normalize_expiry(9, 26, now), Ok((9, 2026)));
        assert!(
            normalize_expiry(1, 25, now)
                .unwrap_err()
                .contains("01/2025")
        );
    }

    #[test]
    fn keeps_only_the_digits() {
        assert_eq!(digits("4242-4242 4242_4242"), "4242424242424242");
        assert_eq!(digits("abc"), "");
    }
}
