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

/// The card's details for one fill the person asked for. The number is read
/// from the keychain only when the page has a field for it.
pub fn card_fill(
    state: &AppState,
    profile: ProfileId,
    id: &str,
    with_number: bool,
) -> AppResult<CardFill> {
    let card = {
        let store = lock(&state.store);
        store
            .cards(profile)?
            .into_iter()
            .find(|card| card.id == id)
            .ok_or_else(|| AppError::new("no such card"))?
    };
    let number = if with_number {
        entry(id)?
            .get_password()
            .map_err(|error| AppError::new(format!("the card number could not be read: {error}")))?
    } else {
        String::new()
    };
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

/// The kinds of field an address fills, and the address field each takes.
/// The names are the page script's (`MATCHERS` in autofill.js).
const ADDRESS_KINDS: &[(&str, &str)] = &[
    ("name", "name"),
    ("given-name", "name"),
    ("family-name", "name"),
    ("organization", "organization"),
    ("address-line1", "street"),
    ("address-line2", "street"),
    ("address-level2", "city"),
    ("address-level1", "region"),
    ("postal-code", "postal_code"),
    ("country", "country"),
    ("tel", "phone"),
    ("email", "email"),
];

/// The kinds of field a card fills, and the card field each takes.
const CARD_KINDS: &[(&str, &str)] = &[
    ("cc-name", "cardholder"),
    ("cc-number", "number"),
    ("cc-exp-month", "expiry_month"),
    ("cc-exp-year", "expiry_year"),
    ("cc-exp", "expiry_month"),
    ("cc-exp", "expiry_year"),
];

/// What the person picked to fill.
pub enum Wallet<'a> {
    Address(&'a dive_core::Address),
    /// A card, by id: its details are read only once the page has shown it
    /// has fields for them.
    Card(&'a str),
}

/// Only the fields of `full` that a kind present on the page takes. A
/// checkout that asks for a postcode and a card number is sent those, not
/// the phone number and the street it never asked for.
pub fn fields_for_page(
    full: &serde_json::Value,
    table: &[(&str, &str)],
    present: &[String],
) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for (kind, field) in table {
        if present.iter().any(|p| p == kind)
            && let Some(value) = full.get(*field)
        {
            out.insert((*field).to_owned(), value.clone());
        }
    }
    serde_json::Value::Object(out)
}

/// Put a saved address, or a card, into the tab's form. Returns how many
/// fields were filled -- zero means nothing on the page looked like one.
///
/// `page_url` is the page the person saw when they picked: the fill goes to
/// a document of that origin or nowhere, checked when the page is asked what
/// it has and again in the evaluation that fills. Everything runs in Dive's
/// isolated world, where the page cannot stand in for the fill function.
pub async fn fill_into(
    state: &AppState,
    tab_id: dive_core::TabId,
    profile: ProfileId,
    page_url: &str,
    what: Wallet<'_>,
) -> AppResult<u32> {
    let origin = crate::passwords::origin_of(page_url)
        .map_err(|_| AppError::new("this page cannot be filled"))?;
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
    let failed = |error: dive_cdp::CdpError| {
        AppError::new(format!("this form could not be filled: {error}"))
    };
    let context = crate::page_world::context(&session).await.map_err(failed)?;
    let source = crate::pagescript::build("autofill.js", &[]);
    crate::page_world::evaluate_in(&session, context, serde_json::json!({"expression": source}))
        .await
        .map_err(failed)?;
    let (table, function) = match what {
        Wallet::Address(_) => (ADDRESS_KINDS, "__diveFillAddress"),
        Wallet::Card(_) => (CARD_KINDS, "__diveFillCard"),
    };
    let kinds: Vec<&str> = table.iter().map(|(kind, _)| *kind).collect();
    let probe = crate::page_world::evaluate_in(
        &session,
        context,
        serde_json::json!({
            "expression": format!(
                "({{origin: location.origin, kinds: window.__diveAutofillKinds({})}})",
                serde_json::to_string(&kinds).unwrap_or_else(|_| "[]".into())
            ),
            "returnByValue": true,
        }),
    )
    .await
    .map_err(failed)?;
    let probe = &probe["result"]["value"];
    if probe["origin"].as_str() != Some(origin.as_str()) {
        return Err(AppError::new(
            "the page changed before it could be filled; pick again",
        ));
    }
    let present: Vec<String> = probe["kinds"]
        .as_array()
        .map(|kinds| {
            kinds
                .iter()
                .filter_map(|kind| kind.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if present.is_empty() {
        return Ok(0);
    }
    let full = match what {
        Wallet::Address(address) => serde_json::to_value(address).map_err(AppError::new)?,
        Wallet::Card(id) => {
            let fill = card_fill(state, profile, id, present.iter().any(|k| k == "cc-number"))?;
            serde_json::to_value(&fill).map_err(AppError::new)?
        }
    };
    let value = fields_for_page(&full, table, &present);
    let expression = format!(
        "location.origin === {} ? window.{function}({value}) : {{filled: 0, moved: true}}",
        serde_json::to_string(&origin).unwrap_or_default()
    );
    let result = crate::page_world::evaluate_in(
        &session,
        context,
        serde_json::json!({"expression": expression, "returnByValue": true}),
    )
    .await
    .map_err(failed)?;
    let answer = &result["result"]["value"];
    if answer["moved"] == true {
        return Err(AppError::new(
            "the page changed before it could be filled; pick again",
        ));
    }
    Ok(answer["filled"]
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
    fn a_page_is_sent_only_what_its_fields_take() {
        let card = serde_json::json!({
            "cardholder": "Dale", "number": "4242424242424242",
            "expiry_month": 9, "expiry_year": 2030
        });
        // An expiry field and a name, but nowhere for the number.
        let sent = fields_for_page(&card, CARD_KINDS, &["cc-exp".into(), "cc-name".into()]);
        assert_eq!(
            sent,
            serde_json::json!({"cardholder": "Dale", "expiry_month": 9, "expiry_year": 2030})
        );
        let address = serde_json::json!({
            "id": "a1", "label": "Home", "name": "Dale", "street": "1 Road",
            "postal_code": "6000", "phone": "123", "email": "d@a.test"
        });
        assert_eq!(
            fields_for_page(
                &address,
                ADDRESS_KINDS,
                &["postal-code".into(), "given-name".into()]
            ),
            serde_json::json!({"name": "Dale", "postal_code": "6000"})
        );
        assert_eq!(
            fields_for_page(&address, ADDRESS_KINDS, &[]),
            serde_json::json!({})
        );
    }

    #[test]
    fn the_kinds_asked_about_are_the_ones_the_page_script_knows() {
        let script = crate::pagescript::build("autofill.js", &[]);
        for (kind, _) in ADDRESS_KINDS.iter().chain(CARD_KINDS) {
            assert!(
                script.contains(&format!("\"{kind}\": ["))
                    || script.contains(&format!("{kind}: [")),
                "autofill.js has no matcher for {kind}"
            );
        }
    }

    #[test]
    fn keeps_only_the_digits() {
        assert_eq!(digits("4242-4242 4242_4242"), "4242424242424242");
        assert_eq!(digits("abc"), "");
    }
}
