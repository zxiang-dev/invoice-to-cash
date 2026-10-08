// Payment matching rules: decide what each remittance line pays, apply what is certain,
// and route everything else to a person. All writes go through the database so its
// controls and audit triggers see them.
import { all, one, run, asActor, audit, money, toCents } from '../db.js';
import { contentRef } from './parser.js';

export const KINDS = {
  short_pay: 'Short payment',
  overpayment: 'Overpayment',
  fuzzy_match: 'Confirm suggested match',
  unmatched: 'Unidentified cash',
  already_paid: 'Possible duplicate payment',
  wrong_customer: 'Payer / invoice mismatch',
  total_mismatch: 'Remittance total mismatch',
};

// Reviewer options per exception type. Labels may depend on the exception row.
export const ACTIONS = {
  short_pay: [
    { id: 'accept', label: 'Accept deduction', primary: true },
    { id: 'dispute', label: 'Dispute with customer' },
  ],
  overpayment: [
    { id: 'credit', label: 'Keep as credit', primary: true },
    { id: 'refund', label: 'Refund excess' },
  ],
  fuzzy_match: [
    { id: 'confirm', label: (e) => `Apply to ${e.suggested_invoice_id}`, primary: true },
    { id: 'reject', label: 'Not a match' },
  ],
  unmatched: [
    { id: 'credit', label: 'Hold as credit', primary: true },
    { id: 'refund', label: 'Refund' },
  ],
  already_paid: [
    { id: 'refund', label: 'Refund duplicate', primary: true },
    { id: 'credit', label: 'Hold as credit' },
  ],
  wrong_customer: [
    { id: 'confirm', label: (e) => `Apply to ${e.suggested_invoice_id} anyway` },
    { id: 'credit', label: 'Hold as credit', primary: true },
  ],
  total_mismatch: [{ id: 'ack', label: 'Acknowledge', primary: true }],
};

const EPS = 0.004;
const round = (n) => Math.round(n * 100) / 100;
// References compare without case or punctuation: inv 1042, INV-1042 and INV1042 are one invoice.
export const alnum = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const isPosted = (db, ref) => !!one(db, 'SELECT 1 FROM payments WHERE ref = ?', [ref]);

// Map characters that OCR and hurried typists confuse onto one form.
function lookalike(ref) {
  const body = alnum(ref).replace(/^INV/, '');
  return 'INV' + body.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
}

// Optimal string alignment distance: edits plus adjacent transpositions.
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function identifyPayer(parsed, rawText, customers) {
  const dom = parsed.senderDomain;
  if (dom) {
    const c = customers.find((c) => dom === c.email_domain || dom.endsWith('.' + c.email_domain));
    if (c) return { customer: c, how: 'sender domain' };
  }
  const lower = rawText.toLowerCase();
  const c = customers.find((c) => lower.includes(c.name.toLowerCase()));
  if (c) return { customer: c, how: 'company name in email' };
  return { customer: null, how: null };
}

// Returns { invoice, rule, fuzzy, confident, reason } or null.
function findInvoice(line, payer, invoices, balances) {
  if (line.invoiceRef) {
    const exact = invoices.find((i) => alnum(i.id) === alnum(line.invoiceRef));
    if (exact) return { invoice: exact, rule: 'Invoice number' };
  }
  if (line.poRef) {
    const byPo = invoices.filter((i) => i.po && alnum(i.po) === alnum(line.poRef));
    const open = byPo.filter((i) => balances.get(i.id) > EPS);
    const pick = open.find((i) => Math.abs(balances.get(i.id) - line.amount) < EPS) || open[0] || byPo[0];
    if (pick) return { invoice: pick, rule: 'PO number' };
  }

  const pool = invoices.filter((i) => balances.get(i.id) > EPS && (!payer || i.customer_id === payer.id));
  if (line.invoiceRef) {
    const target = lookalike(line.invoiceRef);
    const scored = pool
      .map((i) => ({ i, d: osa(lookalike(i.id), target), amt: Math.abs(balances.get(i.id) - line.amount) < EPS }))
      .filter((x) => x.d <= 1)
      .sort((a, b) => a.d - b.d || b.amt - a.amt);
    if (scored.length) {
      const best = scored[0];
      const why =
        best.d === 0
          ? `"${line.invoiceRef}" differs from ${best.i.id} only by look-alike characters (O/0, I/1)`
          : `"${line.invoiceRef}" is one keystroke away from ${best.i.id}`;
      return {
        invoice: best.i,
        rule: 'Fuzzy reference',
        fuzzy: true,
        confident: best.d === 0 && best.amt,
        reason: why + (best.amt ? ' and the amount matches exactly.' : ', but the amount differs.'),
      };
    }
  }
  if (payer) {
    const sameAmount = pool.filter((i) => Math.abs(balances.get(i.id) - line.amount) < EPS);
    if (sameAmount.length === 1) {
      const i = sameAmount[0];
      return {
        invoice: i,
        rule: 'Amount only',
        fuzzy: true,
        confident: false,
        reason: `Reference not recognised, but ${i.id} is the only open ${payer.name} invoice for exactly ${money(line.amount)}.`,
      };
    }
  }
  return null;
}

const raise = (db, paymentId, lineId, e) =>
  run(
    db,
    `INSERT INTO exceptions (payment_id, line_id, kind, invoice_id, suggested_invoice_id, amount_cents, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [paymentId, lineId, e.kind, e.invoice ?? null, e.suggested ?? null, e.amount == null ? null : toCents(e.amount), e.detail]
  );

export function processRemittance(db, rawText, parsed, policy) {
  const ref = parsed.paymentRef || contentRef(rawText);

  if (isPosted(db, ref)) {
    asActor(db, 'automation', () => audit(db, 'remittance.rejected', `Duplicate: payment ${ref} was already posted. Nothing applied.`));
    return { status: 'duplicate', ref };
  }
  if (!parsed.lines.length) {
    asActor(db, 'automation', () => audit(db, 'remittance.skipped', 'Email had no remittance lines; filed for a person to read.'));
    return { status: 'empty', ref };
  }

  const customers = all(db, 'SELECT * FROM customers');
  const invoices = all(db, 'SELECT * FROM invoice_status');
  const balances = new Map(invoices.map((i) => [i.id, i.balance]));

  let { customer: payer, how: payerHow } = identifyPayer(parsed, rawText, customers);
  if (!payer) {
    for (const line of parsed.lines) {
      const m = findInvoice(line, null, invoices, balances);
      if (m && !m.fuzzy) {
        payer = customers.find((c) => c.id === m.invoice.customer_id);
        payerHow = `inferred from ${m.invoice.id}`;
        break;
      }
    }
  }

  const amount = parsed.total ?? parsed.linesSum;
  const summary = { status: 'processed', ref, payer, payerHow, amount, auto: 0, flagged: 0, held: 0, applied: 0 };

  asActor(db, 'automation', () => {
    const paymentId = one(
      db,
      `INSERT INTO payments (ref, customer_id, paid_date, amount_cents, raw_text) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [ref, payer?.id ?? null, parsed.paidDate, toCents(amount), rawText]
    ).id;
    summary.paymentId = paymentId;

    let cashLeft = amount;
    for (const [idx, line] of parsed.lines.entries()) {
      const lineRef = line.invoiceRef ?? line.poRef ?? line.otherRef ?? '(no reference)';
      const lineCash = round(Math.min(line.amount, cashLeft));
      const m = findInvoice(line, payer, invoices, balances);
      const exceptions = [];
      let rule = m ? m.rule : 'No match';
      let outcome = 'held';
      let matched = null;
      let allocation = null;
      let writeOff = null;

      if (!m) {
        exceptions.push({
          kind: 'unmatched',
          amount: lineCash,
          detail: `No invoice or PO found for "${lineRef}" (${money(line.amount)}). Cash held as unapplied.` +
            (line.note ? ` Note on remittance: ${line.note}` : ''),
        });
      } else if (m.fuzzy && !(policy.autoFuzzy && m.confident)) {
        exceptions.push({ kind: 'fuzzy_match', suggested: m.invoice.id, amount: lineCash, detail: m.reason });
      } else if (payer && m.invoice.customer_id !== payer.id) {
        exceptions.push({
          kind: 'wrong_customer',
          suggested: m.invoice.id,
          amount: lineCash,
          detail: `${m.invoice.id} belongs to ${m.invoice.customer}, but this payment came from ${payer.name}.`,
        });
      } else if (balances.get(m.invoice.id) <= EPS) {
        exceptions.push({
          kind: 'already_paid',
          invoice: m.invoice.id,
          amount: lineCash,
          detail: `${m.invoice.id} is already paid in full. ${money(lineCash)} held — possible duplicate payment.`,
        });
      } else {
        const inv = m.invoice;
        const bal = balances.get(inv.id);
        const apply = round(Math.min(lineCash, bal));
        if (m.fuzzy) rule += ' (auto)';
        if (apply > EPS) {
          allocation = { invoice: inv.id, amount: apply, method: m.fuzzy ? 'fuzzy match (auto by policy)' : `matched on ${m.rule.toLowerCase()}` };
          cashLeft = round(cashLeft - apply);
          balances.set(inv.id, round(bal - apply));
          matched = inv.id;
          summary.applied = round(summary.applied + apply);
        }
        const short = round(bal - apply);
        const over = round(lineCash - apply);
        outcome = 'applied';
        if (over > EPS) {
          outcome = 'flagged';
          exceptions.push({
            kind: 'overpayment',
            invoice: inv.id,
            amount: over,
            detail: `Paid ${money(lineCash)} against ${inv.id} with ${money(bal)} open. ${money(over)} excess held as unapplied cash.`,
          });
        } else if (short > EPS && short <= policy.tolerance) {
          writeOff = { invoice: inv.id, amount: short, reason: `within ${money(policy.tolerance)} tolerance` };
          balances.set(inv.id, 0);
        } else if (short > EPS) {
          outcome = 'flagged';
          exceptions.push({
            kind: 'short_pay',
            invoice: inv.id,
            amount: short,
            detail: `Paid ${money(apply)} against ${inv.id} (${money(bal)} open) — short by ${money(short)}. ` +
              (line.note ? `Customer note: "${line.note}"` : 'No reason given on the remittance.'),
          });
        }
      }

      const lineId = one(
        db,
        `INSERT INTO remittance_lines (payment_id, line_no, ref_text, amount_cents, note, matched_invoice_id, rule, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [paymentId, idx + 1, lineRef, toCents(line.amount), line.note, matched, rule, outcome]
      ).id;
      if (allocation) {
        run(db, `INSERT INTO allocations (payment_id, invoice_id, amount_cents, method) VALUES (?, ?, ?, ?)`, [
          paymentId, allocation.invoice, toCents(allocation.amount), allocation.method,
        ]);
      }
      if (writeOff) {
        run(db, `INSERT INTO adjustments (invoice_id, amount_cents, kind, reason) VALUES (?, ?, 'small-balance write-off', ?)`, [
          writeOff.invoice, toCents(writeOff.amount), writeOff.reason,
        ]);
      }
      for (const e of exceptions) raise(db, paymentId, lineId, e);
      summary[outcome === 'applied' ? 'auto' : outcome] += 1;
    }

    if (parsed.total != null && Math.abs(parsed.total - parsed.linesSum) > EPS) {
      raise(db, paymentId, null, {
        kind: 'total_mismatch',
        amount: round(parsed.total - parsed.linesSum),
        detail: `Remittance says ${money(parsed.total)} was paid, but its lines add up to ${money(parsed.linesSum)}.`,
      });
    }

    const unapplied = round(amount - summary.applied);
    audit(db, 'ledger.posted', `Payment ${ref} posted: ${money(summary.applied)} applied` +
      (unapplied > EPS ? `, ${money(unapplied)} unapplied pending review` : ''));
  });

  return summary;
}

export function resolveException(db, id, action) {
  asActor(db, 'reviewer', () => {
    const e = one(db, `SELECT *, amount_cents / 100.0 AS amt FROM exceptions WHERE id = ? AND status = 'open'`, [id]);
    if (!e) return;
    const pay = one(db, `SELECT unapplied, customer FROM payment_status WHERE id = ?`, [e.payment_id]);
    const left = pay?.unapplied ?? 0;
    let resolution;

    if (action === 'accept') {
      run(db, `INSERT INTO adjustments (invoice_id, amount_cents, kind, reason) VALUES (?, ?, 'customer deduction', 'approved by reviewer')`, [
        e.invoice_id, toCents(e.amt),
      ]);
      resolution = `${money(e.amt)} deduction accepted and written off`;
    } else if (action === 'dispute') {
      run(db, `UPDATE invoices SET disputed = 1 WHERE id = ?`, [e.invoice_id]);
      resolution = `${money(e.amt)} disputed; collections to follow up`;
    } else if (action === 'confirm') {
      const target = e.suggested_invoice_id;
      const bal = one(db, `SELECT balance FROM invoice_status WHERE id = ?`, [target]).balance;
      const apply = round(Math.min(e.amt, bal, left));
      if (apply > EPS) {
        run(db, `INSERT INTO allocations (payment_id, invoice_id, amount_cents, method) VALUES (?, ?, ?, 'confirmed by reviewer')`, [
          e.payment_id, target, toCents(apply),
        ]);
      }
      if (e.line_id) run(db, `UPDATE remittance_lines SET matched_invoice_id = ?, outcome = 'reviewed' WHERE id = ?`, [target, e.line_id]);
      const short = round(bal - apply);
      const over = round(e.amt - apply);
      if (short > EPS) {
        raise(db, e.payment_id, e.line_id, {
          kind: 'short_pay', invoice: target, amount: short,
          detail: `After confirming the match, ${target} is still short by ${money(short)}.`,
        });
      } else if (over > EPS) {
        raise(db, e.payment_id, e.line_id, {
          kind: 'overpayment', invoice: target, amount: over,
          detail: `After confirming the match, ${money(over)} is left over and held as unapplied cash.`,
        });
      }
      resolution = `${money(apply)} applied to ${target}`;
    } else if (action === 'refund') {
      const amt = round(Math.min(e.amt, left));
      if (amt > EPS) run(db, `INSERT INTO refunds (payment_id, amount_cents, reason) VALUES (?, ?, ?)`, [e.payment_id, toCents(amt), KINDS[e.kind]]);
      resolution = `Refund of ${money(amt)} requested`;
    } else if (action === 'credit') {
      resolution = `${money(Math.min(e.amt, left))} kept as credit on ${pay?.customer ?? 'the payer'}'s account`;
    } else if (action === 'reject') {
      if (e.line_id) run(db, `UPDATE remittance_lines SET outcome = 'reviewed' WHERE id = ?`, [e.line_id]);
      resolution = `Suggestion rejected; ${money(e.amt)} stays unapplied`;
    } else {
      resolution = 'Acknowledged';
    }

    run(db, `UPDATE exceptions SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?`, [resolution, id]);
  });
}

// Ledger entry lines for one payment as it stands now: cash in, receivables cleared, the rest parked.
export function journalFor(db, paymentId) {
  const p = one(db, `SELECT * FROM payment_status WHERE id = ?`, [paymentId]);
  const allocs = all(db, `SELECT invoice_id, sum(amount_cents) / 100.0 AS amount FROM allocations WHERE payment_id = ? GROUP BY invoice_id ORDER BY min(id)`, [paymentId]);
  const lines = [{ account: 'Bank', memo: p.ref, debit: p.amount }];
  for (const a of allocs) lines.push({ account: 'Accounts receivable', memo: `${a.invoice_id} · ${p.customer ?? ''}`, credit: a.amount });
  if (p.unapplied > EPS) lines.push({ account: 'Unapplied cash', memo: 'Pending review / customer credit', credit: p.unapplied });
  if (p.refunded > EPS) lines.push({ account: 'Refunds payable', memo: p.customer ?? '', credit: p.refunded });
  return lines;
}
