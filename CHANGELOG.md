# Changelog

All notable changes to Dive are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); until 1.0 a minor
bump may change behaviour.

## [Unreleased]

### Added
- In the A11y panel each failing element is a button that scrolls the page to it and flashes an outline, and a rule's docs link opens as a Dive tab; a report now stays with the tab it was run on instead of following you to the next tab.
- The Storage panel can delete a cookie or a local or session storage key from its row; the page sees the change at once.
- Settings › Developer offers a ready `mcp.json` entry for Cursor and other JSON-configured MCP clients, with the token masked on screen and copied whole.
- In the Downloads list, a saved file's name opens it with the app the system uses for that kind of file; Show still reveals it in the folder.
- Settings › About opens with the Dive mark, the name, the version and the engine on one line, and the bundle now carries a copyright line, a description and the Developer Tools category, so Finder's Get Info and the App Store category are no longer blank.
- Right-clicking a page shows a proper menu: Open Link in New Tab and Copy Link Address on links; Open Image in New Tab, Save Image As… and Copy Image Address on images; Copy and "Search the Web for …" on a selection; then Back, Forward, Reload, Save As…, Print…, Create QR Code for This Page, Ask the Agent About This Page, Device Simulator, View Page Source (opens the source in a tab) and Inspect. Text fields keep the editing menu.
- The "site can't be reached" page offers to search the web for the host, since an unresolved name is usually a typo.
- The tab context menu gains "Duplicate tab" and "Copy address", takes keyboard focus when it opens (arrow keys, Home, End, Escape), and hands focus back to the tab afterwards.
- The command palette reaches every Settings section by name ("Settings: Passwords & forms …", "Settings: Privacy …") and the default-browser offer; the import command names passwords and form entries.
- The "Saved …" notice after a download has a "Show in Finder" button and stays a little longer.
- Clear browsing data can wipe the active profile's form entries; the cookies row is now "Cookies and signed-in sessions", and a note says saved passwords are managed under Passwords & forms instead.
- The save-password card has "Never for this site": Dive stops offering to save there for this profile (it still fills what it knows), and Settings › Passwords & forms › Never saved lists those sites with an "Ask again" button.
- Import from another browser lays its four switches out in two columns with Import on its own row, and every place that lists what comes over now says "bookmarks, history, passwords and form entries".
- Settings › Passwords is now "Passwords & forms": saved logins, form entries, then the CSV import in its own "Bringing passwords over" group, whose note names every browser read directly (Firefox included).
- Pages offer remembered form entries under a named text field as you type (arrow keys, Enter, Escape), and what a submitted form held is remembered in the profile. Private windows are offered entries but never add to them; passwords, card numbers and login usernames are left out.
- Import from another browser now brings form entries (names, emails, addresses remembered while typing) from Chromium browsers and Firefox behind a "Form entries" switch; Settings › Passwords › Form entries lists them by field, forgets one or all. Card numbers and anything password-like are left behind.
- Import from another browser now brings saved passwords too, from Firefox (logins.json unlocked through key4.db; a primary password is reported rather than guessed) and from Chrome, Brave, Edge, Arc, Vivaldi, Opera and Chromium: a Passwords switch beside Bookmarks and History, decrypted with the browser's own key after macOS asks once to allow it, and stored in this profile's Keychain. Logins Dive already has are left alone.
- The menu has "Import from another browser…" beside Bookmarks and History; the import dialog was reachable only from Settings › General and the Library.
- Settings › Passwords imports a CSV export, the way Safari, Firefox, 1Password and Bitwarden (and Chrome) hand passwords over: the columns are found by name in any order, logins already saved are skipped, and the notice says what came in.
- Saved logins: Settings › Passwords lists the logins kept in this profile, shows or copies a password on request, adds one by hand and forgets one. Passwords live in the macOS Keychain, never in Dive's own files. Signing in to a site offers to save the login (or update a changed password) in a small card over the page; a site with one saved login is filled as soon as its form appears, and one with several asks which to use when a login field is focused.
- The page's corners are slightly rounded where it meets the rail and toolbar, following the Appearance corner setting (square under Sharp). The window behind the chrome is painted in the chrome's ground colour, so nothing black shows through corners or during a resize.

### Changed
- The Network panel marks a reply that a workspace rule answered with "(mock)" beside its status, the way a cached reply says "(cache)".
- After Clear browsing data, the confirmation reads as a sentence with counts first ("Cleared 176 history entries and cookies. Restart Dive to finish the profiles that were not open.").
- In a crowded tab strip the active tab keeps room for a few words of its title; the other tabs give way first.
- An error status with no page behind it (a bare 500 or 503) gets its own error page, "The server answered with an error", instead of the raw Chromium code; so does a reply that is not HTTP at all. A 500 that carries a page still shows that page.
- History rows in the Library show the time of day each page was last visited.
- ⌘D's "Bookmark saved" notice offers Edit, which opens the star's popover; the popover selects the whole title, so typing a new name replaces it.
- The Console panel starts a fresh log when the page loads again, with its own "Preserve log" checkbox, and a line from an inline script names the page's host instead of a bare ":3".
- The Network panel shows the current page's requests: a navigation or reload clears the previous page's rows, as in DevTools, with a "Preserve log" checkbox to keep them across loads.
- Settings › General › On launch names its third choice "Start screen" instead of "Nothing", since that is what it shows, and the home-page hint says the same.
- The new-tab palette offers the site your letters begin first, with "Switch to tab" when it is open, then the search row, matching the address bar; its rows name a page by its address when the recorded title was blank.
- Typing the first letters of a site you have open, bookmarked or visited ("exam" for example.com) puts that site first under the address bar, so Enter goes there instead of searching the web for the letters; a full address typed out still loads afresh. Pages whose recorded title was blank or "about:blank" are named by their address.
- The app icon is the Dive logo on a light tile at every size, so the Dock, Finder, the installer and Windows all show the same mark instead of the placeholder wave the smaller sizes carried.
- The Storage panel has a header row (Name, Value, Domain · path · flags), so the right-hand column of a cookie row is explained.
- Settings › About: after a check finds nothing, "You're up to date" appears once instead of twice, and after a failed check the button reads "Try again".
- Settings › General › Import no longer says passwords stay behind; it lists what comes over from each browser.
- The device simulator's caption says "viewport 430×739 … shown at 76%", so the size under the device name is not mistaken for the screen size.
- The empty Extensions panel says where an unpacked extension comes from: the source from GitHub, or the folder Chrome, Brave or Edge keeps installed extensions in.
- New workspace: "Separate cookies and logins" reads "Separate cookies and sign-ins", and its note says saved passwords and form entries stay shared across the profile.
- "Not now" on the default-browser offer rests the sidebar card for two weeks instead of until the next launch; Settings › General still offers it.
- Address bar suggestions show host and path on the right ("localhost:8771/form.html") instead of the host alone, so two pages on one site can be told apart.
- A page's permission request (camera, location, notifications…) is asked in a dialog over the page instead of a bar under the address field. Focus starts on Block; Allow is the primary action.

### Fixed
- Crowded tab strips no longer show a single letter and an ellipsis beside each favicon; the active tab keeps its title, the rest show the icon alone.
- The update dialog's Release notes link opens in a tab (it used to do nothing).
- Workspace rows in the rail answer Space as well as Enter from the keyboard, and Space no longer scrolls the rail.
- Closing the device simulator with its X shows the page at full size again; before, the phone stayed applied with the panel gone. Escape still just hides the device list.
- Popovers (downloads, bookmark, profile, protection, build badge) close when focus moves elsewhere, so ⌘F or ⌘L no longer opens a bar underneath one; closing the find bar hands keyboard focus back to the page.
- Middle-clicking a link, or ⌘-clicking it, opens it in a background tab instead of replacing the page; ⌘⇧-click opens it in a tab that takes focus.
- The home page's detected dev servers no longer include Dive's own remote-debugging port, or a private window's, which showed up as an "HTTP" server with an Open Tab button.
- The toolbar star follows bookmark changes made in the Library or by the shortcut, instead of still saying "Edit bookmark" after a removal.
- The page menu in a private window leaves out "Ask the Agent About This Page", which private windows refuse anyway.
- Setup: the Import and What's inside steps take keyboard focus on their heading when they appear, instead of leaving focus on the chrome behind the dialog.
- A tab showing page source keeps its view-source address, so it restores as the source view rather than the page.
- Closing a tab frees its page again. Since the rounded page corners, the layer-backed CEF view was kept alive by Core Animation after it left the window, so the browser never finished closing and every closed tab left a hidden renderer behind. The view now drops its layer backing and any overlay mask, and gives up first responder, before it is removed.
- A tab moved to its own window, or one asleep, says so in its accessible name, not only in a mouse tooltip.
- Pressing ⌘+ twice quickly no longer leaves the badge at 125% over a page zoomed to 110%: zoom commands go to the engine one at a time, the latest level following once the previous settles.
- The ChatGPT, Claude and Gemini shortcuts switch to the assistant's tab when one is already open in the workspace instead of opening another.
- The A11y panel announces the audit result ("1 violation · 14 passed · 0 to review") and its errors to assistive tech.
- Network panel rows can be reached with Tab and opened with Enter or Space.
- The developer dock's panel switcher is a real tab list: arrow keys, Home and End move between panels, and each panel is announced by its tab.
- Opening the agent puts focus in its composer, so ⌘J then typing works without a click.
- The Protection and Downloads toolbar buttons announce their popover (expanded, not pressed), and the YouTube row in Protection keeps its label on one line with "Applies on youtube.com" beneath it.
- Share: the QR code has a spoken name, "Copy link" announces "Link copied", and the panel says it is finding this Mac's address instead of sitting empty.
- History no longer files "about:blank" as a page title when the blank document's title arrives before the real one; rows that already carry it show their address instead.
- When the engine switches workspace on its own (an automation call, a link opened into another workspace, a restore), the tab strip now loads that workspace's tabs instead of showing only the ones it already knew.
- The profile menu says "1 tab", not "1 tabs".
- The main menu closes when anything else opens (find in page, the dock, the agent, a dialog), so a shortcut pressed with the menu open no longer leaves both on screen taking keys.
- Reopen closed tab (⇧⌘T) puts the tab back where it was in the strip instead of at the end.
- Private windows no longer offer to save or update a login, and refuse to save one from Settings or a CSV: their store lives in memory, so a password written to the Keychain from there would have been orphaned.
- Saved logins and form entries follow the profile a tab is in at the moment it asks, so a tab made essential (shown in every workspace) fills from the active profile instead of the one it started in, and never from a profile it has left.
- Clicking the Dock icon while the window is minimized brings it back; the app ignored that click.
- Settings › Appearance: with a dark-only or light-only template the Mode control shows the scheme the template forces instead of "System".
- The chrome could shift sideways, leaving no margin on the right and hiding the Menu button and the tab-search chevron: revealing the active tab scrolled every scrollable ancestor, and anything poking past the right edge let the document move. The chrome is now clipped, and only the tab strip itself scrolls.

## [0.1.15] - 2026-09-08

### Added
- Settings › General has a "Default browser" row that names where links from other apps open and offers Make default…, so the flow stays reachable after the rail's card has been rested.
- Reopen closed tab (⌘⇧T, also in the menu): the tabs closed this session come back one at a time, in the workspace they were in. The shortcut was reserved but did nothing.
- Library › History: each row has a Remove button (on hover or focus) that forgets that page, alongside the existing Clear browsing data.
- Tab strip: when tabs scroll out of the strip (its scrollbar is hidden), a "+N" chip after the new-tab button says how many are out of view and opens tab search; the active tab is scrolled into view whenever it changes.
- The Playwright recorder is reachable from the chrome: "Record steps as a
  Playwright test" in the browser menu and palette starts recording the
  current tab, a toolbar button shows it is on, and stopping opens the spec
  to copy or download. The spec opens on the page the recording began on,
  and a navigation a click caused is not replayed as a `goto` of its own.
- Selecting a request in the Network panel shows what was sent and what
  came back: both header sets, the request body, and the response body the
  engine kept (JSON within the buffer budget) or why it was not.
- Private windows (⇧⌘N, File menu, browser menu and palette): a separate
  off-the-record process with an in-memory database and no logging, MCP,
  extensions, agent credentials or update checks; muted violet chrome with a
  Private badge, Exit private mode, and a normal-profile lock so window
  requests land in the right process. New workspace moves to ⌃⌥⇧N.
- First-run onboarding: a five-second Remotion intro, a Start Dive screen,
  then profile, workspace and a look at the features with DivePrivacy and
  default-browser choices; a new `onboarded` preference records it, and
  Settings › About › Reset Dive plays it again.
- Import bookmarks and history from Chrome, Brave, Edge, Arc, Vivaldi,
  Opera, Firefox and Safari: a step in onboarding, an offer on the
  default-browser dialog, Settings › General › Import, and a palette
  command. Folders macOS protects are unlocked by giving Dive Full Disk
  Access in System Settings; passwords and cookies are not read.
- A Home button beside Reload (⌘⇧H) shows the welcome screen without
  closing any tab; clicking a tab brings its page back.
- Address bar suggestions: open tabs, bookmarks and history under the bar
  while typing, with keyboard navigation.
- Bookmark popover to rename or remove a bookmark; `bookmark_rename` command.
- Tab menu shows shortcuts; pin (⌘⇧P) and move to window (⌘⌥N) bindings.
- A DEV or BETA build badge in the title bar with version, build number and
  build time.

### Changed
- The download folder setting lives under General; About says plainly
  whether updates apply to this build; the Developer MCP command shows a
  short token path.
- Empty states share one component across the Library and popovers.
- The default-browser offer is a compact card that hides once Dive is the
  default; the console error count no longer sits on the Agent button.
- Live subtitles remember the chosen model and select a downloaded one when
  the remembered choice is not on disk.

### Fixed
- Onboarding's workspace step: Continue is no longer greyed out while the name field is empty; it keeps the name shown as the placeholder.
- Onboarding's colour swatches are named (Mint, Amber…) for assistive tech instead of raw hex codes, and the face that follows your name is labelled as such.
- In the profile and workspace dialogs, the face or mark that follows the name is labelled "from the name" instead of "someone" or a raw seed word.
- Edit workspace shows the workspace's current colour and mark as selected; for the first workspace, whose colour and mark are not in the palette, nothing was selected.
- The Keyboard shortcuts dialog and palette use the same names as the menu: "Record a video" (was "Record tab") and "Clear browsing data…" (was "Delete browsing data…").
- Clicking a lit star opens "Edit bookmark" with the name the bookmark was saved under; it used to say "Bookmark added" and show the page's title, so a renamed bookmark looked unrenamed.
- The Meta panel's social card says "og:image did not load" instead of showing a broken-image glyph, and an absent robots tag reads as the default (index, follow) rather than a red "missing".
- A request stopped by one of your rules shows as "blocked" in the Network panel rather than "failed", and the Rules panel no longer grows a stray horizontal scrollbar (a hidden tooltip was poking past its edge).
- The console filter also matches an entry's level and source, so typing "error", "warn" or "network" narrows to those lines; when nothing matches it says so instead of claiming there is no output.
- The A11y panel explains each failing element with axe's own summary (for example the contrast ratio measured and the one expected) instead of listing bare selectors, and the Network panel shows a request's query string instead of a bare "?".
- The device simulator's search placeholder no longer runs off the end of its box, and its close button is named "Close device simulator" for assistive tech.
- The toolbar's Protection button is named "Protection paused on this site" while a site is paused, and the protection menu's footer note no longer truncates mid-sentence.
- Permission prompts stay answerable for five minutes instead of thirty seconds; the bar used to vanish while the reader was still deciding, and the page was told the request was denied.
- A permission prompt for something that is always remembered (notifications) says so in words instead of showing a dropdown with a single choice.
- The menu item is now "Clear browsing data…", matching the Settings group and Library button it opens, and Settings starts keyboard focus on the section it was opened to instead of General.
- The tab strip's "+N" chip counted tabs that were plainly in view (it measured them from the window's edge instead of the strip's), so a private window with two tabs claimed one was hidden.
- The menu's Zoom row names its shortcuts (⌘−, ⌘0, ⌘+) on hover; it was the one row without them.
- Storage panel rows keep a stable order (by key, then domain and path); cookies came back in a different order on every refresh.
- Library › Recordings asks before deleting a recording (Keep / Delete), confirms with a notice, uses the same Finder icon as Downloads, and deleting also removes the recording's DiveScreen project file.
- Agent: a reply that finished with no text, no steps and no error (a small model can do this) shows "The model sent nothing back" instead of an empty bubble with a token count.
- Network replay editor: the Headers and Body fields no longer collapse to a single line when the response arrives; the pane scrolls instead.
- Text fields in the dock filters and Settings show a highlight border when focused, so keyboard focus is visible rather than a one-shade change of grey.
- Jump-to-Source from a console row says so when nothing maps the script back to a file on disk, instead of handing the editor an http URL as a path and opening nothing.
- With a Default zoom other than 100%, new tabs opened at that zoom but the chrome assumed 100%: no zoom badge, and the first ⌘+ shrank the page. The badge and the steps now start from the default; ⌘0 returns to it.
- The Home button and ⌘⇧H open the configured Home page when there is one, instead of always showing the welcome screen.
- Edit workspace says whether the workspace keeps its own cookies and logins, since that choice is made at creation and the dialog otherwise left it out.
- Choosing "Not now" in the default-browser dialog rests the "Set as default" card in the workspace rail for the rest of the session instead of leaving it there to ask again immediately.
- "All tabs" in the tab strip and Search tabs (⌘⇧A) open the palette with the open tabs listed first, not after the bookmarks.
- Essential tabs, which show only their icon, carry their title as an accessible name.
- The address bar is a proper combobox for assistive tech: it announces when its suggestion list opens and closes.
- Console panel: `console.log("%cstyled", "color:red")` reads "styled" and `%s`/`%d`/`%o` directives take their arguments, as in DevTools, instead of printing the raw format string and its style argument.
- A11y panel: each violation row shows a chevron and a pointer cursor, so it is clear the offending elements are one click away.
- Network panel: a request stopped by a mock rule or the blocklist reads "blocked" instead of "failed", with the engine's reason in the tooltip.
- The Protection popover no longer calls a site "Clean so far" while protection is paused there; it says nothing is blocked while paused.
- Playwright step recorder: a navigation the engine reported twice no longer becomes two `goto` lines (and the one a click caused is dropped as intended), the test ends by checking the last address reached rather than `toHaveURL(/./)`, the header counts the steps actually kept, and stopping with nothing recorded says so.
- Capture editor colour swatches are named (Red, Amber, …) for screen readers and tooltips instead of hex codes.
- Capture and recording file names carry the local time of day (as on the menu bar) instead of UTC.
- A tab opened only to fetch a file now closes when the download ends rather than when it starts. Closing it at the start took the download's progress with it: the Downloads menu said "Downloading…" forever for a file that was already saved.
- Two quick zoom steps (a double click on +, a held ⌘=) step twice instead of once: the level updates as soon as the step is asked for.
- Copying a command in Settings announces "Copied" (the button also says so), and the find bar's match count is a live region read as "Match 2 of 5".
- Privacy › Site permissions no longer says "Remembered for Personal · Personal" when the container carries the profile's own name.
- General settings: a custom search URL saved without `{query}` now shows a warning that DuckDuckGo is being used until it is added, rather than a static hint.
- About: a dev build no longer shows a "Check again" button that did nothing; the note that updates go to release builds stands alone.
- The menu, palette and shortcuts list call the same actions by the same names: "Copy bug report" (the menu said "Report a bug…", which suggested a form) and "Record a video" (the shortcuts list said "Record tab").
- Deleting an empty workspace asks "Delete X? It has no open tabs." instead of "close its 0 tabs?".
- Profile and workspace dialogs and the Appearance accent picker name their colour swatches (Mint, Amber, …) for screen readers and tooltips instead of reading out hex codes.
- Command palette: two tabs on the same page were one row to the keyboard, highlighted together and only the first reachable; each tab row is now distinct.
- In windows narrower than 960 px, where only one of the dock, agent and picker shows at a time, the Developer dock button no longer lights up for a dock hidden behind the agent, and pressing it swaps the agent for the dock instead of doing nothing visible.
- The agent composer shows an "Acts without asking" chip when that setting is on, not only for the session-only "Allow all"; clicking it opens the Agent settings.
- Live subtitles settings: the Medium model's download reads "1.5 GB" rather than "1533 MB", and the intro says the current tab rather than "this page".
- The agent panel's "Agent settings" button opens the Agent section of Settings instead of General. Its model note says "1 model listed", not "1 models".
- An agent step waiting for approval, still running, denied or failed reads in the present ("Click …", "Open …") instead of claiming it already happened. When nobody answers an approval request within 2 minutes the model is told the action was skipped for lack of an answer rather than that the user refused it.
- The model picker's provider chips wrap instead of scrolling out of sight, so "Add" (a custom provider) is always visible; "Search 1 models" reads "Search 1 model".
- The agent's Ollama model list comes from Ollama's own listing: embedding-only models (bge, nomic-embed) no longer appear as chat choices, each model shows its context window, and a model whose id is its name is no longer printed twice.
- Meta, Storage and Vitals panels no longer show a raw `cdp error -32000: Inspected target navigated or closed` when a read races a navigation: the read is tried once more, the panels re-read when the page finishes loading, and a remaining failure reads "The page was still loading when it was read." with a Try again button.
- An unpacked extension with `<all_urls>` ran its content scripts inside
  Dive's own interface as well as in pages. Every chrome webview now runs
  off-the-record, where extensions are not enabled; the chrome keeps its
  panel sizes, chosen subtitles model and avatar artwork in the profile
  store instead of web storage, so nothing is lost across launches.
- Settings › Privacy › Site permissions no longer tells a fresh profile
  that "permissions from earlier versions must be approved again"; the
  note appears only when some were in fact set aside.
- Failed loads on a blocked port, an empty response, a closed connection,
  a network change, a failed proxy, a missing file or an invalid address
  read as a sentence with something to try, not a bare error code; an
  expired or mismatched certificate says so rather than suggesting a
  self-signed dev server, and the address bar shows a warning instead of
  a lock beside a load that failed.
- A private window's menu, palette and Library no longer offer Bookmarks
  and History, which it keeps neither of; its Library opens on Downloads
  and Recordings. The empty states had invited ⌘D, which a private window
  refuses.
- With the rail expanded and the agent open, the page and dock grew past
  their column and the page's native view covered the left edge of the
  agent panel; the column now shrinks to its track. A console entry whose
  source is a very long URL no longer squeezes its message to one letter
  per line: the source name truncates and shows whole on hover.
- Keyboard focus is visible on tabs, the popout's tab and console source
  links, which had removed the outline without drawing anything in its
  place.
- The light theme draws status colours for light: Web Vitals ratings,
  console warnings, audit impact, response statuses and errors were the
  dark palette's pale green, amber and coral on white. Console entries
  for errors, dates and maps keep their description rather than a
  property dump.
- Onboarding's profile step no longer greys out Continue while the name
  field shows the profile's own name as a placeholder; leaving it empty
  keeps that name.
- With enough tabs open the strip spilled over the Record, Mobile and
  Agent buttons; past the point where every tab is a bare favicon it now
  scrolls. Opening Replay on a request grows a short dock so the editor's
  headers, body, Send and response are in view.
- A visit recorded as the address changes no longer carries the previous
  page's title (or "about:blank" for a new tab); the title fills in when
  it arrives, so a redirect's source address is never wrongly titled.
  Address suggestions show Dive's own pages by their whole address.
- "Delete browsing data…" in the menu and the History view's "Clear
  browsing data…" land on that group inside Settings › Privacy instead of
  the top of the panel. A rejected agent key reads "Anthropic
  rejected the key: API key is invalid (HTTP 401)." rather than "api 401:".
- Console entries show objects the way DevTools does when collapsed,
  `{a: 1, b: Array(3), s: "x"}` and `[4, 5]`, instead of the word "Object".
- Tabs squeezed down to their favicon, and pinned tabs, name themselves
  on hover.
- A request a rule blocked no longer shows the engine's error page as
  "179.5 kB" transferred in the Network panel.
- The Vitals panel no longer keeps the last page's numbers on display
  when the welcome screen shows; it asks for a tab instead.
- The command palette matches rows that contain what you typed; it no
  longer offers "Developer dock" for "verge" through scattered letters.
  Settings › About names the Chromium version behind CEF.
- A tab opened only to fetch a file closes itself once the download
  starts, instead of staying behind empty with the file's address; a page
  you were reading when you clicked a download link stays open.
- Recordings are named like every other capture, "example.com recording
  2026-09-08 04.03.23.mp4", instead of a "dive-…Z" timestamp.
- A tooltip parked past the window's edge could let the whole chrome slide
  sideways; the chrome no longer scrolls. On Dive's own pages (DiveScreen,
  the welcome screen) the Vitals, Meta and A11y panels say there is no
  website to measure instead of showing a red error over stale numbers.
- Downloading a subtitles model selects it when the chosen one is not on
  disk, so Start lights up for the model just fetched; while subtitles run,
  a Captions button in the toolbar says so and reopens the dialog to stop
  them.
- A second private window opens blank instead of reading "about:blank"
  in its tab and address bar; Live subtitles, which need a model download
  the private process refuses, are out of a private window's menu, palette
  and shortcut.
- The developer dock is capped by the window height, so a dock sized on a
  tall window leaves at least a readable strip of page on a short one; the
  resize handle stops at the same ceiling.
- Vitals shows DOMContentLoaded and Load as pending instead of "0 ms"
  while a page is still loading, and reads them again when it finishes.
- The Meta panel's social card loads the page's `og:image` (relative paths
  resolve against the page) and draws the search-result title in a link
  colour that reads in both themes.
- DiveScreen exports are named "clip (edited).mp4", counting up on a clash,
  instead of carrying a timestamp and a job id.
- HAR exports, OpenAPI specs and bug reports are named after the page and
  the time ("github.com requests 2026-09-07 18.19.30.har") instead of a
  timestamp with a random suffix.
- Private windows' Settings no longer list the Agent and Live subtitles
  sections or the import group, none of which can work there.
- Bringing a tab back from its own window no longer deletes it: the popout
  window's close, raised by the reattach itself, was treated as closing the
  tab.
- Browser, AI provider and assistant marks are the official logos from
  svgl.app, with light and dark drawings where the brand has them, in the
  import step, the agent setup and the rail's AI shortcuts.
- The Live subtitles dialog closes on Escape before any model is downloaded;
  a dialog whose primary button is disabled no longer leaves focus outside
  its trap.
- After a failed load the address bar shows the address that failed, so it
  can be corrected in place, and a new tab is named after its host while the
  first page loads instead of "about:blank".
- The update card uses the theme's colours; it had referenced tokens that do
  not exist and rendered without a background.
- A failed agent reply offers "Change model or key" inline.
- The feature tour scrolls to the top of the page when opened.
- The main menu, agent setup and DiveScreen cursor controls use sentence
  case like the rest of the chrome; palette commands are named after the
  surface they open ("Developer dock", not "Toggle dev dock").
- MCP and agent page input fail at once with a reason while a dialog covers
  the page, instead of timing out; local providers (Ollama, LM Studio) select
  an installed model when the configured default is missing.
- The permission bar keeps its explanation in a tooltip; the saved-recording
  footer stays on one line.
- The tab context menu closes on Escape and on a press elsewhere.
- The palette no longer lists open pages under History as well as Tabs.
- "About Dive" opens Settings → About instead of the stock macOS panel.
- Popout address bars show the same trimmed address as the main window.
- Canceled requests show as canceled in the Network dock, not as failures.
- Window frame is remembered on resize, move and quit; the rail's collapsed
  state survives a click made before preferences finish loading.
- Cursor controls in DiveScreen are greyed out for recordings without a
  pointer track.

### Added
- DiveScreen can open any video file (MP4, MOV, WebM, MKV, M4V, AVI, GIF):
  "Open Video…" in the editor, the Library's Recordings tab and the main menu
  copies the file into the captures folder and makes the playable companion.
- Export streams its rendered video to the engine as it encodes instead of
  holding the whole file in renderer memory; exports over 20 minutes are
  refused up front.

### Fixed
- Closing a tab's own window (or a tab that had been in one) no longer leaves
  an empty window behind or blocks quitting: the vendored CEF runtime issues
  each native close once and stops waiting for an acknowledgement CEF never
  sends for a reparented view.
- Closing the main window while popout windows are open quits the app instead
  of leaving a headless process.
- A lock-order inversion between the snapshot command and tab activation that
  could freeze the main thread.
- Layout and visibility commands now run on the main thread, so overlays can
  no longer race a tab switch and show two pages at once.
- MCP clients and the agent can only open http(s) pages, never local files.
- Workspace rules no longer put media streams back under request interception.
- One malformed preference no longer resets every preference.
- Clearing history also clears cached site icons.
- Glob rules match hosts containing the pattern's suffix correctly.
- Agent tool calls with malformed arguments surface an error instead of
  running with empty input; OpenAI-compatible streams that end without a
  `[DONE]` marker still deliver the reply.
- Databases from a newer build are refused instead of being written to;
  removing a tab's scroll state is transactional and cascades.
- Boot no longer registers duplicate event listeners after a chrome remount;
  notification toasts no longer cancel each other.

### Changed
- Tab strip rows, agent thread messages and Markdown rendering are memoised.
- `SettingsDialog` split into per-section components; dead `Annotator`,
  `WorkspaceChip` and `skills` store removed; `dive-mcp` split into modules.
- SQLite runs with `synchronous=NORMAL` under WAL.
- Release tooling now stamps the crashpad `crash_reporter.cfg` alongside the
  other version manifests, and the signing-secrets helper takes its identity
  and certificate path from the environment instead of hardcoding them.
- Repository cleanup for open-source publication: internal working notes
  removed, design notes moved to `docs/design/`, contributor documentation
  (CEF setup, feature flags, data locations, MCP connection) added.

## [0.1.4] - 2026-09-06

### Added
- Local live subtitles powered by whisper.cpp, with verified model downloads
  and an in-page caption overlay.
- Agent page reading as Markdown rather than flattened text.
- `cargo deny` licence and dependency-source policy in CI; `LICENSE`,
  `SECURITY.md` and `CONTRIBUTING.md`.
- Native permission enforcement (camera, microphone, prompts) in the vendored
  CEF runtime, with per-origin remembered decisions.

### Changed
- Release pipeline rebuilt so a release is proven (built, signed, verified)
  before the tag and version bump are recorded on `main`.
- Idle tab discard now confirms native close and protects active work
  (media, capture, unsaved forms, downloads, agent runs).
- Renderer crash recovery is bound to native view generations.

### Fixed
- Chromium media range requests and editor export recovery.
- Native New Tab input routing and first-open responsiveness.
- Navigation dialogs replaced without uncovering the page underneath.
- Discarded tabs restored correctly and counted in workspaces.
- Editor exports tracked as browser downloads; provider setup waits for
  confirmed activation.

[Unreleased]: https://github.com/ronaldxdale09/dive-browser/compare/v0.1.15...HEAD
[0.1.15]: https://github.com/ronaldxdale09/dive-browser/releases/tag/v0.1.15
[0.1.4]: https://github.com/ronaldxdale09/dive-browser/releases/tag/v0.1.4
