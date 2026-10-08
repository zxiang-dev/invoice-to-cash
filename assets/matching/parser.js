// Turns a free-text remittance email into structured fields using deterministic rules,
// so every extracted value can be explained.

const AMOUNT = /(?<![\w.\-\/])\$?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{1,2})(?![\d])/g;
const WHOLE_AMOUNT = /(?<![\w.\-\/$])\$?(\d{1,3}(?:,\d{3})+|\d+)(?![\w.\-\/])/g;
const INVOICE = /\bINV(?:OICE)?(?:\s*(?:no\.?|number|#))?[\s#:.-]*([A-Z0-9]*\d[A-Z0-9]*)\b/i;
const PO = /\bP\.?O\.?(?:\s*(?:no\.?|number|#))?[\s#:.-]*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)\b/i;
const OTHER_REF = /\b([A-Z]{2,}[-\/]?[A-Z0-9-]*\d[A-Z0-9-]*)\b/i;

const PAYMENT_REF = /\b(?:payment|transfer|remittance|eft|wire|trx)\s*(?:ref(?:erence)?|id|no\.?|number|#)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{3,})/i;
const PAID_DATE = /\b(?:payment|value|paid|transfer)\s*date\s*[:\-]?\s*(.+)$/i;
const TOTAL = /^(?:total(?:\s+(?:paid|amount|payment))?|amount(?:\s+paid)?|payment\s+amount)\s*[:\-]?\s*(?:[A-Z]{3}\s*)?\$?\s*(\d[\d,]*(?:\.\d{1,2})?)(?![\d.])/i;
const FROM = /^from\s*:\s*(.+)$/i;
const SUBJECT = /^subject\s*:\s*(.+)$/i;

const toNumber = (s) => Math.round(parseFloat(s.replace(/,/g, '')) * 100) / 100;

function parseDate(text) {
  const t = text.trim().replace(/\s{2,}.*/, '');
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = new Date(t);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

// The paid amount on a line: prefer one written with decimals. A whole number only counts
// when the line also carries an invoice or PO reference, so prose like "2 invoices" is ignored.
function findAmount(line) {
  AMOUNT.lastIndex = 0;
  const dec = AMOUNT.exec(line);
  if (dec) return { index: dec.index, length: dec[0].length, value: toNumber(dec[1] + '.' + dec[2]) };

  const refs = [INVOICE, PO].map((re) => line.match(re)).filter(Boolean);
  if (!refs.length) return null;
  const refEnd = Math.max(...refs.map((m) => m.index + m[0].length));
  WHOLE_AMOUNT.lastIndex = 0;
  for (let m; (m = WHOLE_AMOUNT.exec(line)); ) {
    if (m.index >= refEnd) return { index: m.index, length: m[0].length, value: toNumber(m[1]) };
  }
  return null;
}

export function parseRemittance(text) {
  const out = {
    sender: null,
    senderDomain: null,
    subject: null,
    paymentRef: null,
    paidDate: null,
    total: null,
    lines: [],
    linesSum: 0,
    warnings: [],
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // Treat table pipes and tabs as whitespace so pasted tables parse too.
    const line = rawLine.replace(/[|\t]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;

    let m;
    if ((m = line.match(FROM))) {
      out.sender = m[1].trim();
      const d = m[1].match(/@([\w.-]+)/);
      if (d) out.senderDomain = d[1].toLowerCase();
      continue;
    }
    if ((m = line.match(SUBJECT))) {
      out.subject = m[1].trim();
      if (!out.paymentRef && (m = line.match(PAYMENT_REF))) out.paymentRef = m[1].toUpperCase();
      continue;
    }
    if ((m = line.match(PAID_DATE))) {
      out.paidDate = parseDate(m[1]);
      continue;
    }
    if ((m = line.match(PAYMENT_REF)) && !INVOICE.test(line)) {
      out.paymentRef = m[1].toUpperCase();
      continue;
    }
    if ((m = line.match(TOTAL)) && !INVOICE.test(line) && !PO.test(line)) {
      out.total = toNumber(m[1]);
      continue;
    }

    // Anything else carrying an amount is treated as a remittance line.
    const amt = findAmount(line);
    if (!amt) continue;

    const before = line.slice(0, amt.index);
    const after = line.slice(amt.index + amt.length).trim();
    const inv = before.match(INVOICE) || line.match(INVOICE);
    const po = before.match(PO);
    let other = null;
    if (!inv && !po) {
      const o = before.match(OTHER_REF);
      other = o ? o[1].toUpperCase() : null;
    }

    out.lines.push({
      invoiceRef: inv ? 'INV-' + inv[1].toUpperCase() : null,
      poRef: po ? 'PO-' + po[1].toUpperCase().replace(/^-+/, '') : null,
      otherRef: other,
      amount: amt.value,
      note: after.replace(/^[-–—:,\s]+/, '') || null,
      source: rawLine.trim(),
    });
  }

  out.linesSum = Math.round(out.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  if (!out.lines.length) out.warnings.push('No remittance lines with an amount were found.');
  if (!out.paymentRef) out.warnings.push('No payment reference found; one will be derived from the email content.');
  if (out.total == null && out.lines.length) out.warnings.push('No total stated; using the sum of the lines.');
  return out;
}

// Stable short hash so a re-sent email without a reference is still caught as a duplicate.
export function contentRef(text) {
  let h = 2166136261;
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'RMT-' + (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
