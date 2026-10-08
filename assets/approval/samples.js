// Sample jobs for the crew form. Each one takes a different route through approval.
export const JOB_SAMPLES = [
  {
    id: 'routine',
    label: 'Routine job',
    hint: 'Matches its PO and is under the auto-approve limit, so the invoice goes straight to the customer.',
    job: { customerId: 'HPB', po: 'PO-77335', description: 'Site electrical check, Block C', hours: '12', materials: '' },
  },
  {
    id: 'large',
    label: 'Large job',
    hint: 'Passes every check but is above the auto-approve limit, so it waits for the approver.',
    job: { customerId: 'ALC', po: 'PO-ALC-5640', description: 'Warehouse dock lighting upgrade', hours: '64', materials: '3,720' },
  },
  {
    id: 'typo',
    label: 'Hours typo',
    hint: '90 hours logged instead of 9. The invoice comes out far above its PO and is stopped before it reaches the customer.',
    job: { customerId: 'CVH', po: 'PO-88230', description: 'Smoke alarm replacement, Lot 14', hours: '90', materials: '' },
  },
  {
    id: 'twice',
    label: 'Logged twice',
    hint: 'This job was already logged and invoiced as INV-1056. The repeat is caught and sent to the bookkeeper.',
    job: { customerId: 'MRG', po: 'PO-4425', description: 'Lighting controls, Store 12', hours: '24', materials: '' },
  },
];
