// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExtraDataTable from './ExtraDataTable';
import type { LibraryVideoMetadata } from '../../types';

function baseMetadata(overrides: Partial<LibraryVideoMetadata> = {}): LibraryVideoMetadata {
  return {
    videoId: 'vid1',
    channelId: null,
    channel: null,
    title: null,
    fullTitle: null,
    description: null,
    thumbnail: null,
    originalUrl: null,
    duration: null,
    durationString: null,
    uploadDate: null,
    addedEpoch: 0,
    downloadedFilePath: null,
    downloadedResolution: null,
    downloadedFormat: null,
    downloadedAudioFilePath: null,
    lastPlaybackPositionSeconds: null,
    ...overrides,
  };
}

// Broader end-to-end coverage (rendered inside LibraryVideoDetail, gated on
// isGeneric) lives in LibraryVideoDetail.test.tsx -- this file just covers
// ExtraDataTable's own render-nothing-when-empty contract directly.
describe('ExtraDataTable', () => {
  it('renders nothing when every field is null/absent', () => {
    const { container } = render(<ExtraDataTable metadata={baseMetadata()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only the populated fields', () => {
    render(<ExtraDataTable metadata={baseMetadata({ channel: 'DJ Sloth', license: 'CC BY 4.0' })} />);
    expect(screen.getByText('Extra data')).toBeInTheDocument();
    expect(screen.getByText('DJ Sloth')).toBeInTheDocument();
    expect(screen.getByText('CC BY 4.0')).toBeInTheDocument();
    expect(screen.queryByText('Categories')).not.toBeInTheDocument();
    expect(screen.queryByText('Tags')).not.toBeInTheDocument();
    expect(screen.queryByText('Music')).not.toBeInTheDocument();
  });

  it('renders the music sub-section only when metadata.music is present, skipping its own null fields', () => {
    render(<ExtraDataTable metadata={baseMetadata({
      music: { track: 'Sunset', artist: null, album: null, genre: 'Lofi' },
    })} />);
    expect(screen.getByText('Music')).toBeInTheDocument();
    expect(screen.getByText('Sunset')).toBeInTheDocument();
    expect(screen.getByText('Lofi')).toBeInTheDocument();
    expect(screen.queryByText('Artist')).not.toBeInTheDocument();
    expect(screen.queryByText('Album')).not.toBeInTheDocument();
  });
});
