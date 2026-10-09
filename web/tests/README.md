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
