// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import VideoDetailCardSkeleton from './VideoDetailCardSkeleton';

// Purely presentational, no props and no branches -- a smoke test that it
// renders without throwing is the whole of what's worth verifying here.
describe('VideoDetailCardSkeleton', () => {
  it('renders without crashing', () => {
    const { container } = render(<VideoDetailCardSkeleton />);
    expect(container.firstChild).not.toBeNull();
  });
});
