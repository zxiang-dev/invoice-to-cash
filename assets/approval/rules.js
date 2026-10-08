// Approval rules: a logged job becomes a draft invoice, the pre-send checks run, and the
// invoice is routed: straight to the customer when clean and within the auto-approve limit,
// to the bookkeeper when it may be a duplicate, and to the approver otherwise. Each step runs
// as the person (or the automation) doing it, so the database controls and audit see who.
import { one, run, asActor, audit, money, toCents } from '../db.js';

const EPS = 0.004;

export const normalisePo = (s) => String(s ?? '').trim().toUpperCase();

const nextId = (db, table, prefix) =>
  one(db, `SELECT '${prefix}' || (max(CAST(substr(id, ${prefix.length + 1}) AS INTEGER)) + 1) AS id FROM ${table}`).id;

// Each check as { ok, kind, text, short }: text for the person deciding, short for the workflow strip.
export function checksFor(db, id) {
  const c = one(
    db,
    `SELECT k.duplicate_of, k.po_customer_id, k.po_left, i.customer_id, i.po, i.job_id, i.dup_cleared,
            i.amount_cents / 100.0 AS amount, pc.name AS po_customer, d.job_id AS dup_job
       FROM invoice_checks k
       JOIN invoices i ON i.id = k.id
       LEFT JOIN customers pc ON pc.id = k.po_customer_id
       LEFT JOIN invoices d ON d.id = k.duplicate_of
      WHERE k.id = ?`,
    [id]
  );
  const checks = [];

  if (!c.duplicate_of) checks.push({ ok: true, kind: 'duplicate', text: 'Not a duplicate' });
  else if (c.dup_cleared) checks.push({ ok: true, kind: 'duplicate', text: `Cleared as not a duplicate of ${c.duplicate_of}` });
  else
    checks.push({
      ok: false,
      kind: 'duplicate',
      short: 'Possible duplicate',
      text: `Possible duplicate of ${c.duplicate_of}: ` + (c.job_id && c.dup_job === c.job_id ? 'it bills the same job' : 'same customer, PO and amount'),
    });

  if (!c.po) checks.push({ ok: false, kind: 'po', short: 'No PO', text: 'No purchase order' });
  else if (!c.po_customer_id) checks.push({ ok: false, kind: 'po', short: 'PO not on file', text: `${c.po} is not on file` });
  else if (c.po_customer_id !== c.customer_id)
    checks.push({ ok: false, kind: 'po', short: 'Wrong customer’s PO', text: `${c.po} belongs to ${c.po_customer}` });
  else if (c.amount - c.po_left > EPS)
    checks.push({
      ok: false,
      kind: 'amount',
      short: 'Over its PO',
      text: `${money(c.amount - c.po_left)} more than is left on ${c.po} (${money(Math.max(c.po_left, 0))})`,
    });
  else checks.push({ ok: true, kind: 'amount', text: `Within ${c.po} (${money(c.po_left)} left)` });

  return { checks, failed: checks.filter((x) => !x.ok), amount: c.amount, poLeft: c.po_left };
}

const setStage = (db, id, stage, note, approvedBy = null) =>
  run(db, `UPDATE invoices SET stage = ?, note = ?, approved_by = coalesce(?, approved_by) WHERE id = ?`, [stage, note, approvedBy, id]);

function send(db, id) {
  run(
    db,
    `UPDATE invoices SET stage = 'sent', issue_date = date('now'),
            due_date = date('now', '+' || (SELECT terms_days FROM customers c WHERE c.id = invoices.customer_id) || ' days')
      WHERE id = ?`,
    [id]
  );
}

// Decide where an invoice goes next. Runs as the automation.
function route(db, id, policy) {
  const { failed, amount } = checksFor(db, id);
  const dup = failed.find((f) => f.kind === 'duplicate');
  if (dup) return setStage(db, id, 'fix', dup.text);
  if (failed.length) return setStage(db, id, 'approval', failed.map((f) => f.text).join('; '));
  if (amount > policy.limit + EPS) return setStage(db, id, 'approval', `${money(amount)} is above the ${money(policy.limit)} auto-approve limit`);
  setStage(db, id, 'approved', `Checks passed and within the ${money(policy.limit)} auto-approve limit`, 'automation');
  send(db, id);
}

export function logJob(db, job, policy) {
  const jobId = asActor(db, 'crew', () => {
    const id = nextId(db, 'jobs', 'JOB-');
    run(db, `INSERT INTO jobs (id, customer_id, po, description, hours, materials_cents) VALUES (?, ?, ?, ?, ?, ?)`, [
      id, job.customerId, normalisePo(job.po) || null, job.description, job.hours, toCents(job.materials),
    ]);
    return id;
  });
  const invoiceId = asActor(db, 'automation', () => {
    const id = nextId(db, 'invoices', 'INV-');
    run(
      db,
      `INSERT INTO invoices (id, customer_id, po, job_id, issue_date, due_date, amount_cents, stage)
       SELECT ?, j.customer_id, j.po, j.id, date('now'), date('now', '+' || c.terms_days || ' days'),
              CAST(round(j.hours * j.rate_cents) AS INTEGER) + j.materials_cents, 'draft'
         FROM jobs j JOIN customers c ON c.id = j.customer_id
        WHERE j.id = ?`,
      [id, jobId]
    );
    route(db, id, policy);
    return id;
  });
  return { jobId, invoiceId };
}

export function approve(db, id) {
  asActor(db, 'approver', () => setStage(db, id, 'approved', 'Approved by the approver', 'approver'));
  asActor(db, 'automation', () => send(db, id));
}

export function sendBack(db, id) {
  asActor(db, 'approver', () => {
    const { failed } = checksFor(db, id);
    setStage(db, id, 'fix', 'Returned by the approver' + (failed.length ? ': ' + failed.map((f) => f.text).join('; ') : ''));
  });
}

// The bookkeeper corrects the amount (if it changed) and the checks run again.
export function resubmit(db, id, amount, policy) {
  const cents = toCents(amount);
  asActor(db, 'bookkeeper', () => run(db, `UPDATE invoices SET amount_cents = ? WHERE id = ? AND amount_cents <> ?`, [cents, id, cents]));
  asActor(db, 'automation', () => route(db, id, policy));
}

export function clearDuplicate(db, id, policy) {
  asActor(db, 'bookkeeper', () => {
    run(db, `UPDATE invoices SET dup_cleared = 1 WHERE id = ?`, [id]);
    audit(db, 'invoice.not_duplicate', `${id} confirmed as separate work`);
  });
  asActor(db, 'automation', () => route(db, id, policy));
}

export function voidInvoice(db, id) {
  asActor(db, 'bookkeeper', () => setStage(db, id, 'void', 'Voided by the bookkeeper'));
}
