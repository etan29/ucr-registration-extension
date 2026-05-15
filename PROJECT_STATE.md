# Project state — UCR Class Search (Chrome extension)

**Last updated:** 2026-05-15  
**Extension version:** 0.2.0 (see `extension/manifest.json`)

---

## What this is

A **Manifest V3** Chrome extension that augments UCR class registration search (`registrationssb.ucr.edu/StudentRegistrationSsb/*`). It enhances the **Course Delivery** column with inline GPA / RMP preview lines and opens a **modal** (Grades, RMP, Reviews) fed by **MyClassGrades**, **RateMyProfessors**, and a **Google Sheet** difficulty database. Network calls run in the **service worker**; the content script handles DOM injection and UI.

Legacy **R'Lens / Data column** injections are stripped on load; do not reintroduce a separate column.

---

## Layout

| Path | Purpose |
|------|---------|
| `extension/manifest.json` | MV3 entry: permissions, host_permissions, content scripts, background worker, `web_accessible_resources` (tab icons) |
| `extension/content.js` | Page DOM: observers, row parsing, delivery-cell scores, modal + jumper tabs, `chrome.runtime.sendMessage` |
| `extension/background.js` | Cross-origin fetches, parsers, memory + `chrome.storage.local` cache |
| `extension/styles.css` | Namespaced UI (`.ucrd-*`) |
| `extension/*-{gold,black}.svg` | Modal jumper tab icons (Grades, RMP, Reviews); gold = active, black = idle |

---

## Host permissions (current)

UCR registration SPA, MyClassGrades site + GraphQL API, RateMyProfessors, Google Docs/Sheets CSV export.

No Gemini / `generativelanguage.googleapis.com` permission.

---

## Message / data flow (summary)

Content script → background (`background.js` `onMessage`):

| `type` | Purpose |
|--------|---------|
| `FETCH_MYCLASSGRADES` | Course grade distributions (GraphQL); professor filter on read |
| `FETCH_RMP` | Professor profile + reviews |
| `FETCH_SHEET_GRADES` | Difficulty database rows for course + professor |

CORS-sensitive work stays in the worker. Cache keys, TTLs, and parser versions are **source of truth in `background.js`**.

---

## UI model (current)

1. **Delivery column** — `ucrd-delivery-stack` in the existing Course Delivery cell: quick links for avg GPA and prof rating.
2. **Modal** — full panels for GPA (MyClassGrades dashboard), RMP, and sheet reviews; top **jumper** nav uses SVG icons from `web_accessible_resources`.
3. **Observers** — debounced rescans when the results table changes; removes legacy column markup if present.

---

## Working assumptions

- Primary development target is the **current** `extension/` tree.
- Icons are **SVG only** (no PNG assets in repo).
- Reddit integration is **not** part of this project.

---

## Next (fill in as you go)

- [ ] *Add items here when you pick up work.*

---

## Maintaining this file

When you change permissions, hosts, message types, assets, or major UI behavior, update **Layout**, **Host permissions**, **Message / data flow**, or **UI model** in one or two sentences so the next session starts aligned with the repo.
