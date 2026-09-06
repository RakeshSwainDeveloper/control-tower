/**
 * The status chip's one rule: colour from `state_class`, words from `label`.
 *
 * MVP_DATABASE_SCOPE §4 lets a tenant rename any status. If colour were derived
 * from the label, the first tenant to rename "Verified" would get a grey chip
 * for the rest of the product's life.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusChip, SeverityChip } from '../src/components/StatusChip.js';

describe('StatusChip', () => {
  it('takes its COLOUR from state_class and its WORDS from the label', () => {
    render(<StatusChip state="verified" label="Checked by QA" />);
    const chip = screen.getByText('Checked by QA');
    // A tenant renaming the status must not change the colour it renders in.
    expect(chip).toHaveStyle({ color: 'var(--st-verified)' });
  });

  it('falls back to a sane word when no label is configured', () => {
    render(<StatusChip state="in_approval" />);
    expect(screen.getByText('In approval')).toBeInTheDocument();
  });

  it('does not crash on a state class it has never seen', () => {
    // A future migration adds a state class before the UI knows about it. The
    // screen must still render; a white page is worse than a grey chip.
    render(<StatusChip state="quantum_superposition" label="Odd" />);
    expect(screen.getByText('Odd')).toBeInTheDocument();
  });

  it('keeps severity on its own colour scale, apart from state', () => {
    render(<SeverityChip severity="critical" />);
    expect(screen.getByText('Critical')).toHaveStyle({ color: 'var(--sev-critical)' });
  });
});
