# Frontline Hub: how we build it

An internal workspace for Sales, Support and Customer Success. The UI is plain JS (`public/app.js`, `public/styles.css`, `public/index.html`), and the server is Node 22 (`server.js`, `src/`). Every outside system (HubSpot, Intercom, Jira, Slack, Snowflake, Google, Claude) runs in mock mode unless its keys are set. The sample data is a hotel procure-to-pay company, which is the reference vertical.

**Every new feature must look and behave like the existing ones, so that the product owner never has to point out drift.** Reuse what is listed below before inventing anything. If something genuinely new is needed, say so when proposing the feature.

## Working agreement
- Work on a branch. Merge to `main` only when the owner says "merge it". Tiny fixes may go straight to `main`.
- Clarify before large changes: propose options, recommend one, then build.
- Never email anyone but the owner's own address in live mode. Sample email addresses end in `.invalid`. Never ask for keys in chat; they go in Render → Environment.
- Before calling a feature done, work through the checklist at the bottom.

## The look: "Ledger"
Precise and editorial, like a well-set report. Aim for print, not a generic SaaS dashboard.
- **Surface:** warm paper, ink text and hairline rules. No shadows except on things that float (dialogs, menus, toasts). Corners are nearly square.
- **Fonts, only these three:**
  - `--font-display` (Instrument Serif) for page titles, the wordmark, dialog titles and section rows in tables.
  - `--font` (Google Sans Flex) for all text.
  - `--mono` (Google Sans Code) for money, counts and small-caps labels (table headers, stage names).
- **One accent:** deep green means "act here" (primary buttons, links, next steps). Red and amber are only for problems.
- **A page opens with a sentence, not number cards.** Under the serif `h1`, one `.dek` sentence weaves the key numbers in with `dn(value, tone)`, e.g. "$1.2M open across 10 deals; 2 close dates have passed…". Where separate figures read better (Good morning, an account's Support tab), use `figures([...])`: a slim row with hairlines, no boxes. Don't build rows of number cards.
- **People** show as `person(name)`: an initials avatar in a stable tint, then the name. Use it wherever a column is a person (owner, CSM, requester).
- **Details beside a list:** on the Pipeline board, clicking a deal opens a side panel (`dealPanel`) with the facts, all suggested actions and recent activity. The name still links to the account. On screens under 1360px it slides over the board. Reuse this pattern for other boards and lists that need "look before you open".

## Wording
- Soft, plain, non-technical sentences. Say what happened and what to do next.
- Titles read **"Account · action"** (for example "Lakeview Lodges · close date"). Never use "Account: action".
- Use "Next suggested action" (not "best"). The scope toggle is **Mine / Team**. The admin role is just "Admin".
- Levels are the same words everywhere: **Needs attention** (bad), **Worth a look** (warn), **All clear** (good).
- Dates:
  - A calendar date is shown as a date ("Oct 12"), for example close dates and renewals.
  - How long something has been open is shown as an age ("12 days", "3 hours").
  - Recent activity is shown relative to now ("48m ago").
- No emoji. Use line icons from the sprite in `index.html`. Add new icons there as `<symbol id="i-…">`.

## Page structure (copy an existing page)
1. `.page-head` (ends with a solid ink rule):
   - Left side: the serif `h1`, then the page's state as a `.dek` sentence. Pages without numbers keep one muted line describing the page.
   - Right side, top-right: the controls, meaning a `segButtons` filter (shown as underlined text) or a `.btn`.
2. Optional `figures([...])` when separate numbers read better than a sentence.
3. The list itself is **a table, not cards**: `.card.table-wrap > table.table`.
   - Grouped lists use `tr.group-row > th` (see Feature requests and Ops center).
   - A row that goes somewhere carries `data-href`, and the whole row is clickable.
   - Numbers are right-aligned (`.num-col`); short counts and fractions are centered (`.center-col`).
   - Status is a chip. Actions are buttons. There is one action per suggestion.
   - Extra detail opens through a **"+N more" link** (`.sa-more`) into an expanded row (`tr.sa-row`) with a `.sa-row-head` and cards inside. Don't use arrow toggles or a new expand pattern.
   - Optional columns carry `opt-a` or `opt-b`, so they step aside on narrow tables. `hide-sm` hides a column on phones. Phones switch the table to stacked cards; see the `@media (max-width: 760px)` blocks.

## Components to reuse (in `public/app.js` unless noted)
| Need | Use |
|---|---|
| Filter or toggle (Mine/Team, Board/Table, status filters) | `segButtons(attr, [[id, label, count]], selected)` inside `.seg.seg-inline`. Underlined `.tabs` are only for switching page sections. |
| Suggested action or a clickable item | `saCard` or `csCard` (`.sa` card: what to do + why + arrow). `+N more` uses `.sa-more`. |
| Risk or level | `riskChip(level, score)`, or `.chip.good/.warn/.bad` with a `.dot` |
| Account status | `statusChip(status)`. Enterprise uses `segBadge(segment)`. |
| A person | `person(name)`, or `avatar(name)` alone |
| Page summary | `.dek` with `dn(value, tone)` inside; `figures([{label, value, tone, sub}])` |
| A system (HubSpot, Slack…) | `src(systemId, name)`: the colored dot plus the name |
| Pop-up with a form | `formDialog(html, label, onSubmit(form, opts))`. It adds \* marks, shows errors under fields, and handles the "are you sure?" (`code: 'confirm'`) and "someone else edited this" (`code: 'stale'`) replies. Simple forms can use `openModal`. |
| Deal edits | Send `...dealBase(a)` (version + time zone) and `...opts`, so stale edits are caught |
| Busy button + error toast | `run(btn, fn)` |
| Notification | Server: `announce(text, { icon, tone, accountId })` inside `withActivity`. The UI shows it as a toast. |
| Trend | `sparkline(values)` |
| Motion | Nothing to add by hand. The motion layer animates new, moved and changed items, and bars fill on first view. Give new list rows a stable key (`data-href`, `data-key`, `data-deal` or `data-id`). |

## Styles (`public/styles.css`)
- Use the tokens only:
  - Fonts are `var(--font)`, `var(--font-display)` or `var(--mono)`.
  - Colors are `var(--…)`.
  - Text sizes are `var(--fs-2xs … --fs-title)`.
  - Corner radii are `var(--r-sm|md|lg|pill)`.
  - Spacing is `var(--s-1…4)`.
- No inline `style=""` except for data-driven widths or colors. Use the utility classes instead (`mt-1…4`, `mb-1…4`, `gap-1/2`, `fw-500/600`, `no-wrap`, `items-start`).
- Dark mode comes free from the tokens. Never hard-code a light-only color.

## Data rules (server is the source of truth)
- Every rule a form enforces is also checked in `src/services.js`. Errors return `{ error, field }` so the UI can point at the field. Unusual-but-valid values return `code: 'confirm'` with `warnings`.
- Required fields are marked with \*. New dates can't be in the past.
- Deals only move forward. Moving back is admin-only (with a reason); everyone else sends a request (`requestMoveBack`).
- Roles:
  - The server's GUARDS table in `server.js` enforces them against the caps in `src/access.js`.
  - The UI hides what a role can't use: `PAGE_CAP`, `canSee` and `applyNav`.
  - A new page needs a cap, an entry in `TITLES`, a sidebar link, and a route.

## Before calling a feature done
1. `npm run check:design` passes. It checks tokens (including fonts), inline styles, emoji, "Account · action" titles, number-card rows, and page wiring.
2. Screenshots in light, dark and phone (390px). No horizontal scroll, and no table cut off at 1024, 1280 or 1440px.
3. Compare the feature against this file: the same words, components and table patterns as the pages next to it.
4. Test it as each role that can reach it, and as one that can't.
5. Say in the summary if anything is new rather than reused, and why.
