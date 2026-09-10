# Where Dive stands against the other browser-control tools

Measured against [Playwright MCP](https://github.com/microsoft/playwright-mcp)'s
published tool list and Browserbase/Stagehand's documented surface. Kept here
so "are we ahead yet" has an answer that is not a matter of opinion.

The count is not the point — a tool that answers a whole question in one call
beats three that each answer a third of it, because an agent pays for every
round trip in latency and in context. Where Dive has fewer tools for the same
ground, that is the reason.

## Ground we both cover

| Capability | Playwright MCP | Dive |
|---|---|---|
| Click, type, press, hover, select | `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option` | `page_click`, `page_type`, `page_press`, `page_hover`, `page_select` |
| Fill a whole form | `browser_fill_form` | `page_fill_form` |
| Attach files | `browser_file_upload` | `page_upload` |
| Drag | `browser_drag`, `browser_drop` | `page_drag` |
| Read the page | `browser_snapshot` | `page_inspect`, `page_state`, `page_text` |
| Screenshot | `browser_take_screenshot` | `page_screenshot` |
| Navigate, back, reload | `browser_navigate`, `browser_navigate_back` | `tab_navigate`, `tab_history` |
| Tabs | `browser_tabs` | `tabs_list`, `tab_open`, `tab_close`, `tab_activate` |
| Wait | `browser_wait_for` | `page_wait_for` |
| Console | `browser_console_messages` | `console_tail` |
| Network log and bodies | `browser_network_requests`, `browser_network_request` | `network_list`, `network_body` |
| Evaluate JS | `browser_evaluate` | `page_evaluate` (off unless enabled) |
| Dialogs | `browser_handle_dialog` | `page_dialog` |
| Viewport | `browser_resize` | `page_resize`, `page_devices` |
| Assertions | 4 tools (`browser_verify_element_visible`, `browser_verify_list_visible`, `browser_verify_text_visible`, `browser_verify_value`) | 1 tool (`page_expect`) that checks visibility, text, values, counts, URL and title together, reports *every* check that did not hold rather than stopping at the first, says what was actually there, and can wait for them |
| Locator help | `browser_generate_locator` | `page_locate` |
| Route / mock | `browser_route`, `browser_unroute`, `browser_route_list` | `rules_set`, `rules_list` |
| Offline / conditions | `browser_network_state_set` | `page_throttle` |
| Raw keyboard control | `browser_press_key` (one key) | `page_keys` — a sequence of presses, text insertions and chords in one call, with repeat and pauses; editing chords (select-all, copy, cut, paste, undo, redo) actually perform the command rather than only firing a keydown |
| Raw pointer control | 6 tools (`browser_mouse_move_xy`, `browser_mouse_click_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_drag_xy`, `browser_mouse_wheel`) | 1 tool (`page_mouse`) that takes a *sequence* of steps, so a whole gesture — drawing on a canvas, dragging a map, working a slider — is one round trip instead of one per event |
| Save as PDF | `browser_pdf_save` | `page_pdf` — paper size by name, landscape, background, headers; the file is recorded as a download so one tool answers "what file did that produce" |
| Cookies and web storage | 15 tools (`browser_cookie_*`, `browser_localstorage_*`, `browser_sessionstorage_*`, `browser_storage_state`, `browser_set_storage_state`) | 3 tools (`page_storage`, `page_storage_set`, `page_storage_clear`) — each reads or writes all three kinds at once, and what `page_storage` returns is what `page_storage_set` takes, so restoring a session is a round trip rather than a reassembly |

## Where Browserbase's ground is

Browserbase sells isolated browser sessions you can run in parallel, and
session state you can carry between them. Playwright MCP has no context tool
at all -- it drives one browsing session, so two flows in it share cookies.

| Capability | Playwright MCP | Browserbase | Dive |
|---|---|---|---|
| Isolated parallel sessions | none | its whole product | `contexts`, `context_open`, `context_close`, and `context_id` on `tab_open` — each context has a cookie jar of its own, so two can be signed in as different people at once |
| Carrying a session between them | none | session persistence | `page_storage` / `page_storage_set` round trip |
| Where it runs | local | remote, metered | local, and it is the browser the person is already using |

## Where Dive is ahead

Nothing on this list has an equivalent in Playwright MCP.

| Dive | What it answers |
|---|---|
| `page_markdown` | The page as Markdown — structure and link targets at about the cost of plain text |
| `page_snapshot` + `page_diff` | What changed after an action: text, structure, new or fixed errors, new or gone requests |
| `page_component` | The React component that rendered an element, and the source file it came from |
| `api_spec` | An OpenAPI 3.1 document inferred from the traffic the tab has made |
| `dev_servers` | What is listening on this machine, with framework and pages |
| `page_report` | A Markdown bug report: page, console errors, failed requests |
| `page_appearance` | Colour scheme, reduced motion, media type, display mode |
| `page_inspect` | URL, title, loading, text, every interactive element with a locator, console errors, failed requests and what has already been tried — in one call |
| `dive_capabilities` | What this instance allows, so a client can ask before it guesses |
| Locators that repair themselves | A locator matching nothing is the commonest way automation fails. Instead of "call page_inspect and look", a miss names the closest few things that *are* on the page, so the next call can be the right one. `Sign In` → `Sign in`, `Email` → `Email address`, `Log in` → `Sign in`. Neither Playwright MCP nor Browserbase recovers from a miss |
| `downloads` | What files have been saved and where they landed — with `wait_ms` to wait for one in flight, which is what makes "click Export, then use the file" possible at all. Playwright MCP has no download tool: an agent can press the button but never find out what came out |
| A visible agent | The driven tab is marked in the tab list, the page carries an edge glow, and a virtual cursor glides to each target and ripples on click — so a person watching can see what is being done and where, rather than only its results |

## Still to close

- Self-healing is suggestion-only: it names candidates, it does not retry for you
- Tracing and video (`browser_start_tracing`, `browser_start_video`, `browser_start_recording`)
- Highlighting and annotation (`browser_highlight`, `browser_annotate`)
- Session reuse across separate processes (Browserbase keeps sessions alive server-side; Dive's live as long as the browser does)
