// Remittance emails: the samples, each exercising a different matcher rule, and the
// email written for a custom payment. Dates are relative to today.
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};
const iso = (n) => daysAgo(n).toISOString().slice(0, 10);
const long = (n) => daysAgo(n).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const PRESETS = [
  {
    id: 'clean',
    label: 'Clean payment',
    hint: 'Two invoices paid exactly. Should post with no human touch.',
    text: () => `From: Accounts Payable <ap@harborpoint.example>
To: receivables@northbeam.example
Subject: Remittance advice – payment TRX-55120

Hello Northbeam team,

Please find below details of our payment sent today.

Payment ref: TRX-55120
Payment date: ${iso(1)}
Total paid: USD 4,820.00

Invoice      PO          Amount
INV-1042     PO-77310    2,350.00
INV-1045     PO-77322    2,470.00

Regards,
Harbor Point Builders – Accounts Payable`,
  },
  {
    id: 'short',
    label: 'Short pay',
    hint: 'Customer deducted a backcharge. Cash is applied, the gap goes to review.',
    text: () => `From: payables@meridianretail.example
Subject: PAYMENT ADVICE 0098812

Meridian Retail Group — Payment Advice
Payment reference: MRG-0098812
Value date: ${long(1)}
Amount: USD 6,060.00

| Our PO     | Your invoice | Paid      | Comment                                        |
| PO-4410-A  | INV-1047     | 6,060.00  | Less backcharge – damaged display unit (180.00) |`,
  },
  {
    id: 'typo',
    label: 'Typo in invoice no.',
    hint: 'Letter O instead of zero. The matcher suggests the right invoice for a human to confirm.',
    text: () => `From: "Cedar Valley Homes" <finance@cedarvalley.example>
Subject: Payment sent

Hi, we paid the invoice below by bank transfer this morning.

Payment ref: CVH-PMT-3307
Payment date: ${iso(0)}

INV-1O51   1,875.00

Thanks,
Dana`,
  },
  {
    id: 'po',
    label: 'PO number only',
    hint: 'No invoice number at all. Matched through the purchase order, clearing a 70-day-old balance.',
    text: () => `From: ap-noreply@atlaslogistics.example
Subject: Atlas Logistics Co. – Remittance

REMITTANCE ADVICE
Transfer ID: ATL-77120458
Payment date: ${iso(1)}

Reference          Amount
PO-ALC-5531        12,800.00

Total payment: 12,800.00`,
  },
  {
    id: 'messy',
    label: 'Overpaid + unknown ref',
    hint: 'One line overpays, one line references nothing we know. Cash is held, not guessed.',
    text: () => `From: Bluewater Medical Centre <accounts.payable@bluewatermed.example>
Subject: EFT remittance BWM-EFT-20419

EFT reference: BWM-EFT-20419
Payment date: ${iso(2)}
Total: 3,370.00

Inv INV-1036   PO-BW-1207   3,000.00
Ref SVC-SEPT-26             370.00   (September call-out fee)`,
  },
  {
    id: 'duplicate',
    label: 'Duplicate remittance',
    hint: 'A re-sent email for a payment already posted. Blocked before it can double-count.',
    text: () => `From: ap@harborpoint.example
Subject: FW: Remittance advice – payment TRX-54980

Resending in case you didn't receive this one.

Payment ref: TRX-54980
Payment date: ${iso(6)}
Total paid: USD 2,100.00

INV-1040    PO-77301    2,100.00`,
  },
];

const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Writes the remittance email a payer would send for a custom payment, so it runs
// through the same extraction step as any other email.
export function composeRemittance({ payer, ref, lines }) {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const body = lines.map((l) => [l.ref || 'No reference', fmt(l.amount), l.note].filter(Boolean).join('    ')).join('\n');
  return `From: Accounts Payable <ap@${payer.email_domain}>
Subject: Remittance advice – payment ${ref}

Payment ref: ${ref}
Payment date: ${iso(0)}
Total paid: USD ${fmt(total)}

${body}

${payer.name}`;
}
