# Sidebar menu regression

Run `node --test tests/sidebar-menu.e2e.test.mjs` to exercise the actual FileTree at desktop and mobile sizes: the eight main entries, exclusive category expansion, existing toggles and nested preferences, menu scrolling on short screens, and the configuration panel remaining inside the sidebar. All backend requests are mocked.

# Configuration transfer regression

Configuration migration checks: `node --test tests/config-transfer.test.mjs tests/config-transfer.e2e.test.mjs` verifies archive validation, category defaults, node persistence, failed-import rollback, exclusion of project registrations and preferences, restart reminders, and the import/export dialog at desktop and mobile sizes. The browser fixture uses isolated mocked endpoints; it never imports into a running user's MindFS instance. Android/Harmony file saving and native node synchronization still need physical-device verification.

# Session virtualization browser regression

Start `npm run dev` in `web`, then open `/tests/session-virtualization.html`.
Run `await window.runVirtualizationChecks()` in the browser console on a fresh page.
It throws on failure and returns measured row/request counts on success.

Run `await window.runStreamingTextChecks()` to check 16 content/timestamp updates
in both short and virtualized histories. The row, Markdown wrapper, unchanged
paragraph, and code block must retain their DOM identity while text updates.

On a fresh page, run `await window.runScrollIntentChecks()` for slow upward
scrolling from the tail. It dispatches wheel/touch intent and applies twelve
5px scroll steps, then checks reading-position retention during append/viewport
changes and automatic following after returning to the bottom. Run it at desktop
and mobile viewport sizes; synthetic touch events do not replace real-device QA.

The fixture renders the real SessionViewer with 3,000 synthetic tool calls and
stubs detail requests. It checks bounded mounting, initial tail positioning,
search jumps, lazy detail loading, expansion/detail retention across unmounts,
reading position during append, reopening, tail following, short sessions,
large diff expansion, pending question retention, and default user-shell expansion. No live agent
or session is required. The fixture is not a production build entry point.

# Lexical IME regression

`node --test tests/lexical-ime.e2e.test.mjs` boots the real `TokenEditor` from
`tests/lexical-ime/` in a system Chromium via `playwright-core` and replays the
iFlytek-style empty-`compositionend` commit sequence over CDP. It guards the
Lexical 0.46.0 upgrade (upstream facebook/lexical#8701): committed English text

# Drawer inline edit viewport regression

Run `node --test tests/drawer-edit-viewport.e2e.test.mjs`. It mounts the real
AppShell, BottomSheet, and SessionViewer and edits the last user message. It
checks native IME overlay height changes with an unchanged layout viewport,
keyboard dismissal, layout viewport resizing, draft/focus retention, and desktop
drawer height. It replays viewport geometry; physical-device IME behavior still
requires device verification.
