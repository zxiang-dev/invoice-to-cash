# Invoice to Cash

An invoice-to-cash workflow that runs entirely in the browser on an in-memory SQLite database (sql.js, WebAssembly). Two tabs share the one database, so an invoice approved in the first can be paid in the second.

**1 · Invoice approval.** The crew log a completed job and an invoice is drafted from it. Checks run for duplicates and for amounts beyond the purchase order. Clean invoices within the auto-approve limit are approved and emailed automatically; possible duplicates go to the bookkeeper and everything else to the approver. Switching between crew, bookkeeper and approver shows what each can see and do, and the database itself refuses approvals or amount changes by the wrong person.

**2 · Payment matching.** A remittance email is parsed into lines. Each line is matched to a sent invoice, trying in order: invoice number, PO number, look-alike or one-keystroke reference, then a unique amount. Cash is applied where the match is certain; anything else becomes an exception for a reviewer. The ledger, aging, KPIs, unapplied cash, ledger entry and audit trail all read from the same database.

- `assets/db.js`: schema, views, seed data, controls and audit triggers (amounts stored in cents)
- `assets/app.js`: tabs, database loading and Reset
- `assets/ui.js`: DOM helpers shared by both tabs
- `assets/approval/`: approval rules and checks, sample jobs, tab view
- `assets/matching/`: remittance parser, matching rules, sample remittances, tab view

## Run locally

Serve the folder with any static file server, for example:

```bash
python -m http.server 8765
```

Then open http://localhost:8765/. Opening `index.html` directly from disk won't work, because ES modules have to be served over HTTP.
