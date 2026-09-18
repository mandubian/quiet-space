# Jev Neutral

A Chrome/Chromium extension that classifies small page blocks and replaces likely advertisements with reversible neutral placeholders. This is an experimental text-based filter, not a network ad blocker.

## First milestone

Verify an unpacked extension on a local fixture: collect page blocks, send them to a loopback stub classifier, display decisions, and measure DOM scan throughput and total round-trip latency. Stub measurements do not predict Jev inference latency or classification accuracy.

## Architecture

- User clicks **Scan page**; nothing is sent before explicit consent.
- The extension collects a bounded set of visible, non-overlapping text blocks. Inputs, forms, editable regions, and page-wide containers are excluded.
- A loopback Node server accepts requests only from the configured extension, authenticated with a local pairing token.
- In live mode, the server asks one Noul question per block in a single Jev request. Credentials remain on the server.
- Code replaces only blocks above an experimental probability threshold; uncertain content stays untouched. Original DOM nodes can be restored.

## Scope and speed

The initial slice scans on demand. It does not promise instantaneous filtering, automatic scanning on navigation, comprehensive ad detection, or prevention of ad downloads. Image-only ads, inaccessible frames, canvas, shadow DOM, and browser-protected pages are outside initial coverage. A bounded candidate scan keeps local work predictable; cloud latency is measured separately. The fixture benchmark reports blocks per second and end-to-end time before further optimizations are added.

Page text, page title, hostname, and selected metadata are sent to TypeSafe in live mode. Do not scan sensitive pages. Form exclusion is not a guarantee that a page contains no private data.
