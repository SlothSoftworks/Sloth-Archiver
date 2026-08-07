// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Other from './other';

// A placeholder route target with no props and no logic -- a smoke test
// that it renders without throwing is the whole of what's worth verifying.
describe('Other', () => {
  it('renders without crashing', () => {
    render(<Other />);
    expect(screen.getByText('KAGAO')).toBeInTheDocument();
  });
});
