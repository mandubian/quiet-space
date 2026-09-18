# Quiet Space

A Chrome/Chromium extension that judges small page blocks with [TypeSafe](https://www.typesafe.ai)'s **Jev** model and replaces likely advertisements with reversible neutral placeholders ("a little quiet space"). Bring your own API key; everything runs in your browser.

This is an experimental, judgment-based filter — **not** a network ad blocker. Nothing is blocked from loading; text-level ads are detected and swapped after the fact.

## Install (from source)

```sh
npm ci
npm run build        # bundles dist/extension
```

Then at `chrome://extensions`: enable Developer mode → **Load unpacked** → select `dist/extension`.

## Use

1. Get a TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai) and paste it into the popup (stored locally in your browser only)
2. Optional: check **Filter this site automatically** — grants the site permission, filters every page load, and follows dynamically inserted ads. Unchecking stops and restores
3. **Scan now** filters the current page on demand; **Restore page** undoes everything, and is only enabled when something was replaced
4. **Classification details** shows every block Jev judged, its probability, and the outcome

The replacement threshold (default 0.95) is a slider; blocks below it are never touched.

## How it works

- Code shortlists bounded, visible, non-overlapping candidates: labelled ad slots (`data-adunitpath`, `Publicité` frames), ad-network hosts (DoubleClick, Taboola, Outbrain, …) in links, images, iframes, and CSS backgrounds, plus text/label hints. Forms, inputs, and page chrome are excluded.
- One batched request sends candidate blocks (text, labels, hostname-level metadata — never full URLs or query strings) to TypeSafe: one Noul question per block, "is this an advertisement?"
- Blocks above the threshold are replaced with a quiet-space placeholder containing an undo button. Verdicts are cached (session + persisted per site) so repeat visits apply instantly with zero API calls.
- An optional local Node server (`npm start`) can hold the key instead of the browser; without it, the extension calls TypeSafe directly.

## Privacy

Page text, page title, hostname, and selected metadata of scanned pages are sent to TypeSafe. Automatic scanning is strictly opt-in per site (a permission you grant). Judgments are cached locally; nothing else leaves your machine.

## Limitations

Text-level ads only: images without metadata, iframe *content*, and video are not judged (their containers are, when labelled). Nothing is blocked from loading, so first-seen ads may be visible briefly before replacement. Uncertain blocks are always left untouched.

## Development

```sh
npm run check   # eslint + tsc + tests (includes real-Chromium e2e via Puppeteer) + build
```

The test suite is fully mocked — it never calls TypeSafe and needs no API key. CI runs the same checks plus a secret scan over tracked files and full history.
