# thundu seetu

*A pocket of paper slips, reconciled.* Split trip expenses with friends with no internet at all.

Every expense is a slip of paper. Each phone keeps its own pile. In the evening, everyone passes
their pile around by scanning QR codes, and every phone ends up holding the same slips. When the **pile code**
matches on every phone, you're reconciled.

## How it works

| File | What it does |
|---|---|
| `core.js` | All the money logic. Events, splits (equal / amounts / % / shares / extras), balances, settle-up, pile files. No DOM, so it's tested in Node. |
| `db.js` | This phone's pile, stored in IndexedDB. |
| `app.js` | Screens: Slips, Tally, Pass around, Trip. |
| `qr.js` | Camera syncing (the main way to pass piles). Compresses a pile, cuts it into numbered pieces and reassembles them. |
| `vendor/` | QR drawing (`qrcode-generator`) and reading (`jsQR`), copied in so they work offline. Versions and hashes are in `vendor/README.md`. |
| `sw.js` | Service worker that keeps the app on the phone so it opens offline. |

### Two ways to pass a pile

- **Camera, the main way** (Pass around → *Show my pile* / *Scan a pile*). Needs no radios at all. One
  phone cycles through QR codes; the other scans until every piece is in, catching them in any order.
  Several phones can scan the same screen at once. A whole 9-day trip is about 40 codes, roughly
  10–20 seconds. *Just my new* sends only what you've written since you last passed your pile, which
  is usually one code. Tap *They've got it* when done so the app knows those slips have gone round.
- **AirDrop, the alternative** (*Send my pile* / *Take in piles*). Sends the pile as a file. The keeper
  can take in several files at once. Needs Wi-Fi and Bluetooth switched on.

### The evening reconcile

1. Pick a keeper. One by one, everyone shows their pile and the keeper scans it.
2. The keeper shows their pile, and everyone scans it.
3. Check every phone shows the same pile code.

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
- [ ] The creator opens Pass around → *Show my pile*; everyone else taps Home → *Join a friend's trip*, scans, and picks their name. Allow camera access when asked.
- [ ] **Turn on airplane mode**. Add a slip on each phone.
- [ ] Do one full evening reconcile and check all four pile codes match.
- [ ] Try the AirDrop route once too, as a backup. Set AirDrop to *Everyone for 10 minutes* or add each other as contacts first.

## Updating the app

Change files, bump `VERSION` in `sw.js`, and redeploy. Phones pick up the new version the next time
they open the app *while online*. Your slips are untouched by updates.
