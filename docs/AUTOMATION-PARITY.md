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
| Raw pointer control | 6 tools (`browser_mouse_move_xy`, `browser_mouse_click_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_drag_xy`, `browser_mouse_wheel`) | 1 tool (`page_mouse`) that takes a *sequence* of steps, so a whole gesture — drawing on a canvas, dragging a map, working a slider — is one round trip instead of one per event |
| Cookies and web storage | 15 tools (`browser_cookie_*`, `browser_localstorage_*`, `browser_sessionstorage_*`, `browser_storage_state`, `browser_set_storage_state`) | 3 tools (`page_storage`, `page_storage_set`, `page_storage_clear`) — each reads or writes all three kinds at once, and what `page_storage` returns is what `page_storage_set` takes, so restoring a session is a round trip rather than a reassembly |

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
| A visible agent | The driven tab is marked in the tab list, the page carries an edge glow, and a virtual cursor glides to each target and ripples on click — so a person watching can see what is being done and where, rather than only its results |

## Still to close

- PDF save (`browser_pdf_save`)
- Raw keyboard primitives beyond `page_press`
- Tracing and video (`browser_start_tracing`, `browser_start_video`, `browser_start_recording`)
- Highlighting and annotation (`browser_highlight`, `browser_annotate`)
- Browserbase's ground: isolated parallel contexts, and session reuse across processes
