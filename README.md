# MX11 Marketplace Compatibility Report (public, redacted)

A self-contained, static web report of Mendix Marketplace MX11 (React Client)
compatibility. Open `index.html` (via a web server) to view it.

## What's here

Generated artifacts only — **no source code**:

| File | Purpose |
|------|---------|
| `index.html` | SPA shell |
| `app.js`, `db-layer.js` | frontend |
| `analysis.db.gz` | gzipped SQLite dataset, fetched and inflated in-browser |
| `scan-meta.js` | scan timestamp |

## Redaction

This is a **redacted** copy. Internal production-usage figures
(`prod_apps_mx9` / `prod_apps_mx10`, sourced from an internal Mendix licensing
dataset) are **stripped from the database** — not merely hidden in the UI. The
public download counts shown are the same figures already public on
marketplace.mendix.com.

The build refuses to publish if any internal figure survives redaction (verified
against both the gzipped and embedded copies of the data).
