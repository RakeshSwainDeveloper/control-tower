/**
 * The status chip.
 *
 * Colour comes from `state_class`; the words come from `label`. A tenant that
 * renames "Verified" to "Checked by QA" changes the words and nothing else —
 * MVP_DATABASE_SCOPE §4. Deriving colour from the label would mean the first
 * tenant to rename a status got a grey chip for the rest of the product's life.
 */
export type StateClass =
  | 'draft' | 'submitted' | 'in_review' | 'in_approval' | 'approved' | 'rejected'
  | 'in_progress' | 'resolved' | 'verified' | 'closed' | 'cancelled' | 'on_hold' | 'void';

const TOKEN: Record<StateClass, string> = {
  draft: 'draft', submitted: 'submitted', in_review: 'review', in_approval: 'approval',
  approved: 'approved', rejected: 'rejected', in_progress: 'progress', resolved: 'resolved',
  verified: 'verified', closed: 'closed', cancelled: 'cancelled', on_hold: 'hold', void: 'void',
};

/** Fallback wording when the server sends no configured label. */
const DEFAULT_LABEL: Record<StateClass, string> = {
  draft: 'Draft', submitted: 'Submitted', in_review: 'In review', in_approval: 'In approval',
  approved: 'Approved', rejected: 'Rejected', in_progress: 'In progress', resolved: 'Resolved',
  verified: 'Verified', closed: 'Closed', cancelled: 'Cancelled', on_hold: 'On hold', void: 'Void',
};

export function StatusChip(
  { state, label, title }: { state: string; label?: string | null; title?: string },
) {
  const s = (TOKEN[state as StateClass] ? state : 'draft') as StateClass;
  const t = TOKEN[s];
  return (
    <span
      className="chip"
      title={title}
      style={{ background: `var(--st-${t}-bg)`, color: `var(--st-${t})` }}
    >
      {label || DEFAULT_LABEL[s]}
    </span>
  );
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severity is a separate scale and never reuses the state colours. */
export function SeverityChip({ severity }: { severity: string }) {
  const s = (SEVERITIES as readonly string[]).includes(severity) ? severity : 'low';
  return (
    <span className="chip" style={{ background: `var(--sev-${s}-bg)`, color: `var(--sev-${s})` }}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}
