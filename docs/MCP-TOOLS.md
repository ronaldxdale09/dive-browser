# MCP tools

Generated from `dive_mcp::tool_catalog()` by `cargo test -p dive-mcp tool_reference`. Do not edit by hand.

To connect an agent, see [Connect an agent](../README.md#connect-an-agent).

## Universal arguments

The server reads these on any tool, so they are not repeated in each schema.

- `holder`: Who is driving. Names the agent for tab leases, so two agents do not act on the same tab at once.
- `max_chars`: How much text a reader returns. Defaults to 25000; at most 400000.
- `cursor`: Where to continue when a reader's answer was cut at `max_chars`; pass the `next_cursor` it returned.

`page_evaluate` is refused unless Dive was started with `DIVE_MCP_ALLOW_EVAL=1`.

## Summary

| Tool | Kind | Summary |
|---|---|---|
| [`api_spec`](#api_spec) | read | OpenAPI 3.1 document inferred from the requests a tab has made: paths, methods, statuses, query params. |
| [`console_tail`](#console_tail) | read | Recent console output for a tab: logs, warnings, uncaught exceptions and failed loads, oldest first. |
| [`context_close`](#context_close) | destructive | Close a context and every tab in it. |
| [`context_open`](#context_open) | act | Make a fresh isolated context and return its id, for running something in parallel without it sharing a session with anything else -- signing in as a second user, checking a signed-out view, or running two flows at once. |
| [`contexts`](#contexts) | read | The isolated contexts open right now, each with its id, name, how many tabs it holds and whether it has a cookie jar of its own. |
| [`dev_servers`](#dev_servers) | read | Dev servers listening on this machine, with port, URL, detected framework, page title, process and PID when the OS reports them. |
| [`dive_capabilities`](#dive_capabilities) | read | What this Dive instance allows: the locator grammar page_click and page_wait_for accept, and whether page_evaluate is enabled. |
| [`downloads`](#downloads) | read | The files this session has downloaded, newest first, with the path each landed at. |
| [`network_body`](#network_body) | read | The captured JSON response body of one request from network_list, truncated to a few KB. |
| [`network_list`](#network_list) | read | Recent requests for a tab with method, status, type, size and errors, oldest first. |
| [`page_appearance`](#page_appearance) | act | Emulate media preferences for a tab without touching the OS: {color_scheme:'dark'} to check dark mode, {reduced_motion:'reduce'}, {media_type:'print'}, {display_mode:'standalone'}. |
| [`page_batch`](#page_batch) | act | Run several tool calls in order in one round trip, stopping at the first failure. |
| [`page_click`](#page_click) | act | Click one element. |
| [`page_component`](#page_component) | read | The React component that rendered an element and the source file it came from, so a visual problem points at code. |
| [`page_devices`](#page_devices) | act | The device presets page_resize accepts, with their viewport size, pixel ratio and platform. |
| [`page_dialog`](#page_dialog) | act | Answer the JavaScript dialog a page has open: alert, confirm, prompt or a beforeunload question. |
| [`page_diff`](#page_diff) | read | Snapshot the page now and diff it against the previous snapshot: text, structure, new or fixed errors, new or gone requests. |
| [`page_drag`](#page_drag) | act | Drag the element from matches onto the element to matches, holding the pointer down and moving in steps, as reordering a list or moving a card needs. |
| [`page_evaluate`](#page_evaluate) | act | Evaluate a JavaScript expression in the page and return its JSON result. |
| [`page_expect`](#page_expect) | read | Check several things about the page at once and get told about every one that does not hold, not just the first. |
| [`page_fill_form`](#page_fill_form) | act | Fill several fields in one call: fields is a list of {locator, value}, filled in the order given. |
| [`page_hover`](#page_hover) | act | Move the pointer over an element without clicking, to open a hover menu, reveal a tooltip or trigger a :hover style. |
| [`page_inspect`](#page_inspect) | read | Everything about a page in one call: URL, title, loading state, visible text, interactive elements with the locator to address each one, recent console errors, recent requests, what this session has already done to the tab, and the viewport size. |
| [`page_keys`](#page_keys) | act | Play a keyboard sequence in one call: steps is a list of {key} presses, {text} insertions and {modifiers} chords, played in order. |
| [`page_locate`](#page_locate) | read | Describe the elements a locator matches without acting on them: role, name, tag, size and position. |
| [`page_markdown`](#page_markdown) | read | The page as Markdown: headings, absolute link targets, lists, tables and form state. |
| [`page_mouse`](#page_mouse) | act | Play a pointer gesture at viewport coordinates: steps is a list of {action, x, y} where action is move, down, up, click or wheel. |
| [`page_pdf`](#page_pdf) | read | Render the page to a PDF on disk and return the path. |
| [`page_press`](#page_press) | act | Press one key: {key:'Enter'}, {key:'Escape'}, {key:'Tab'}, {key:'ArrowDown'}, or {key:'a',modifiers:['Meta']}. |
| [`page_report`](#page_report) | read | Markdown bug report for a tab: URL, console errors and warnings, failed requests. |
| [`page_resize`](#page_resize) | act | Resize a tab's viewport to check responsive layout: {preset:'iphone-15'} for a device from page_devices, {width:1024,height:768} for an exact size, or {reset:true} to go back to filling the window. |
| [`page_screenshot`](#page_screenshot) | read | PNG screenshot of a tab's viewport, or the full document with full_page=true. |
| [`page_scroll`](#page_scroll) | act | Scroll the page, or a scrollable container named by a locator. |
| [`page_select`](#page_select) | act | Choose an option in a <select> dropdown by value or by its visible label, firing the input and change events the page listens for. |
| [`page_snapshot`](#page_snapshot) | read | Remember the page's text, structure, errors and requests so page_diff can show what changed later. |
| [`page_state`](#page_state) | read | Accessibility tree of a tab as indented text; interactive nodes carry [ref=eN] ids. |
| [`page_storage`](#page_storage) | read | Everything this site keeps on this machine, in one call: its cookies, its localStorage and its sessionStorage. |
| [`page_storage_clear`](#page_storage_clear) | destructive | Throw away this page's cookies, localStorage and sessionStorage, or the subset named in clear. |
| [`page_storage_set`](#page_storage_set) | act | Add or replace cookies, localStorage and sessionStorage for this page, in one call. |
| [`page_text`](#page_text) | read | Visible text of a page (document.body.innerText). |
| [`page_throttle`](#page_throttle) | act | Throttle a tab's network to check loading behaviour: 'offline', 'slow-3g', 'fast-3g', or 'none' to clear it. |
| [`page_type`](#page_type) | act | Type into one field, named the same ways as page_click. |
| [`page_upload`](#page_upload) | act | Attach files to an <input type="file">, as choosing them in the picker would, firing the change event the page listens for. |
| [`page_wait_for`](#page_wait_for) | read | Wait until every condition given holds: a locator matches, some text appears, the URL contains a substring, and/or loading finishes. |
| [`rules_list`](#rules_list) | read | Mock and rewrite rules of the current workspace: URL globs that block a request, answer it with a canned body, or add a request header. |
| [`rules_set`](#rules_set) | act | Replace the workspace's mock/rewrite rules. |
| [`tab_activate`](#tab_activate) | act | Bring a tab to the front so the person sees it. |
| [`tab_claim`](#tab_claim) | act | Take a tab for yourself under a name you pick, so another connected agent's actions are refused while you work. |
| [`tab_close`](#tab_close) | destructive | Close a tab. |
| [`tab_history`](#tab_history) | read | Go back or forward in a tab's history, or reload it: action is 'back', 'forward' or 'reload'. |
| [`tab_leases`](#tab_leases) | read | Which tabs are claimed, by whom, and for how much longer. |
| [`tab_navigate`](#tab_navigate) | act | Navigate a tab to a URL. |
| [`tab_open`](#tab_open) | act | Open a URL in a new tab and focus it. |
| [`tab_release`](#tab_release) | act | Give a claimed tab back so another agent can act in it. |
| [`tabs_list`](#tabs_list) | read | List open tabs in the active workspace with ids, URLs and titles. |

## Tools

### api_spec

Kind: read

OpenAPI 3.1 document inferred from the requests a tab has made: paths, methods, statuses, query params.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### console_tail

Kind: read

Recent console output for a tab: logs, warnings, uncaught exceptions and failed loads, oldest first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (nullable) | no | Maximum rows, newest kept (default 50). |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### context_close

Kind: destructive

Close a context and every tab in it. Only for a context you made with context_open; the person's own contexts are theirs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `context_id` | string (nullable) | no | The context to close, from `contexts`. |

### context_open

Kind: act

Make a fresh isolated context and return its id, for running something in parallel without it sharing a session with anything else -- signing in as a second user, checking a signed-out view, or running two flows at once. It gets a cookie jar of its own unless isolated is false. Pass its id to tab_open, and close it with context_close when the work is done.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `isolated` | boolean (nullable) | no | Give it a cookie jar of its own, so a sign-in here is not a sign-in anywhere else. True when omitted -- an isolated context that shares cookies is not isolated. |
| `name` | string (nullable) | no | What to call it. One is invented when omitted. |

### contexts

Kind: read

The isolated contexts open right now, each with its id, name, how many tabs it holds and whether it has a cookie jar of its own. A context is a separate browsing session: two of them can be signed in as different people at the same time, and neither can see the other's cookies or storage.

No parameters.

### dev_servers

Kind: read

Dev servers listening on this machine, with port, URL, detected framework, page title, process and PID when the OS reports them. Use it to find the app under test instead of guessing localhost:3000.

No parameters.

### dive_capabilities

Kind: read

What this Dive instance allows: the locator grammar page_click and page_wait_for accept, and whether page_evaluate is enabled. Call it once at the start rather than discovering a disabled tool by having a call refused.

No parameters.

### downloads

Kind: read

The files this session has downloaded, newest first, with the path each landed at. Give wait_ms straight after clicking something that saves a file, and it waits for the download to finish before answering -- which is what makes "click Export and then use the file" possible at all. The path is on this machine, so a client that can read files can open it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (nullable) | no | How many to report, newest first. Ten when omitted. |
| `wait_ms` | integer (nullable) | no | Wait up to this long for a download that has not finished yet, for use straight after clicking something that saves a file. |

### network_body

Kind: read

The captured JSON response body of one request from network_list, truncated to a few KB. Bodies may contain tokens or personal data; fetch only what you need.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request_id` | string | yes | Request id from `network_list`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### network_list

Kind: read

Recent requests for a tab with method, status, type, size and errors, oldest first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (nullable) | no | Maximum rows, newest kept (default 50). |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_appearance

Kind: act

Emulate media preferences for a tab without touching the OS: {color_scheme:'dark'} to check dark mode, {reduced_motion:'reduce'}, {media_type:'print'}, {display_mode:'standalone'}. Pass 'system' for any of them to clear that override.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `color_scheme` | string (nullable) | no | `light`, `dark`, or `system` to clear the override. |
| `display_mode` | string (nullable) | no | `standalone`, `browser`, `fullscreen`, `minimal-ui`, or `system` to clear. |
| `media_type` | string (nullable) | no | `screen`, `print`, or `system` to clear the override. |
| `reduced_motion` | string (nullable) | no | `reduce`, `no-preference`, or `system` to clear the override. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_batch

Kind: act

Run several tool calls in order in one round trip, stopping at the first failure. Each step is {tool, arguments}. Use it for a form: fill, fill, click, wait -- five round trips become one.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `steps` | array of BatchStep | yes | The calls, in order. Stops at the first failure. |

### page_click

Kind: act

Click one element. Prefer locator, which is resolved against the live page when the click runs and survives a re-render: role=button[name="Save"], text=Continue, testid=submit. A ref from page_state also works but goes stale after any change; x and y click a raw coordinate.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string (nullable) | no | Preferred. Playwright-style locator, resolved when the action runs. |
| `ref` | string (nullable) | no | Legacy `ref` id such as `e3` from the most recent `page_state`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `x` | number (nullable) | no | Viewport-relative x in CSS pixels. Must be paired with `y`. |
| `y` | number (nullable) | no | Viewport-relative y in CSS pixels. Must be paired with `x`. |

### page_component

Kind: read

The React component that rendered an element and the source file it came from, so a visual problem points at code. Needs a development build; a production bundle has no source locations and the name comes back minified or absent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string (nullable) | no | Preferred. Playwright-style locator, resolved when the action runs. |
| `ref` | string (nullable) | no | Legacy `ref` id such as `e3` from the most recent `page_state`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `x` | number (nullable) | no | Viewport-relative x in CSS pixels. Must be paired with `y`. |
| `y` | number (nullable) | no | Viewport-relative y in CSS pixels. Must be paired with `x`. |

### page_devices

Kind: act

The device presets page_resize accepts, with their viewport size, pixel ratio and platform.

No parameters.

### page_dialog

Kind: act

Answer the JavaScript dialog a page has open: alert, confirm, prompt or a beforeunload question. The page's script is paused until it is answered, and page_click, page_type and the other input tools refuse to run while one is open. page_inspect reports the open dialog under 'dialog' with its kind and message. accept:true presses OK or Leave (the default), accept:false presses Cancel or Stay; text is what a prompt receives.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `accept` | boolean (nullable) | no | `true` presses OK (or Leave); `false` presses Cancel (or Stay). Default true. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `text` | string (nullable) | no | What to enter in a `prompt()`; ignored by the other kinds. |

### page_diff

Kind: read

Snapshot the page now and diff it against the previous snapshot: text, structure, new or fixed errors, new or gone requests.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_drag

Kind: act

Drag the element from matches onto the element to matches, holding the pointer down and moving in steps, as reordering a list or moving a card needs. This drives pointer events, which is what drag libraries listen for; pages using native HTML5 drag-and-drop may not respond.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | string (nullable) | no | What to pick up, as a locator. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `to` | string (nullable) | no | Where to drop it, as a locator. |

### page_evaluate

Kind: act

Evaluate a JavaScript expression in the page and return its JSON result. Off unless Dive was started with the DIVE_MCP_ALLOW_EVAL environment variable set; there is no setting for it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `expression` | string | yes | Expression; its JSON-serializable result is returned. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_expect

Kind: read

Check several things about the page at once and get told about every one that does not hold, not just the first. Each check is one of: visible (a locator matches something a person can see), hidden, text (the page shows it), no_text, value ({locator, equals}), count ({locator, equals|at_least|at_most}), url_includes, title_includes. Give timeout_ms to keep re-checking until they all hold, which is the right way to assert after an action that takes a moment. A failure names what was actually there, so a wrong assertion is one call to diagnose rather than several.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `checks` | array of ExpectCheck | yes | The things that should be true. All of them are reported, not just the first that is not. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `timeout_ms` | integer (nullable) | no | Keep re-checking for up to this long before giving up. Omit for a single look at the page as it is right now. |

### page_fill_form

Kind: act

Fill several fields in one call: fields is a list of {locator, value}, filled in the order given. Handles text fields, <select> dropdowns and checkboxes -- for a checkbox or radio pass "true" or "false". Prefer this over repeated page_type: it is one round trip for the whole form, and it stops at the first field that fails and tells you which one.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fields` | array of FormField | yes | The fields, filled in the order given. |
| `submit` | boolean (nullable) | no | Press Enter in the last field when every field is filled. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_hover

Kind: act

Move the pointer over an element without clicking, to open a hover menu, reveal a tooltip or trigger a :hover style. Takes the same locator, ref or x/y as page_click. Follow it with page_inspect or page_screenshot to see what appeared.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string (nullable) | no | Preferred. Playwright-style locator, resolved when the action runs. |
| `ref` | string (nullable) | no | Legacy `ref` id such as `e3` from the most recent `page_state`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `x` | number (nullable) | no | Viewport-relative x in CSS pixels. Must be paired with `y`. |
| `y` | number (nullable) | no | Viewport-relative y in CSS pixels. Must be paired with `x`. |

### page_inspect

Kind: read

Everything about a page in one call: URL, title, loading state, visible text, interactive elements with the locator to address each one, recent console errors, recent requests, what this session has already done to the tab, and the viewport size. Start here instead of calling page_text, page_state, console_tail and network_list separately.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_keys

Kind: act

Play a keyboard sequence in one call: steps is a list of {key} presses, {text} insertions and {modifiers} chords, played in order. Each step takes repeat to press it several times and delay_ms to pause after it, and locator focuses something first. Use page_type for filling a field; this is for what a keyboard does that typing does not -- a shortcut like {key:'a', modifiers:['Meta']} then Backspace, walking a menu with ArrowDown, or a chord a page listens for.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string (nullable) | no | Focus this before typing. Omit to type at whatever has focus. |
| `steps` | array of KeyStep | yes | The steps, played in order. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_locate

Kind: read

Describe the elements a locator matches without acting on them: role, name, tag, size and position. Use it when a click reported that nothing matched, or to check a locator is unambiguous before relying on it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string | yes | The locator to describe. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_markdown

Kind: read

The page as Markdown: headings, absolute link targets, lists, tables and form state. Costs about what page_text costs but keeps the structure, so prefer it when you need to decide where to click or navigate next.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_mouse

Kind: act

Play a pointer gesture at viewport coordinates: steps is a list of {action, x, y} where action is move, down, up, click or wheel. The whole gesture goes in one call, so drawing on a canvas, dragging a map, or working a custom slider is one round trip rather than one per event. Use page_click for anything a locator can name -- this is for the things it cannot: canvases, maps, drawings, sliders with no accessible value. A wheel step takes delta_x and delta_y; any step takes delay_ms to pause after it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `steps` | array of MouseStep | yes | The steps, played in order. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_pdf

Kind: read

Render the page to a PDF on disk and return the path. Takes filename, landscape, paper (a4, a3, letter, legal, tabloid), background and headers. This is the print output, not a screenshot: text stays selectable and the page is laid out for paper, so it is what an invoice, a report or a receipt should be captured with.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `background` | boolean (nullable) | no | Print the background colours and images the page paints. |
| `filename` | string (nullable) | no | File name to save under. A name only, not a path: the file goes to the download folder either way. |
| `headers` | boolean (nullable) | no | Include the browser's own header and footer. |
| `landscape` | boolean (nullable) | no | Landscape instead of portrait. |
| `paper` | string (nullable) | no | Paper size by name: `a4`, `a3`, `letter`, `legal` or `tabloid`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_press

Kind: act

Press one key: {key:'Enter'}, {key:'Escape'}, {key:'Tab'}, {key:'ArrowDown'}, or {key:'a',modifiers:['Meta']}. Give a locator to focus a field first, or omit it to press against whatever has focus.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Key name: `Enter`, `Escape`, `Tab`, `ArrowDown`, `Backspace`, `a`, ... |
| `locator` | string (nullable) | no | Preferred. Playwright-style locator, resolved when the action runs. |
| `modifiers` | array of string | no | Held modifiers: any of `Meta`, `Control`, `Alt`, `Shift`. |
| `ref` | string (nullable) | no | Legacy `ref` id such as `e3` from the most recent `page_state`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `x` | number (nullable) | no | Viewport-relative x in CSS pixels. Must be paired with `y`. |
| `y` | number (nullable) | no | Viewport-relative y in CSS pixels. Must be paired with `x`. |

### page_report

Kind: read

Markdown bug report for a tab: URL, console errors and warnings, failed requests. Start here when the user says something is broken.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_resize

Kind: act

Resize a tab's viewport to check responsive layout: {preset:'iphone-15'} for a device from page_devices, {width:1024,height:768} for an exact size, or {reset:true} to go back to filling the window. A preset also emulates its pixel ratio, touch support, user agent and safe-area insets, and by default gives the page the viewport the device's own browser would (ui:'browser'); ui:'standalone' is an installed web app, ui:'none' the whole screen. Dive puts the device on screen in its simulator, so a later page_screenshot shows the page at that size inside the device rather than filling the window. The tab reloads only when the user agent changes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `height` | integer (nullable) | no | Exact viewport height in CSS pixels. Pair with `width`. |
| `orientation` | string (nullable) | no | `portrait` or `landscape`; only with a preset. |
| `preset` | string (nullable) | no | A device preset id from `page_devices`, such as `iphone-15`. |
| `reset` | boolean | no | Clear emulation and go back to filling the window. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `ui` | string (nullable) | no | What surrounds the page on the device: `browser` (the default; the viewport Safari or Chrome would give, minus their bars), `standalone` (an installed web app: status bar and home indicator only, with safe-area insets), or `none` (the whole screen). Only with a preset. |
| `width` | integer (nullable) | no | Exact viewport width in CSS pixels. Pair with `height`. |

### page_screenshot

Kind: read

PNG screenshot of a tab's viewport, or the full document with full_page=true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `full_page` | boolean | no | Capture the whole document instead of the viewport. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_scroll

Kind: act

Scroll the page, or a scrollable container named by a locator. Positive delta_y scrolls down, positive delta_x scrolls right. Use this to reach content below the fold before reading or clicking it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `delta_x` | number | no | Positive scrolls right. |
| `delta_y` | number | no | Positive scrolls down. |
| `locator` | string (nullable) | no | Preferred. Playwright-style locator, resolved when the action runs. |
| `ref` | string (nullable) | no | Legacy `ref` id such as `e3` from the most recent `page_state`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `x` | number (nullable) | no | Viewport-relative x in CSS pixels. Must be paired with `y`. |
| `y` | number (nullable) | no | Viewport-relative y in CSS pixels. Must be paired with `x`. |

### page_select

Kind: act

Choose an option in a <select> dropdown by value or by its visible label, firing the input and change events the page listens for. Clicking a native dropdown opens a menu CDP cannot see, so use this instead. Custom dropdowns built from divs are clicked like anything else.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string (nullable) | no | The option's visible text, matched whole and case-insensitively when `value` is not given. |
| `locator` | string (nullable) | no | Preferred. Playwright-style locator, resolved when the action runs. |
| `ref` | string (nullable) | no | Legacy `ref` id such as `e3` from the most recent `page_state`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `value` | string (nullable) | no | The option's `value` attribute. |
| `x` | number (nullable) | no | Viewport-relative x in CSS pixels. Must be paired with `y`. |
| `y` | number (nullable) | no | Viewport-relative y in CSS pixels. Must be paired with `x`. |

### page_snapshot

Kind: read

Remember the page's text, structure, errors and requests so page_diff can show what changed later.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_state

Kind: read

Accessibility tree of a tab as indented text; interactive nodes carry [ref=eN] ids. Cheaper than a screenshot and shows what can be clicked or typed into.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_storage

Kind: read

Everything this site keeps on this machine, in one call: its cookies, its localStorage and its sessionStorage. Reading cookies or stored data asks the person in Dive first. Pass include to narrow it. The shape it returns is the shape page_storage_set takes, so a signed-in session can be read once here and restored later or in another tab without going through the login again.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `include` | array (nullable) | no | Which kinds to read. All three when omitted. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_storage_clear

Kind: destructive

Throw away this page's cookies, localStorage and sessionStorage, or the subset named in clear. Use it to test a first visit, or a signed-out state, without a fresh profile.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `clear` | array (nullable) | no | Which kinds to clear. All three when omitted. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_storage_set

Kind: act

Add or replace cookies, localStorage and sessionStorage for this page, in one call. Takes what page_storage returns, so restoring a session is a round trip. Cookies default to the page's own host and to path /. The page is not reloaded: navigate or reload afterwards for it to read the new state. Setting cookies asks the person in Dive first, and only for this page's own site.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cookies` | array (nullable) | no | Cookies to add or replace. |
| `local` | object (nullable) | no | `localStorage` keys to add or replace. |
| `session` | object (nullable) | no | `sessionStorage` keys to add or replace. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_text

Kind: read

Visible text of a page (document.body.innerText). Cheap; prefer over screenshots.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_throttle

Kind: act

Throttle a tab's network to check loading behaviour: 'offline', 'slow-3g', 'fast-3g', or 'none' to clear it. Combine with tab_history reload and page_wait_for to see what a slow connection actually renders.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `profile` | string | yes | `offline`, `slow-3g`, `fast-3g`, or `none` to clear throttling. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_type

Kind: act

Type into one field, named the same ways as page_click. Replaces the existing value unless clear=false; set submit=true to press Enter afterwards.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `clear` | boolean (nullable) | no | Replace the field's current value instead of appending (default true). |
| `locator` | string (nullable) | no | Preferred. Playwright-style locator, resolved when the action runs. |
| `ref` | string (nullable) | no | Legacy `ref` id such as `e3` from the most recent `page_state`. |
| `submit` | boolean | no | Press Enter afterwards. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `text` | string | yes | Text to insert. |
| `x` | number (nullable) | no | Viewport-relative x in CSS pixels. Must be paired with `y`. |
| `y` | number (nullable) | no | Viewport-relative y in CSS pixels. Must be paired with `x`. |

### page_upload

Kind: act

Attach files to an <input type="file">, as choosing them in the picker would, firing the change event the page listens for. paths are absolute paths to files in Downloads, Desktop, Documents or the download folder, and the person is asked in Dive before they are attached; an empty list clears the input. A file picker opened by a click cannot be driven, so upload through the input itself.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string (nullable) | no | The `<input type="file">`, as a locator. |
| `paths` | array of string | yes | Absolute paths of the files to attach. An empty list clears the input. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### page_wait_for

Kind: read

Wait until every condition given holds: a locator matches, some text appears, the URL contains a substring, and/or loading finishes. Call this after a navigation or a click that starts work, instead of taking a screenshot and hoping.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `load` | boolean | no | Wait for loading to finish. |
| `locator` | string (nullable) | no | Wait for at least one element to match this locator. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `text` | string (nullable) | no | Wait for this text to appear in the page's visible text. |
| `timeout_ms` | integer (nullable) | no | Give up after this long. Default 15000, maximum 60000. |
| `url_includes` | string (nullable) | no | Wait for the URL to contain this substring. |

### rules_list

Kind: read

Mock and rewrite rules of the current workspace: URL globs that block a request, answer it with a canned body, or add a request header.

No parameters.

### rules_set

Kind: act

Replace the workspace's mock/rewrite rules. Use to simulate API failures or canned responses; pass an empty list to clear. Adding mock or header rules asks the person in Dive first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rules` | array | yes | Full rule list. Each rule: {id, pattern (URL glob with *), enabled, action} where action is `{kind:"block"}`, `{kind:"mock", status, content_type, body}` or `{kind:"header", name, value}`. |

### tab_activate

Kind: act

Bring a tab to the front so the person sees it. Tab-scoped tools work on background tabs too; use this when the point is to show something.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### tab_claim

Kind: act

Take a tab for yourself under a name you pick, so another connected agent's actions are refused while you work. Reading is never blocked. Pass the same holder on later calls; the claim renews itself while you act and lapses on its own.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `holder` | string | yes | The name you are claiming under. Anything stable: an agent's name, a session id. It appears in the refusal another client gets. |
| `seconds` | integer (nullable) | no | How long to hold it without acting, in seconds. Defaults to two minutes and renews itself while you work. |
| `tab_id` | string (nullable) | no | Tab to claim; the active tab when left out. |

### tab_close

Kind: destructive

Close a tab. Use it to tidy up tabs you opened; the person's own tabs are theirs to close.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### tab_history

Kind: read

Go back or forward in a tab's history, or reload it: action is 'back', 'forward' or 'reload'. Follow it with page_wait_for load:true; reload is how to see a change after page_throttle or rules_set.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | yes | `back`, `forward` or `reload`. |
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |

### tab_leases

Kind: read

Which tabs are claimed, by whom, and for how much longer.

No parameters.

### tab_navigate

Kind: act

Navigate a tab to a URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | string (nullable) | no | Tab id from `tabs_list`; defaults to the active tab. |
| `url` | string | yes | Absolute URL. |

### tab_open

Kind: act

Open a URL in a new tab and focus it. Returns the tab. Pass context_id from contexts to open it in another context instead of the one in front.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `context_id` | string (nullable) | no | Open it in this context instead of the one in front. From `contexts`. |
| `url` | string | yes | Absolute URL (https://...). |

### tab_release

Kind: act

Give a claimed tab back so another agent can act in it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `holder` | string | yes | The name you are claiming under. Anything stable: an agent's name, a session id. It appears in the refusal another client gets. |
| `seconds` | integer (nullable) | no | How long to hold it without acting, in seconds. Defaults to two minutes and renews itself while you work. |
| `tab_id` | string (nullable) | no | Tab to claim; the active tab when left out. |

### tabs_list

Kind: read

List open tabs in the active workspace with ids, URLs and titles. Sleeping tabs are omitted.

No parameters.
