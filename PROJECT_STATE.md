# Project state — UCR Class Search (Chrome extension)

**Last reset:** 2026-04-19  
**Extension version:** 0.2.0 (see `extension/manifest.json`)

---

## What this is

A **Manifest V3** Chrome extension that augments UCR class registration search (`registrationssb.ucr.edu/StudentRegistrationSsb/*`) with a **data column** next to rows: icons for **MyClassGrades (CourseData)**, **RateMyProfessors**, **Google Sheet difficulty/comments**, and an **optional Gemini** summary. Network calls run in the **service worker**; the content script drives DOM injection and UI.

---

## Layout

| Path | Purpose |
|------|---------|
| `extension/manifest.json` | MV3 entry: permissions, host_permissions, content scripts, background worker |
| `extension/content.js` | Page DOM: observers, row detection, icons, popovers, `chrome.runtime.sendMessage` |
| `extension/background.js` | Fetches, caches, message routing, Gemini handler |
| `extension/styles.css` | Namespaced UI (`.ucrx-*` and related) |

---

## Host permissions (current)

UCR registration SPA, MyClassGrades site + API, RateMyProfessors, Google Docs/Sheets export, Google Generative Language API.

---

## Message / data flow (summary)

Content script sends typed messages; background returns parsed payloads. CORS-sensitive work stays in the worker. Details live in code (`FETCH_*` handlers in `background.js`, callers in `content.js`).

---

## Working assumptions

- Primary development target is the **current** `extension/` tree.
- Storage keys, cache TTLs, and parser behavior are **source of truth in `background.js`**.
- Reddit integration is **not** part of this project.

---

## Next (fill in as you go)

- [ ] *Add items here when you pick up work.*

---

## Maintaining this file

When you change permissions, hosts, message types, or major UI behavior, update the **Layout**, **Host permissions**, or **Message / data flow** sections in one or two sentences so the next session starts aligned with the repo.
