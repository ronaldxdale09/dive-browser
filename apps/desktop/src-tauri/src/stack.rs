//! What a page is built with, from evidence Dive already has.
//!
//! A fingerprint extension sees what a content script is allowed to see: the
//! DOM, and script URLs. Dive owns the request pipeline, so the same question
//! is answered from response headers, `Set-Cookie` names and request paths
//! before a line of page script runs — and from the page itself for the one
//! thing a URL cannot give you, a library's own version property.
//!
//! Nothing leaves the machine. That is the point: the category's incumbent
//! aggregates its users' browsing to build its database, which is exactly
//! what a developer researching a client's site does not want.
//!
//! The rules are deliberately a short, auditable table rather than a vendored
//! multi-megabyte regex blob. Coverage is the well-known stack a developer
//! actually asks about; adding a rule is one line.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Where a technology sits in a stack, so the panel can group them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    /// React, Vue, Svelte, and the meta-frameworks over them.
    Framework,
    /// Component and CSS libraries.
    Ui,
    /// Bundlers and dev servers.
    Build,
    /// The application server or language runtime.
    Server,
    /// Where it is hosted, and what fronts it.
    Hosting,
    /// Content management and commerce platforms.
    Platform,
    /// Measurement, error reporting and support widgets.
    Analytics,
}

/// One technology found on a page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Detection {
    /// Display name.
    pub name: String,
    /// Which group it belongs to.
    pub category: Category,
    /// Exact version when something authoritative reported one.
    pub version: Option<String>,
    /// Why we believe it, newest evidence first. More than one line means
    /// more than one independent signal agreed.
    pub evidence: Vec<String>,
}

/// Everything the panel shows for one page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Default)]
pub struct StackReport {
    /// What was found, grouped by category then name.
    pub technologies: Vec<Detection>,
    /// `<meta name="generator">`, when the page declares one.
    pub generator: Option<String>,
    /// Whether the document arrived with content rather than an empty shell.
    pub server_rendered: bool,
    /// Packages named by the page's own source maps, deduplicated. Nothing
    /// else can see these: they exist only when a site ships source maps,
    /// and they name real dependencies rather than guessing from a filename.
    pub packages: Vec<String>,
}

/// A signal, and the technology it proves.
struct Rule {
    name: &'static str,
    category: Category,
    signal: Signal,
}

/// One thing to look for in the traffic a page produced.
enum Signal {
    /// A response header whose value contains this, case-insensitively.
    /// An empty needle matches the header merely being present.
    Header(&'static str, &'static str),
    /// A cookie the response set, by name prefix.
    Cookie(&'static str),
    /// A substring of any request URL on the page.
    Url(&'static str),
}

/// The fingerprint table. Ordered by category for readability only; matching
/// does not depend on order.
const RULES: &[Rule] = &[
    // Hosting and the edge, which headers name outright.
    Rule {
        name: "Vercel",
        category: Category::Hosting,
        signal: Signal::Header("server", "vercel"),
    },
    Rule {
        name: "Vercel",
        category: Category::Hosting,
        signal: Signal::Header("x-vercel-id", ""),
    },
    Rule {
        name: "Netlify",
        category: Category::Hosting,
        signal: Signal::Header("server", "netlify"),
    },
    Rule {
        name: "Netlify",
        category: Category::Hosting,
        signal: Signal::Header("x-nf-request-id", ""),
    },
    Rule {
        name: "Cloudflare",
        category: Category::Hosting,
        signal: Signal::Header("server", "cloudflare"),
    },
    Rule {
        name: "Cloudflare",
        category: Category::Hosting,
        signal: Signal::Header("cf-ray", ""),
    },
    Rule {
        name: "AWS CloudFront",
        category: Category::Hosting,
        signal: Signal::Header("x-amz-cf-id", ""),
    },
    Rule {
        name: "AWS S3",
        category: Category::Hosting,
        signal: Signal::Header("server", "amazons3"),
    },
    Rule {
        name: "Fastly",
        category: Category::Hosting,
        signal: Signal::Header("x-served-by", "cache-"),
    },
    Rule {
        name: "Fly.io",
        category: Category::Hosting,
        signal: Signal::Header("fly-request-id", ""),
    },
    Rule {
        name: "GitHub Pages",
        category: Category::Hosting,
        signal: Signal::Header("server", "github.com"),
    },
    Rule {
        name: "Google Cloud",
        category: Category::Hosting,
        signal: Signal::Header("server", "gse"),
    },
    Rule {
        name: "Render",
        category: Category::Hosting,
        signal: Signal::Header("x-render-origin-server", ""),
    },
    // Servers and runtimes.
    Rule {
        name: "nginx",
        category: Category::Server,
        signal: Signal::Header("server", "nginx"),
    },
    Rule {
        name: "Apache",
        category: Category::Server,
        signal: Signal::Header("server", "apache"),
    },
    Rule {
        name: "Caddy",
        category: Category::Server,
        signal: Signal::Header("server", "caddy"),
    },
    Rule {
        name: "Express",
        category: Category::Server,
        signal: Signal::Header("x-powered-by", "express"),
    },
    Rule {
        name: "PHP",
        category: Category::Server,
        signal: Signal::Header("x-powered-by", "php"),
    },
    Rule {
        name: "PHP",
        category: Category::Server,
        signal: Signal::Cookie("PHPSESSID"),
    },
    Rule {
        name: "ASP.NET",
        category: Category::Server,
        signal: Signal::Header("x-aspnet-version", ""),
    },
    Rule {
        name: "ASP.NET",
        category: Category::Server,
        signal: Signal::Header("x-powered-by", "asp.net"),
    },
    Rule {
        name: "Java",
        category: Category::Server,
        signal: Signal::Cookie("JSESSIONID"),
    },
    Rule {
        name: "Django",
        category: Category::Server,
        signal: Signal::Cookie("csrftoken"),
    },
    Rule {
        name: "Django",
        category: Category::Server,
        signal: Signal::Cookie("django"),
    },
    Rule {
        name: "Laravel",
        category: Category::Server,
        signal: Signal::Cookie("laravel_session"),
    },
    Rule {
        name: "Ruby on Rails",
        category: Category::Server,
        signal: Signal::Cookie("_rails"),
    },
    Rule {
        name: "Phoenix",
        category: Category::Server,
        signal: Signal::Cookie("_phoenix_key"),
    },
    // Meta-frameworks, from the paths their builds emit.
    Rule {
        name: "Next.js",
        category: Category::Framework,
        signal: Signal::Header("x-powered-by", "next.js"),
    },
    Rule {
        name: "Next.js",
        category: Category::Framework,
        signal: Signal::Url("/_next/static/"),
    },
    Rule {
        name: "Nuxt",
        category: Category::Framework,
        signal: Signal::Url("/_nuxt/"),
    },
    Rule {
        name: "SvelteKit",
        category: Category::Framework,
        signal: Signal::Url("/_app/immutable/"),
    },
    Rule {
        name: "Astro",
        category: Category::Framework,
        signal: Signal::Url("/_astro/"),
    },
    Rule {
        name: "Remix",
        category: Category::Framework,
        signal: Signal::Url("/build/_shared/"),
    },
    Rule {
        name: "Gatsby",
        category: Category::Framework,
        signal: Signal::Url("/page-data/app-data.json"),
    },
    Rule {
        name: "Create React App",
        category: Category::Framework,
        signal: Signal::Url("/static/js/main."),
    },
    // Build tooling.
    Rule {
        name: "Vite",
        category: Category::Build,
        signal: Signal::Url("/@vite/client"),
    },
    Rule {
        name: "Vite",
        category: Category::Build,
        signal: Signal::Url("/node_modules/.vite/"),
    },
    // Platforms.
    Rule {
        name: "WordPress",
        category: Category::Platform,
        signal: Signal::Url("/wp-content/"),
    },
    Rule {
        name: "WordPress",
        category: Category::Platform,
        signal: Signal::Url("/wp-includes/"),
    },
    Rule {
        name: "Drupal",
        category: Category::Platform,
        signal: Signal::Header("x-generator", "drupal"),
    },
    Rule {
        name: "Shopify",
        category: Category::Platform,
        signal: Signal::Header("x-shopid", ""),
    },
    Rule {
        name: "Shopify",
        category: Category::Platform,
        signal: Signal::Url("cdn.shopify.com"),
    },
    Rule {
        name: "Squarespace",
        category: Category::Platform,
        signal: Signal::Header("server", "squarespace"),
    },
    Rule {
        name: "Webflow",
        category: Category::Platform,
        signal: Signal::Url("assets.website-files.com"),
    },
    Rule {
        name: "Ghost",
        category: Category::Platform,
        signal: Signal::Header("x-ghost-cache-status", ""),
    },
    // Measurement and support, from the endpoints they call.
    Rule {
        name: "Google Analytics",
        category: Category::Analytics,
        signal: Signal::Url("google-analytics.com"),
    },
    Rule {
        name: "Google Tag Manager",
        category: Category::Analytics,
        signal: Signal::Url("googletagmanager.com"),
    },
    Rule {
        name: "Sentry",
        category: Category::Analytics,
        signal: Signal::Url("sentry.io"),
    },
    Rule {
        name: "PostHog",
        category: Category::Analytics,
        signal: Signal::Url("posthog.com"),
    },
    Rule {
        name: "Segment",
        category: Category::Analytics,
        signal: Signal::Url("segment.com"),
    },
    Rule {
        name: "Hotjar",
        category: Category::Analytics,
        signal: Signal::Url("hotjar.com"),
    },
    Rule {
        name: "Intercom",
        category: Category::Analytics,
        signal: Signal::Url("intercom.io"),
    },
    Rule {
        name: "Stripe",
        category: Category::Analytics,
        signal: Signal::Url("js.stripe.com"),
    },
    // UI libraries whose assets are recognisable.
    Rule {
        name: "Tailwind CSS",
        category: Category::Ui,
        signal: Signal::Url("/tailwind"),
    },
    Rule {
        name: "Bootstrap",
        category: Category::Ui,
        signal: Signal::Url("/bootstrap"),
    },
    Rule {
        name: "Font Awesome",
        category: Category::Ui,
        signal: Signal::Url("fontawesome"),
    },
    Rule {
        name: "Google Fonts",
        category: Category::Ui,
        signal: Signal::Url("fonts.googleapis.com"),
    },
];

/// One request, reduced to the fields detection reads. Keeps the rules
/// testable without building a whole `RequestSummary`.
#[derive(Debug, Clone, Default)]
pub struct Evidence {
    /// Full request URL.
    pub url: String,
    /// Response headers, lowercased names.
    pub response_headers: BTreeMap<String, String>,
}

/// The host part of a URL, lowercased.
fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether `rule` matches anything in `requests`, and the line to show.
///
/// `page_host` scopes the signals that describe a server. A `server:` or
/// `set-cookie` on a response from someone else's CDN describes *their*
/// infrastructure: counting those reported svelte.dev as GitHub Pages because
/// an asset came from there. URL signals stay unscoped — a page loading
/// `googletagmanager.com` really is using it, whoever serves it.
fn matched(rule: &Rule, requests: &[Evidence], page_host: Option<&str>) -> Option<String> {
    for request in requests {
        let describes_this_site = match (page_host, host_of(&request.url)) {
            (Some(page), Some(host)) => host == page,
            // With no host to compare against, nothing is ruled out.
            _ => true,
        };
        if !describes_this_site && !matches!(rule.signal, Signal::Url(_)) {
            continue;
        }
        match rule.signal {
            Signal::Header(name, needle) => {
                if let Some(value) = request.response_headers.get(name) {
                    if needle.is_empty() {
                        return Some(format!("{name} header"));
                    }
                    if value.to_ascii_lowercase().contains(needle) {
                        return Some(format!("{name}: {}", truncate(value, 60)));
                    }
                }
            }
            Signal::Cookie(prefix) => {
                if let Some(value) = request.response_headers.get("set-cookie")
                    && value
                        .to_ascii_lowercase()
                        .contains(&prefix.to_ascii_lowercase())
                {
                    return Some(format!("{prefix} cookie"));
                }
            }
            Signal::Url(needle) => {
                if request.url.to_ascii_lowercase().contains(needle) {
                    return Some(format!("request to {}", truncate(&request.url, 70)));
                }
            }
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    format!("{}…", s.chars().take(max).collect::<String>())
}

/// What the page's own probe reported.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct PageProbe {
    #[serde(default)]
    pub technologies: Vec<ProbeHit>,
    #[serde(default)]
    pub generator: String,
    #[serde(default)]
    pub server_rendered: bool,
}

/// One technology the page reported about itself.
#[derive(Debug, Clone, Deserialize)]
pub struct ProbeHit {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub evidence: String,
}

/// The category a probe hit belongs to. The probe reports names, not
/// categories, so the grouping lives here next to the rules.
fn category_of(name: &str) -> Category {
    match name {
        "React" | "Vue" | "Angular" | "Svelte" | "Next.js" | "Next.js SSR" | "Next.js SSG"
        | "Nuxt" | "Remix" | "SvelteKit" | "Astro" | "Gatsby" | "Alpine.js" | "htmx" | "Turbo" => {
            Category::Framework
        }
        "Vite" | "webpack" | "Turbopack" => Category::Build,
        // Component kits, CSS frameworks and state libraries all answer the
        // same question — what is this interface made of — so they share a group.
        "jQuery" | "Bootstrap" | "Mantine" | "Chakra UI" | "MUI" | "Tailwind CSS"
        | "Font Awesome" | "Google Fonts" | "Redux" | "Apollo Client" | "TanStack Query" => {
            Category::Ui
        }
        "Shopify" | "WordPress" | "Drupal" | "Ghost" | "Squarespace" | "Webflow" => {
            Category::Platform
        }
        _ => Category::Analytics,
    }
}

/// Packages a source map names, from its `sources` paths.
///
/// A bundle's source map lists every file that went into it, so
/// `node_modules/<name>/…` is a real dependency rather than a guess from a
/// filename. Scoped packages keep their scope.
pub fn packages_in_sources(sources: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for source in sources {
        let Some(after) = source.rsplit("node_modules/").next() else {
            continue;
        };
        if after == source.as_str() {
            continue;
        }
        let mut parts = after.split('/');
        let Some(first) = parts.next().filter(|p| !p.is_empty()) else {
            continue;
        };
        let name = if let Some(scope) = first.strip_prefix('@') {
            match parts.next() {
                Some(rest) if !rest.is_empty() => format!("@{scope}/{rest}"),
                _ => continue,
            }
        } else {
            first.to_owned()
        };
        if !found.contains(&name) {
            found.push(name);
        }
    }
    found.sort();
    found
}

/// Merge every signal into one report.
///
/// A technology found by several signals keeps one entry carrying all of
/// them, and the page's version wins: it came from the library itself, while
/// a header or a path only proves presence.
pub fn detect(
    requests: &[Evidence],
    probe: &PageProbe,
    packages: Vec<String>,
    page_url: &str,
) -> StackReport {
    let mut by_name: BTreeMap<String, Detection> = BTreeMap::new();
    let page_host = host_of(page_url);

    for rule in RULES {
        if let Some(evidence) = matched(rule, requests, page_host.as_deref()) {
            let entry = by_name.entry(rule.name.to_owned()).or_insert(Detection {
                name: rule.name.to_owned(),
                category: rule.category,
                version: None,
                evidence: Vec::new(),
            });
            if !entry.evidence.contains(&evidence) {
                entry.evidence.push(evidence);
            }
        }
    }

    for hit in &probe.technologies {
        let entry = by_name.entry(hit.name.clone()).or_insert(Detection {
            name: hit.name.clone(),
            category: category_of(&hit.name),
            version: None,
            evidence: Vec::new(),
        });
        // The page is authoritative about its own version.
        if hit.version.is_some() {
            entry.version.clone_from(&hit.version);
        }
        if !hit.evidence.is_empty() && !entry.evidence.contains(&hit.evidence) {
            entry.evidence.insert(0, hit.evidence.clone());
        }
    }

    let mut technologies: Vec<Detection> = by_name.into_values().collect();
    technologies.sort_by(|a, b| {
        a.category
            .cmp(&b.category)
            .then_with(|| a.name.cmp(&b.name))
    });

    StackReport {
        technologies,
        generator: Some(probe.generator.clone()).filter(|g| !g.is_empty()),
        server_rendered: probe.server_rendered,
        packages,
    }
}

/// Read the page's own probe and merge it with what the traffic showed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_stack(
    state: tauri::State<'_, crate::state::AppState>,
    id: dive_core::TabId,
) -> crate::error::AppResult<StackReport> {
    use crate::state::lock;

    // The traffic is already buffered, so this costs nothing extra.
    let requests: Vec<Evidence> = state
        .buffers
        .requests(id, 400)
        .into_iter()
        .map(|r| Evidence {
            url: r.url,
            response_headers: r
                .response_headers
                .into_iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v))
                .collect(),
        })
        .collect();

    let session = crate::commands::cdp_for(&state, id)?;
    let script = crate::pagescript::build("stack.js", &[]);
    let value = session
        .call(
            "Runtime.evaluate",
            serde_json::json!({ "expression": script, "returnByValue": true }),
        )
        .await
        .map_err(|e| crate::error::AppError::new(format!("could not read the page: {e}")))?;
    // A page that refuses to answer still has traffic worth reporting, so a
    // probe failure degrades to headers and paths rather than failing.
    let probe: PageProbe =
        serde_json::from_value(value["result"]["value"].clone()).unwrap_or_default();

    // Only the page's own scripts, newest first, and only a handful: the
    // answer stops improving after the first few chunks.
    let page_url = lock(&state.store)
        .tab(id)
        .map(|t| t.url)
        .unwrap_or_default();
    let scripts: Vec<String> = requests
        .iter()
        .filter(|r| r.url.contains(".js"))
        .map(|r| r.url.clone())
        .collect();
    let packages = state.sourcemaps.packages(&page_url, &scripts, 4).await;

    Ok(detect(&requests, &probe, packages, &page_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str, headers: &[(&str, &str)]) -> Evidence {
        Evidence {
            url: url.to_owned(),
            response_headers: headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        }
    }

    fn names(report: &StackReport) -> Vec<&str> {
        report
            .technologies
            .iter()
            .map(|t| t.name.as_str())
            .collect()
    }

    #[test]
    fn a_header_names_the_host_and_the_server() {
        let report = detect(
            &[request(
                "https://x.example/",
                &[("server", "nginx/1.25.3"), ("x-vercel-id", "iad1::abc")],
            )],
            &PageProbe::default(),
            Vec::new(),
            "https://x.example/",
        );
        assert!(names(&report).contains(&"nginx"));
        assert!(names(&report).contains(&"Vercel"));
        // The evidence quotes the header, so a person can check the claim.
        let nginx = report
            .technologies
            .iter()
            .find(|t| t.name == "nginx")
            .unwrap();
        assert_eq!(nginx.evidence, vec!["server: nginx/1.25.3"]);
    }

    #[test]
    fn a_present_header_counts_even_with_no_value_to_match() {
        let report = detect(
            &[request("https://x.example/", &[("cf-ray", "8a1b2c3d")])],
            &PageProbe::default(),
            Vec::new(),
            "https://x.example/",
        );
        assert_eq!(names(&report), vec!["Cloudflare"]);
        assert_eq!(report.technologies[0].evidence, vec!["cf-ray header"]);
    }

    #[test]
    fn a_set_cookie_name_gives_away_the_backend() {
        for (cookie, expected) in [
            ("PHPSESSID=abc; Path=/", "PHP"),
            ("laravel_session=xyz; HttpOnly", "Laravel"),
            ("csrftoken=nope; Path=/", "Django"),
            ("JSESSIONID=1A2B; Path=/", "Java"),
        ] {
            let report = detect(
                &[request("https://x.example/", &[("set-cookie", cookie)])],
                &PageProbe::default(),
                Vec::new(),
                "https://x.example/",
            );
            assert!(names(&report).contains(&expected), "{cookie} -> {expected}");
        }
    }

    #[test]
    fn build_output_paths_name_the_meta_framework() {
        for (url, expected) in [
            ("https://x.example/_next/static/chunks/main.js", "Next.js"),
            ("https://x.example/_nuxt/entry.abc.js", "Nuxt"),
            ("https://x.example/_astro/hoisted.abc.js", "Astro"),
            (
                "https://x.example/_app/immutable/entry/start.js",
                "SvelteKit",
            ),
            (
                "https://x.example/static/js/main.8f2a.chunk.js",
                "Create React App",
            ),
        ] {
            let report = detect(
                &[request(url, &[])],
                &PageProbe::default(),
                Vec::new(),
                "https://x.example/",
            );
            assert!(names(&report).contains(&expected), "{url} -> {expected}");
        }
    }

    #[test]
    fn the_page_supplies_the_version_a_url_cannot() {
        // The path proves Next.js is there; only the page knows React 18.3.1.
        let probe = PageProbe {
            technologies: vec![ProbeHit {
                name: "React".into(),
                version: Some("18.3.1".into()),
                evidence: "window.React.version".into(),
            }],
            generator: String::new(),
            server_rendered: true,
        };
        let report = detect(
            &[request(
                "https://x.example/_next/static/chunks/main.js",
                &[],
            )],
            &probe,
            Vec::new(),
            "https://x.example/",
        );
        let react = report
            .technologies
            .iter()
            .find(|t| t.name == "React")
            .unwrap();
        assert_eq!(react.version.as_deref(), Some("18.3.1"));
        assert_eq!(react.category, Category::Framework);
        assert!(report.server_rendered);
    }

    #[test]
    fn several_signals_for_one_technology_become_one_entry() {
        let probe = PageProbe {
            technologies: vec![ProbeHit {
                name: "Next.js".into(),
                version: Some("15.0.0".into()),
                evidence: "__NEXT_DATA__".into(),
            }],
            ..PageProbe::default()
        };
        let report = detect(
            &[
                request("https://x.example/_next/static/chunks/main.js", &[]),
                request("https://x.example/", &[("x-powered-by", "Next.js")]),
            ],
            &probe,
            Vec::new(),
            "https://x.example/",
        );
        let next: Vec<_> = report
            .technologies
            .iter()
            .filter(|t| t.name == "Next.js")
            .collect();
        assert_eq!(next.len(), 1, "one entry, not one per signal");
        // The page's own evidence leads, and every independent signal is kept.
        assert_eq!(next[0].evidence.first().unwrap(), "__NEXT_DATA__");
        assert_eq!(next[0].evidence.len(), 3);
        assert_eq!(next[0].version.as_deref(), Some("15.0.0"));
    }

    #[test]
    fn source_maps_name_real_dependencies_including_scoped_ones() {
        let sources = [
            "webpack://_N_E/./node_modules/react-dom/client.js",
            "webpack://_N_E/./node_modules/@tanstack/react-query/build/index.js",
            "webpack://_N_E/./node_modules/react-dom/server.js",
            "webpack://_N_E/./src/app/page.tsx",
            "webpack://_N_E/./node_modules/@scope-only/",
        ]
        .map(String::from);
        // Deduplicated, sorted, scope preserved; app code and a truncated
        // scoped path are not packages.
        assert_eq!(
            packages_in_sources(&sources),
            vec!["@tanstack/react-query".to_owned(), "react-dom".to_owned()]
        );
    }

    #[test]
    fn a_third_party_response_does_not_lend_this_page_its_server() {
        // svelte.dev was reported as GitHub Pages because a font came from
        // there. A header describes whoever sent it, not the page.
        let report = detect(
            &[
                request("https://x.example/", &[("server", "nginx")]),
                request(
                    "https://fonts.gstatic.com/f.woff2",
                    &[("server", "GitHub.com")],
                ),
                request(
                    "https://cdn.other.test/a.js",
                    &[("set-cookie", "PHPSESSID=1")],
                ),
            ],
            &PageProbe::default(),
            Vec::new(),
            "https://x.example/",
        );
        assert_eq!(names(&report), vec!["nginx"]);
    }

    #[test]
    fn a_third_party_script_still_counts_as_something_the_page_uses() {
        // The opposite case: a URL signal is about what the page loads, so
        // an analytics endpoint on another host is a true positive.
        let report = detect(
            &[request("https://www.googletagmanager.com/gtm.js", &[])],
            &PageProbe::default(),
            Vec::new(),
            "https://x.example/",
        );
        assert_eq!(names(&report), vec!["Google Tag Manager"]);
    }

    #[test]
    fn nothing_found_is_an_empty_report_rather_than_a_guess() {
        let report = detect(
            &[request("https://x.example/", &[])],
            &PageProbe::default(),
            Vec::new(),
            "https://x.example/",
        );
        assert!(report.technologies.is_empty());
        assert!(report.generator.is_none());
        assert!(!report.server_rendered);
    }

    #[test]
    fn results_are_grouped_by_category_then_named_in_order() {
        let report = detect(
            &[request(
                "https://x.example/_next/static/a.js",
                &[("server", "nginx"), ("x-vercel-id", "1")],
            )],
            &PageProbe::default(),
            Vec::new(),
            "https://x.example/",
        );
        let categories: Vec<Category> = report.technologies.iter().map(|t| t.category).collect();
        let mut sorted = categories.clone();
        sorted.sort();
        assert_eq!(categories, sorted, "framework before server before hosting");
    }
}
