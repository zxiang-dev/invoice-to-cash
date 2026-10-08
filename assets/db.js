// SQLite (sql.js, WASM) shared by both tabs: invoices are raised and approved in one,
// and paid in the other. Amounts are stored as integer cents; the views expose dollars.
const SQLJS = 'https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE customers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  terms_days   INTEGER NOT NULL
);

-- What each customer has agreed to pay for.
CREATE TABLE purchase_orders (
  po           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description  TEXT
);

-- Completed work as logged by the crew. The PO is free text: the checks decide if it is valid.
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  po              TEXT,
  description     TEXT NOT NULL,
  hours           REAL NOT NULL CHECK (hours > 0),
  rate_cents      INTEGER NOT NULL DEFAULT 9500,
  materials_cents INTEGER NOT NULL DEFAULT 0,
  done_date       TEXT NOT NULL DEFAULT (date('now'))
);

-- stage: a draft goes to approved and sent when it passes; otherwise it waits in fix (bookkeeper)
-- or approval (approver) first, or ends as void. Only sent invoices are receivables, and
-- paid is derived from the cash applied to them. Seeded invoices start out sent.
-- dup_cleared: the bookkeeper confirmed a possible duplicate is separate work.
CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  po           TEXT,
  job_id       TEXT REFERENCES jobs(id),
  issue_date   TEXT NOT NULL,
  due_date     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stage        TEXT NOT NULL DEFAULT 'sent',
  note         TEXT,
  approved_by  TEXT,
  dup_cleared  INTEGER NOT NULL DEFAULT 0,
  disputed     INTEGER NOT NULL DEFAULT 0
);

-- Cash received. One row per bank payment, identified by the payer's reference.
CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  ref          TEXT NOT NULL UNIQUE,
  customer_id  TEXT REFERENCES customers(id),
  paid_date    TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  raw_text     TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the remittance said, line by line, and what the matcher decided.
CREATE TABLE remittance_lines (
  id                 INTEGER PRIMARY KEY,
  payment_id         INTEGER NOT NULL REFERENCES payments(id),
  line_no            INTEGER NOT NULL,
  ref_text           TEXT,
  amount_cents       INTEGER NOT NULL,
  note               TEXT,
  matched_invoice_id TEXT REFERENCES invoices(id),
  rule               TEXT NOT NULL,
  outcome            TEXT NOT NULL  -- applied | flagged | held | reviewed
);

-- Cash applied to invoices.
CREATE TABLE allocations (
  id           INTEGER PRIMARY KEY,
  payment_id   INTEGER NOT NULL REFERENCES payments(id),
  invoice_id   TEXT NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Non-cash reductions of an invoice balance (accepted deductions, small write-offs).
CREATE TABLE adjustments (
  id           INTEGER PRIMARY KEY,
  invoice_id   TEXT NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  kind         TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unapplied cash returned to the payer.
CREATE TABLE refunds (
  id           INTEGER PRIMARY KEY,
  payment_id   INTEGER NOT NULL REFERENCES payments(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anything the automation will not decide on its own.
CREATE TABLE exceptions (
  id                   INTEGER PRIMARY KEY,
  payment_id           INTEGER REFERENCES payments(id),
  line_id              INTEGER REFERENCES remittance_lines(id),
  kind                 TEXT NOT NULL,
  invoice_id           TEXT REFERENCES invoices(id),
  suggested_invoice_id TEXT REFERENCES invoices(id),
  amount_cents         INTEGER,
  detail               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  resolution           TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at          TEXT
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE VIEW invoice_status AS
WITH paid AS (SELECT invoice_id, sum(amount_cents) AS v FROM allocations GROUP BY invoice_id),
     adj  AS (SELECT invoice_id, sum(amount_cents) AS v FROM adjustments GROUP BY invoice_id),
     b    AS (
       SELECT i.*, coalesce(paid.v, 0) AS paid_c, coalesce(adj.v, 0) AS adj_c,
              i.amount_cents - coalesce(paid.v, 0) - coalesce(adj.v, 0) AS bal_c
       FROM invoices i
       LEFT JOIN paid ON paid.invoice_id = i.id
       LEFT JOIN adj  ON adj.invoice_id  = i.id
     )
SELECT b.id, b.customer_id, c.name AS customer, b.po, b.due_date,
       b.amount_cents / 100.0 AS amount,
       b.paid_c / 100.0       AS paid,
       b.bal_c / 100.0        AS balance,
       CAST(julianday(date('now')) - julianday(b.due_date) AS INTEGER) AS days_past_due,
       CASE
         WHEN b.bal_c <= 0 AND b.adj_c > 0 THEN 'Closed (adj.)'
         WHEN b.bal_c <= 0 THEN 'Paid'
         WHEN b.disputed THEN 'Disputed'
         WHEN b.paid_c > 0 THEN 'Part-paid'
         WHEN date('now') > b.due_date THEN 'Overdue'
         ELSE 'Open'
       END AS status
FROM b JOIN customers c ON c.id = b.customer_id
WHERE b.stage = 'sent';

-- Every invoice with where it is in its life, including whether it has been paid.
CREATE VIEW invoice_pipeline AS
SELECT i.id, c.name AS customer, i.po, i.job_id, i.stage, i.note, i.approved_by,
       i.amount_cents / 100.0 AS amount,
       CASE
         WHEN i.stage <> 'sent' THEN i.stage
         WHEN s.balance <= 0 THEN 'paid'
         WHEN s.paid > 0 THEN 'part_paid'
         ELSE 'sent'
       END AS state
FROM invoices i
JOIN customers c ON c.id = i.customer_id
LEFT JOIN invoice_status s ON s.id = i.id;

-- What the pre-send checks see for an invoice, comparing it only with invoices raised before it.
CREATE VIEW invoice_checks AS
SELECT i.id,
       (SELECT d.id FROM invoices d
         WHERE d.rowid < i.rowid AND d.stage <> 'void' AND d.customer_id = i.customer_id
           AND (d.job_id = i.job_id OR (d.po = i.po AND d.amount_cents = i.amount_cents))
         ORDER BY d.rowid DESC LIMIT 1) AS duplicate_of,
       po.customer_id AS po_customer_id,
       (po.amount_cents - coalesce((SELECT sum(o.amount_cents) FROM invoices o
                                     WHERE o.po = i.po AND o.rowid < i.rowid AND o.stage <> 'void'), 0)) / 100.0 AS po_left
FROM invoices i
LEFT JOIN purchase_orders po ON po.po = i.po;

-- How much of each PO is still free to invoice.
CREATE VIEW po_status AS
SELECT po.po, po.customer_id, po.description,
       (po.amount_cents - coalesce((SELECT sum(i.amount_cents) FROM invoices i
                                     WHERE i.po = po.po AND i.stage <> 'void'), 0)) / 100.0 AS remaining
FROM purchase_orders po;

CREATE VIEW payment_status AS
WITH applied  AS (SELECT payment_id, sum(amount_cents) AS v FROM allocations GROUP BY payment_id),
     refunded AS (SELECT payment_id, sum(amount_cents) AS v FROM refunds GROUP BY payment_id)
SELECT p.id, p.ref, c.name AS customer,
       p.amount_cents / 100.0                                                       AS amount,
       coalesce(applied.v, 0) / 100.0                                               AS applied,
       coalesce(refunded.v, 0) / 100.0                                              AS refunded,
       (p.amount_cents - coalesce(applied.v, 0) - coalesce(refunded.v, 0)) / 100.0 AS unapplied
FROM payments p
LEFT JOIN customers c ON c.id = p.customer_id
LEFT JOIN applied  ON applied.payment_id  = p.id
LEFT JOIN refunded ON refunded.payment_id = p.id;

CREATE VIEW ar_aging AS
SELECT coalesce(sum(balance) FILTER (WHERE days_past_due <= 0), 0)              AS current,
       coalesce(sum(balance) FILTER (WHERE days_past_due BETWEEN 1 AND 30), 0)  AS d1_30,
       coalesce(sum(balance) FILTER (WHERE days_past_due BETWEEN 31 AND 60), 0) AS d31_60,
       coalesce(sum(balance) FILTER (WHERE days_past_due BETWEEN 61 AND 90), 0) AS d61_90,
       coalesce(sum(balance) FILTER (WHERE days_past_due > 90), 0)              AS d90_plus,
       coalesce(sum(balance), 0)                                                AS total
FROM invoice_status WHERE balance > 0;

CREATE VIEW kpis AS
SELECT (SELECT total FROM ar_aging)                                                AS ar_total,
       (SELECT coalesce(sum(balance), 0) FROM invoice_status
         WHERE balance > 0 AND days_past_due > 0)                                  AS ar_overdue,
       (SELECT coalesce(sum(unapplied), 0) FROM payment_status)                    AS unapplied,
       (SELECT count(*) FROM exceptions WHERE status = 'open')                     AS open_exceptions,
       (SELECT count(*) FROM remittance_lines)                                     AS lines_total,
       (SELECT count(*) FROM remittance_lines WHERE outcome = 'applied')           AS lines_auto;

-- Controls the database enforces whichever code path writes.
CREATE TRIGGER allocations_guard BEFORE INSERT ON allocations
BEGIN
  SELECT RAISE(ABORT, 'Blocked: cash can only be applied to an invoice that has been sent')
  WHERE (SELECT stage FROM invoices WHERE id = NEW.invoice_id) <> 'sent';
  SELECT RAISE(ABORT, 'Blocked: this would apply more than the invoice''s open balance')
  WHERE NEW.amount_cents > (
    SELECT i.amount_cents
         - coalesce((SELECT sum(amount_cents) FROM allocations WHERE invoice_id = i.id), 0)
         - coalesce((SELECT sum(amount_cents) FROM adjustments WHERE invoice_id = i.id), 0)
    FROM invoices i WHERE i.id = NEW.invoice_id);
  SELECT RAISE(ABORT, 'Blocked: this would apply more cash than the payment has unapplied')
  WHERE NEW.amount_cents > (
    SELECT p.amount_cents
         - coalesce((SELECT sum(amount_cents) FROM allocations WHERE payment_id = p.id), 0)
         - coalesce((SELECT sum(amount_cents) FROM refunds WHERE payment_id = p.id), 0)
    FROM payments p WHERE p.id = NEW.payment_id);
END;

CREATE TRIGGER invoices_stage_guard BEFORE UPDATE OF stage ON invoices
BEGIN
  SELECT RAISE(ABORT, 'Blocked: only an approver or the auto-approve policy can approve an invoice')
  WHERE NEW.stage = 'approved' AND app_actor() NOT IN ('approver', 'automation');
  SELECT RAISE(ABORT, 'Blocked: only an approved invoice can be sent')
  WHERE NEW.stage = 'sent' AND OLD.stage <> 'approved';
  SELECT RAISE(ABORT, 'Blocked: a sent invoice cannot go back into the approval workflow')
  WHERE OLD.stage = 'sent';
END;

CREATE TRIGGER invoices_amount_guard BEFORE UPDATE OF amount_cents ON invoices
BEGIN
  SELECT RAISE(ABORT, 'Blocked: only the bookkeeper can change an amount, and only before approval')
  WHERE app_actor() <> 'bookkeeper' OR OLD.stage IN ('approved', 'sent');
END;
`;

const SEED = `
INSERT INTO customers (id, name, email_domain, terms_days) VALUES
  ('HPB', 'Harbor Point Builders',    'harborpoint.example',    30),
  ('MRG', 'Meridian Retail Group',    'meridianretail.example', 45),
  ('CVH', 'Cedar Valley Homes',       'cedarvalley.example',    30),
  ('ALC', 'Atlas Logistics Co.',      'atlaslogistics.example', 60),
  ('BMC', 'Bluewater Medical Centre', 'bluewatermed.example',   30);

-- Dates are relative to today so the aging buckets always look realistic.
WITH v(id, customer_id, po, age, cents) AS (VALUES
  ('INV-1029', 'ALC', 'PO-ALC-5531', 130, 1280000),
  ('INV-1033', 'MRG', 'PO-4398',      80,  311550),
  ('INV-1036', 'BMC', 'PO-BW-1207',   95,  296000),
  ('INV-1038', 'HPB', 'PO-77290',     48,  198000),
  ('INV-1040', 'HPB', 'PO-77301',     27,  210000),
  ('INV-1042', 'HPB', 'PO-77310',     20,  235000),
  ('INV-1045', 'HPB', 'PO-77322',     15,  247000),
  ('INV-1047', 'MRG', 'PO-4410-A',    35,  624000),
  ('INV-1049', 'CVH', 'PO-88190',     40,  432000),
  ('INV-1051', 'CVH', 'PO-88213',     12,  187500),
  ('INV-1053', 'BMC', 'PO-BW-1240',    9,  154000),
  ('INV-1055', 'ALC', 'PO-ALC-5602',   5,  745000),
  ('INV-1056', 'MRG', 'PO-4425',       3,  228000))
INSERT INTO invoices (id, customer_id, po, issue_date, due_date, amount_cents)
SELECT v.id, v.customer_id, v.po,
       date('now', '-' || v.age || ' days'),
       date('now', '-' || v.age || ' days', '+' || c.terms_days || ' days'),
       v.cents
FROM v JOIN customers c ON c.id = v.customer_id;

-- Open POs for new work, then a fully used PO for each past invoice that has none yet.
INSERT INTO purchase_orders (po, customer_id, amount_cents, description) VALUES
  ('PO-4425',     'MRG', 912000, 'Lighting controls, stores 9–12'),
  ('PO-77335',    'HPB', 114000, 'Site electrical check, Block C'),
  ('PO-77340',    'HPB', 475000, 'Temporary power, Block D'),
  ('PO-ALC-5640', 'ALC', 980000, 'Warehouse dock lighting upgrade'),
  ('PO-88230',    'CVH',  85500, 'Smoke alarm replacement, Lot 14'),
  ('PO-BW-1262',  'BMC', 300000, 'Quarterly maintenance visit');
INSERT OR IGNORE INTO purchase_orders (po, customer_id, amount_cents)
SELECT po, customer_id, amount_cents FROM invoices;

-- The jobs behind the most recent invoices.
INSERT INTO jobs (id, customer_id, po, description, hours, materials_cents, done_date) VALUES
  ('JOB-2039', 'BMC', 'PO-BW-1240',  'Nurse call system service',   12,  40000, date('now', '-10 days')),
  ('JOB-2040', 'ALC', 'PO-ALC-5602', 'Yard floodlight replacement', 50, 270000, date('now', '-6 days')),
  ('JOB-2041', 'MRG', 'PO-4425',     'Lighting controls, Store 12', 24,      0, date('now', '-4 days'));
UPDATE invoices SET job_id = CASE id WHEN 'INV-1053' THEN 'JOB-2039' WHEN 'INV-1055' THEN 'JOB-2040' ELSE 'JOB-2041' END
WHERE id IN ('INV-1053', 'INV-1055', 'INV-1056');

INSERT INTO payments (id, ref, customer_id, paid_date, amount_cents, raw_text)
VALUES (1, 'TRX-54980', 'HPB', date('now', '-6 days'), 210000,
'From: ap@harborpoint.example
Subject: Remittance advice – payment TRX-54980

Payment ref: TRX-54980
Total paid: USD 2,100.00

INV-1040    PO-77301    2,100.00');

INSERT INTO allocations (payment_id, invoice_id, amount_cents, method)
VALUES (1, 'INV-1040', 210000, 'matched on invoice number');
`;

// Audit trail written by triggers, so no write path can bypass it. Created after the seed,
// so the starting ledger is summarised in one 'ledger.loaded' entry instead.
const AUDIT = `
CREATE TRIGGER jobs_audit AFTER INSERT ON jobs BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'job.logged',
    NEW.id || ' · ' || NEW.description || ' · ' || printf('%g', NEW.hours) || ' h for '
    || (SELECT name FROM customers WHERE id = NEW.customer_id));
END;

CREATE TRIGGER invoices_insert_audit AFTER INSERT ON invoices BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'invoice.drafted',
    NEW.id || ' for ' || fmt_money(NEW.amount_cents) || coalesce(' from ' || NEW.job_id, ''));
END;

CREATE TRIGGER invoices_stage_audit AFTER UPDATE OF stage ON invoices
WHEN NEW.stage IS NOT OLD.stage BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(),
    'invoice.' || CASE NEW.stage WHEN 'fix' THEN 'to_bookkeeper' WHEN 'approval' THEN 'to_approver'
                                 WHEN 'void' THEN 'voided' ELSE NEW.stage END,
    NEW.id || CASE NEW.stage
                WHEN 'sent' THEN ' emailed to ap@' || (SELECT email_domain FROM customers WHERE id = NEW.customer_id)
                ELSE coalesce(' · ' || NEW.note, '')
              END);
END;

CREATE TRIGGER invoices_amount_audit AFTER UPDATE OF amount_cents ON invoices
WHEN NEW.amount_cents IS NOT OLD.amount_cents BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'invoice.changed',
    NEW.id || ' amount ' || fmt_money(OLD.amount_cents) || ' → ' || fmt_money(NEW.amount_cents));
END;

CREATE TRIGGER payments_audit AFTER INSERT ON payments BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'payment.received',
    fmt_money(NEW.amount_cents) || ' received from '
    || coalesce((SELECT name FROM customers WHERE id = NEW.customer_id), 'unidentified payer')
    || ' · ref ' || NEW.ref);
END;

CREATE TRIGGER allocations_audit AFTER INSERT ON allocations BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'cash.applied',
    fmt_money(NEW.amount_cents) || ' from ' || (SELECT ref FROM payments WHERE id = NEW.payment_id)
    || ' applied to ' || NEW.invoice_id || ' · ' || NEW.method);
END;

CREATE TRIGGER adjustments_audit AFTER INSERT ON adjustments BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'invoice.adjusted',
    fmt_money(NEW.amount_cents) || ' written off on ' || NEW.invoice_id || ' · ' || NEW.kind
    || coalesce(' (' || NEW.reason || ')', ''));
END;

CREATE TRIGGER refunds_audit AFTER INSERT ON refunds BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'refund.requested',
    fmt_money(NEW.amount_cents) || ' to be refunded from ' || (SELECT ref FROM payments WHERE id = NEW.payment_id));
END;

CREATE TRIGGER exceptions_insert_audit AFTER INSERT ON exceptions BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'exception.raised',
    '#' || NEW.id || ' ' || NEW.kind || ' · ' || NEW.detail);
END;

CREATE TRIGGER exceptions_status_audit AFTER UPDATE OF status ON exceptions
WHEN NEW.status IS NOT OLD.status BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'exception.' || NEW.status,
    '#' || NEW.id || ' ' || NEW.kind || ' → ' || coalesce(NEW.resolution, NEW.status));
END;

CREATE TRIGGER invoices_disputed_audit AFTER UPDATE OF disputed ON invoices
WHEN NEW.disputed AND NOT OLD.disputed BEGIN
  INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), 'invoice.disputed', NEW.id || ' marked disputed');
END;
`;

export const money = (n) =>
  (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const toCents = (dollars) => Math.round(dollars * 100);

let SQL = null;
let actor = 'system';

export async function createDb() {
  SQL ??= await window.initSqlJs({ locateFile: (f) => SQLJS + f });
  const db = new SQL.Database();
  db.create_function('app_actor', () => actor);
  db.create_function('fmt_money', (cents) => money((cents ?? 0) / 100));
  db.exec(SCHEMA);
  db.exec(SEED);
  db.exec(AUDIT);
  run(db, `INSERT INTO audit_log (actor, action, detail)
            SELECT 'system', 'ledger.loaded', 'Ledger loaded: ' || (SELECT count(*) FROM customers) || ' customers, '
                   || (SELECT count(*) FROM invoices) || ' invoices sent, ' || (SELECT count(*) FROM payments) || ' payment applied'`);
  return db;
}

export function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export const one = (db, sql, params) => all(db, sql, params)[0];

// An audit entry for a decision no table write records on its own.
export const audit = (db, action, detail) =>
  run(db, `INSERT INTO audit_log (actor, action, detail) VALUES (app_actor(), ?, ?)`, [action, detail]);

export function run(db, sql, params = []) {
  db.run(sql, params);
}

// Run fn in a transaction with the audit actor set, so triggers record who did it.
export function asActor(db, who, fn) {
  actor = who;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    actor = 'system';
  }
}
