# Apple Store pickup-stock radar

A tiny Cloudflare Worker that polls Apple's public pickup-availability endpoint and
sends a **push notification to your phone** the moment a product you care about shows
up at an Apple Store near you. It ships with an installable web app (PWA) for
notifications and live status. Runs on Cloudflare's free tier, no third-party notification service.

It checks the same data apple.com shows on a product page under "Check availability".
It does **not** place orders or bypass anything. It is for personal use, so keep the
poll interval polite (8-15 s is fine).

## What you need
- A free Cloudflare account and Node 18+
- An iPhone on iOS 16.4+ (Web Push requires adding the app to the Home Screen) or any Android/desktop browser

## Setup
```bash
npm install -g wrangler        # or use npx wrangler
wrangler login
```

1. **Edit `wrangler.toml`**: every line marked `<-- EDIT`:
   - `PRODUCT_NAME`, `BUY_URL`, `ZIP`, `RADIUS_MILES`
   - `PARTS`: the Apple part numbers you want, as `PART:label` pairs (see below)
   - `VAPID_SUBJECT`: your email as `mailto:you@example.com`
2. **Generate push keys**
   ```bash
   node scripts/vapid.mjs
   ```
   Put the `VAPID_PUBLIC=...` value into `wrangler.toml`. Store the private key as a secret:
   ```bash
   npx wrangler secret put VAPID_PRIVATE_JWK     # paste the VAPID_PRIVATE_JWK={...} JSON
   ```
3. **Pick an access token** (any long random string. It protects your API):
   ```bash
   npx wrangler secret put APP_TOKEN
   ```
4. **Deploy**
   ```bash
   npx wrangler deploy
   ```
5. **Install on your phone**: open the printed URL in Safari, Share → *Add to Home Screen*,
   open it from the Home Screen, enter your token, tap *Enable notifications*, then
   *Send test notification*.

The Worker starts polling as soon as you open the app once (it keeps itself running after that).

## Finding part numbers
Open the product's configuration page on apple.com (pick model, storage, color), view source,
and search for `partNumber`. Or search the page for your config name; the part number sits next to
it (e.g. `MK1G4LL/A`). US parts end in `LL/A`; other countries differ and need a different
`CPPART` and a different Apple domain path in `fetchPart()`.

## How it works
- `src/index.js`: routes requests; a single Durable Object runs an **alarm loop** every
  `POLL_SECONDS`, calls Apple, diffs against last state, and sends Web Push. (Cron triggers can't go faster than 1/min.)
- `src/webpush.js`: dependency-free Web Push (VAPID + aes128gcm) on WebCrypto.
- `public/`: the PWA (status screen, enable-notifications, test button).
- On 3 failed checks in a row you get an "is failing" push; on recovery, a "recovered" push.

## Customizing
Look for the "CUSTOMIZE HERE" comment in `src/index.js` `check()`: radius filtering, which stores
count, and what counts as "in stock". Per-config options live entirely in `wrangler.toml`.

## Notes
- Apple's endpoint is unofficial and can change or rate-limit without notice.
- Apple has returned `403` to the Worker when run through `wrangler dev` locally but works once deployed
  on Cloudflare's network. If you see persistent errors in the app, back off `POLL_SECONDS`.
- The Worker can't alert you if it is itself down. A free uptime monitor on your URL covers that.
