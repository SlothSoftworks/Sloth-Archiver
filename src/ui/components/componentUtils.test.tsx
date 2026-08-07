// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { formatComment } from './componentUtils';

describe('formatComment', () => {
  it('renders plain text with a line break per newline', () => {
    const { container } = render(<div>{formatComment('line one\nline two')}</div>);
    expect(container.textContent).toBe('line oneline two');
    expect(container.querySelectorAll('br')).toHaveLength(2); // one per line, including the last
  });

  it('turns a bare URL into a clickable link, leaving surrounding text intact', () => {
    const { container } = render(<div>{formatComment('check https://example.com/x out')}</div>);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.textContent).toBe('check https://example.com/x out');
  });

  it('linkifies multiple URLs across multiple lines independently', () => {
    const { container } = render(<div>{formatComment('https://a.com\nsome text https://b.com end')}</div>);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', 'https://a.com');
    expect(links[1]).toHaveAttribute('href', 'https://b.com');
  });

  it('renders plain text unchanged when there are no URLs', () => {
    const { container } = render(<div>{formatComment('nothing to link here')}</div>);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toBe('nothing to link here');
  });
});
