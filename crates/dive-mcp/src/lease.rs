//! Who is driving a tab.
//!
//! Two agents can be connected at once -- Dive's own and whatever is on the
//! other end of the MCP port -- and nothing stopped them both acting in the
//! same tab. One reads the page, the other navigates it, and the first one's
//! next click lands somewhere that no longer exists. The failure is silent
//! and looks like the model being stupid.
//!
//! A lease fixes that without a protocol of its own: a client claims a tab
//! under a name it picks, and while that lease holds, an action from anyone
//! else is refused with a message saying who has it and for how long.
//! Reading is never gated -- two agents looking at the same page is fine --
//! and a browser where nobody claims anything behaves exactly as before.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dive_core::TabId;

/// How long a claim lasts when the client does not say.
pub const DEFAULT_TTL: Duration = Duration::from_secs(120);
/// The longest a client may hold a tab without touching it again.
pub const MAX_TTL: Duration = Duration::from_mins(30);

/// Who holds a tab, and until when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    /// The name the claim was made under.
    pub holder: String,
    /// When it lapses if nothing touches the tab again.
    pub expires_at: Instant,
}

/// The refusal an action gets when someone else is driving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    /// Who has the tab.
    pub holder: String,
    /// How much longer they have it, at worst.
    pub seconds_left: u64,
}

impl Conflict {
    /// What the client is told. It names the holder, because the fix is
    /// usually a person deciding which agent should have the tab.
    pub fn message(&self, tab: TabId) -> String {
        format!(
            "tab {tab} is being driven by {:?} for another {}s; wait, use another tab, \
             or pass holder={:?} if that is you",
            self.holder, self.seconds_left, self.holder
        )
    }
}

/// Every tab under lease.
#[derive(Debug, Default)]
pub struct Leases {
    held: Mutex<HashMap<TabId, Held>>,
}

/// The one registry in this process.
///
/// There is one browser, so there is one answer to "who is driving this tab",
/// and both the MCP server and Dive's own agent have to read it. A shared
/// static is the honest shape for that; passing a handle around would only
/// invite a second registry that disagrees with the first.
pub fn shared() -> &'static Leases {
    static LEASES: std::sync::OnceLock<Leases> = std::sync::OnceLock::new();
    LEASES.get_or_init(Leases::default)
}

/// The name Dive's own agent claims tabs under. A remote client that picks
/// the same name is indistinguishable from it, which is why the browser's
/// own agent gets a name nobody would choose by accident.
pub const DIVE_AGENT: &str = "dive-agent (in-browser)";

impl Leases {
    /// Claim a tab for `holder`. Renewing your own claim always succeeds;
    /// taking one from a live holder never does.
    pub fn claim(
        &self,
        tab: TabId,
        holder: &str,
        ttl: Duration,
        now: Instant,
    ) -> Result<Held, Conflict> {
        let ttl = ttl.min(MAX_TTL);
        let mut held = self.lock();
        held.retain(|_, lease| lease.expires_at > now);
        match held.get(&tab) {
            Some(lease) if lease.holder != holder => Err(conflict(lease, now)),
            _ => {
                let lease = Held {
                    holder: holder.to_owned(),
                    expires_at: now + ttl,
                };
                held.insert(tab, lease.clone());
                Ok(lease)
            }
        }
    }

    /// Give a tab back. False when it was not yours to give.
    pub fn release(&self, tab: TabId, holder: &str) -> bool {
        let mut held = self.lock();
        match held.get(&tab) {
            Some(lease) if lease.holder == holder => {
                held.remove(&tab);
                true
            }
            _ => false,
        }
    }

    /// Whether `holder` may act on `tab` right now, and renew the lease if
    /// they may. `holder` is `None` for a client that did not name itself:
    /// it may act on a tab nobody has claimed, and on nothing else.
    pub fn check_action(
        &self,
        tab: TabId,
        holder: Option<&str>,
        now: Instant,
    ) -> Result<(), Conflict> {
        let mut held = self.lock();
        held.retain(|_, lease| lease.expires_at > now);
        let Some(lease) = held.get_mut(&tab) else {
            return Ok(());
        };
        if holder != Some(lease.holder.as_str()) {
            return Err(conflict(lease, now));
        }
        // Acting on a tab is proof the holder is still there, so the lease
        // follows the work rather than expiring mid-flow.
        lease.expires_at = lease.expires_at.max(now + DEFAULT_TTL);
        Ok(())
    }

    /// Who holds this tab, for the error and for the tab strip.
    pub fn holder_of(&self, tab: TabId, now: Instant) -> Option<Held> {
        self.lock()
            .get(&tab)
            .filter(|lease| lease.expires_at > now)
            .cloned()
    }

    /// Every live lease, newest expiry last.
    pub fn list(&self, now: Instant) -> Vec<(TabId, Held)> {
        let mut out: Vec<_> = self
            .lock()
            .iter()
            .filter(|(_, lease)| lease.expires_at > now)
            .map(|(tab, lease)| (*tab, lease.clone()))
            .collect();
        out.sort_by_key(|(_, lease)| lease.expires_at);
        out
    }

    /// Drop a tab's lease whoever holds it: the tab is gone.
    pub fn forget(&self, tab: TabId) {
        self.lock().remove(&tab);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<TabId, Held>> {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn conflict(lease: &Held, now: Instant) -> Conflict {
    Conflict {
        holder: lease.holder.clone(),
        seconds_left: lease.expires_at.saturating_duration_since(now).as_secs(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(now: Instant, secs: u64) -> Instant {
        now + Duration::from_secs(secs)
    }

    #[test]
    fn a_claim_keeps_everyone_else_out_until_it_lapses() {
        let leases = Leases::default();
        let tab = TabId::new();
        let now = Instant::now();
        leases
            .claim(tab, "claude-code", Duration::from_secs(60), now)
            .unwrap();

        // The holder acts freely; anyone else is told who has it.
        assert!(leases.check_action(tab, Some("claude-code"), now).is_ok());
        let refused = leases
            .check_action(tab, Some("dive-agent"), now)
            .unwrap_err();
        assert_eq!(refused.holder, "claude-code");
        assert!(refused.message(tab).contains("claude-code"));
        // A client that did not name itself is in the same position.
        assert!(leases.check_action(tab, None, now).is_err());

        // The holder's own action above carried the lease to DEFAULT_TTL from
        // then, so the tab is still theirs a minute later, and free after it.
        assert!(
            leases
                .check_action(tab, Some("dive-agent"), at(now, 61))
                .is_err()
        );
        assert!(
            leases
                .check_action(tab, Some("dive-agent"), at(now, DEFAULT_TTL.as_secs() + 1))
                .is_ok()
        );
    }

    #[test]
    fn acting_keeps_the_lease_alive_so_a_long_flow_does_not_lose_it() {
        let leases = Leases::default();
        let tab = TabId::new();
        let now = Instant::now();
        leases
            .claim(tab, "agent", Duration::from_secs(10), now)
            .unwrap();
        // A step at nine seconds carries the lease past its original end.
        assert!(leases.check_action(tab, Some("agent"), at(now, 9)).is_ok());
        assert!(
            leases
                .check_action(tab, Some("agent"), at(now, 100))
                .is_ok()
        );
        assert!(
            leases
                .check_action(tab, Some("other"), at(now, 100))
                .is_err()
        );
    }

    #[test]
    fn a_tab_nobody_claimed_belongs_to_whoever_acts() {
        let leases = Leases::default();
        let tab = TabId::new();
        let now = Instant::now();
        assert!(leases.check_action(tab, None, now).is_ok());
        assert!(leases.check_action(tab, Some("anyone"), now).is_ok());
        assert!(leases.holder_of(tab, now).is_none());
    }

    #[test]
    fn renewing_your_own_claim_works_and_stealing_one_does_not() {
        let leases = Leases::default();
        let tab = TabId::new();
        let now = Instant::now();
        leases
            .claim(tab, "a", Duration::from_secs(60), now)
            .unwrap();
        assert!(leases.claim(tab, "a", Duration::from_secs(60), now).is_ok());
        assert_eq!(
            leases
                .claim(tab, "b", Duration::from_secs(60), now)
                .unwrap_err()
                .holder,
            "a"
        );
        // Releasing is the holder's to do.
        assert!(!leases.release(tab, "b"));
        assert!(leases.release(tab, "a"));
        assert!(leases.claim(tab, "b", Duration::from_secs(60), now).is_ok());
    }

    #[test]
    fn a_claim_cannot_outlast_the_cap_and_a_closed_tab_frees_itself() {
        let leases = Leases::default();
        let tab = TabId::new();
        let now = Instant::now();
        let held = leases
            .claim(tab, "a", Duration::from_hours(24), now)
            .unwrap();
        assert!(held.expires_at <= now + MAX_TTL);
        assert_eq!(leases.list(now).len(), 1);
        leases.forget(tab);
        assert!(leases.list(now).is_empty());
    }
}
