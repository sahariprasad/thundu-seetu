# thundu seetu

*A pocket of paper slips, reconciled.* Split trip expenses with friends with no internet at all.

Every expense is a slip of paper. Each phone keeps its own pile. In the evening, everyone passes
their pile around (AirDrop), and every phone ends up holding the same slips. When the **pile code**
matches on every phone, you're reconciled.

## How it works

| File | What it does |
|---|---|
| `core.js` | All the money logic. Events, splits (equal / amounts / % / shares / extras), balances, settle-up, pile files. No DOM, so it's tested in Node. |
| `db.js` | This phone's pile, stored in IndexedDB. |
| `app.js` | Screens: Slips, Tally, Pass around, Trip. |
| `sw.js` | Service worker that keeps the app on the phone so it opens offline. |

- **Nothing is ever overwritten.** Adding, editing and deleting all write a *new* event. Merging two
  phones is a union of events, so order doesn't matter and taking in the same pile twice is harmless.
- **Edits:** the latest one wins. If two phones edit the same slip separately, it gets flagged
  "changed on two phones" until someone checks it and saves.
- **Money** is stored as whole paise/cents. Rounding leftovers go to a predictable person, so every
  phone computes identical balances.
- **Other currencies:** set a rate once in Trip → Money (e.g. 1 NPR = 0.625 INR). The rate passes
  around with the slips. Until a rate is set, those slips are tallied separately.

## Run locally

```bash
npm test          # core logic tests (Node 18+)
npm run serve     # http://localhost:8080
```

## Put it on everyone's phones (do this at home, with internet)

The app has to be loaded once over HTTPS, and after that it works offline. Any static host works,
for example GitHub Pages, Netlify Drop or Cloudflare Pages. Upload the folder as-is; there's no build step.

On each iPhone/iPad:
1. Open the URL in **Safari**.
2. Tap **Share → Add to Home Screen**. *This matters:* iOS can clear website data that's unused for
   7 days, but Home Screen apps are exempt.
3. Open it from the Home Screen icon (not Safari) from then on.

## Before you leave: dress rehearsal

- [ ] Everyone has it on their Home Screen; one person creates the trip.
- [ ] The creator sends their pile, and everyone else takes it in (Home → *Take in a pile*) and picks their name.
- [ ] **Turn on airplane mode**, then switch Wi-Fi and Bluetooth back on. Add a slip on each phone.
- [ ] Do one full evening reconcile and check all four pile codes match.
- [ ] Set AirDrop to *Everyone for 10 minutes* or add each other as contacts. AirDrop between strangers is limited.

## Updating the app

Change files, bump `VERSION` in `sw.js`, and redeploy. Phones pick up the new version the next time
they open the app *while online*. Your slips are untouched by updates.
