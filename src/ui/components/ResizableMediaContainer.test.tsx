// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ResizableMediaContainer from './ResizableMediaContainer';

describe('ResizableMediaContainer', () => {
  it('renders its children', () => {
    render(<ResizableMediaContainer><span>inner content</span></ResizableMediaContainer>);
    expect(screen.getByText('inner content')).toBeInTheDocument();
  });

  it('applies a 16:9 aspect ratio and horizontal-only resize by default', () => {
    const { container } = render(<ResizableMediaContainer><span>x</span></ResizableMediaContainer>);
    const box = container.firstElementChild as HTMLElement;
    const style = getComputedStyle(box);
    expect(style.aspectRatio).toBe('16/9');
    expect(style.resize).toBe('horizontal');
  });
});
