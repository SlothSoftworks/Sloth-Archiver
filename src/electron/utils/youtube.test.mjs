import { describe, it, expect } from 'vitest';
import { parseYouTubeChannelUrl, isYouTubeChannelUrl } from './youtube.mjs';

const CHANNEL_ID = 'UCHnyfMqiRRG1u-2MsSQLbXA';

describe('parseYouTubeChannelUrl', () => {
    it.each([
        ['https://www.youtube.com/@veritasium', 'https://www.youtube.com/@veritasium/videos'],
        ['https://youtube.com/@veritasium', 'https://www.youtube.com/@veritasium/videos'],
        ['https://m.youtube.com/@veritasium', 'https://www.youtube.com/@veritasium/videos'],
        ['http://www.youtube.com/@veritasium/', 'https://www.youtube.com/@veritasium/videos'],
        [`https://www.youtube.com/channel/${CHANNEL_ID}`, `https://www.youtube.com/channel/${CHANNEL_ID}/videos`],
        ['https://www.youtube.com/c/veritasium', 'https://www.youtube.com/c/veritasium/videos'],
        ['https://www.youtube.com/user/1veritasium', 'https://www.youtube.com/user/1veritasium/videos'],
    ])('accepts %s', (input, expected) => {
        expect(parseYouTubeChannelUrl(input)).toBe(expected);
    });

    it.each(['videos', 'featured', 'shorts', 'streams', 'playlists', 'community', 'about', 'posts', 'podcasts', 'releases'])('normalises away a trailing /%s tab', (tab) => {
        expect(parseYouTubeChannelUrl(`https://www.youtube.com/@veritasium/${tab}`)).toBe('https://www.youtube.com/@veritasium/videos');
        expect(parseYouTubeChannelUrl(`https://www.youtube.com/channel/${CHANNEL_ID}/${tab}/`)).toBe(`https://www.youtube.com/channel/${CHANNEL_ID}/videos`);
    });

    it('strips the query string and fragment', () => {
        expect(parseYouTubeChannelUrl('https://www.youtube.com/@veritasium/videos?view=0&sort=dd&si=abc#top')).toBe('https://www.youtube.com/@veritasium/videos');
    });

    it('keeps a non-ASCII handle percent-encoded', () => {
        expect(parseYouTubeChannelUrl('https://www.youtube.com/@日本語')).toBe('https://www.youtube.com/@%E6%97%A5%E6%9C%AC%E8%AA%9E/videos');
    });

    it.each([
        ['a video id param', 'https://www.youtube.com/@veritasium?v=dQw4w9WgXcQ'],
        ['a list param', 'https://www.youtube.com/@veritasium/videos?list=PL123'],
        ['/@handle/live', 'https://www.youtube.com/@veritasium/live'],
        ['an unknown tab', 'https://www.youtube.com/@veritasium/somethingelse'],
        ['extra path segments', 'https://www.youtube.com/@veritasium/videos/extra'],
        ['music.youtube.com', 'https://music.youtube.com/@veritasium'],
        ['music.youtube.com channel', `https://music.youtube.com/channel/${CHANNEL_ID}`],
        ['youtu.be', 'https://youtu.be/@veritasium'],
        ['a lookalike host', 'https://www.youtube.com.evil.example/@veritasium'],
        ['another site', 'https://example.com/@veritasium'],
        ['a watch link', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
        ['a playlist link', 'https://www.youtube.com/playlist?list=PL123'],
        ['a shorts link', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
        ['a search link', 'https://www.youtube.com/results?search_query=x'],
        ['a feed link', 'https://www.youtube.com/feed/subscriptions'],
        ['the home page', 'https://www.youtube.com/'],
        ['a bare @', 'https://www.youtube.com/@'],
        ['/channel/ with no id', 'https://www.youtube.com/channel/'],
        ['/channel/ with a malformed id', 'https://www.youtube.com/channel/notAChannelId'],
        ['/c/ with no name', 'https://www.youtube.com/c/'],
        ['/user/ with no name', 'https://www.youtube.com/user'],
        ['a non-http scheme', 'ftp://www.youtube.com/@veritasium'],
        ['an option-looking string', '--exec=touch pwned'],
        ['an empty string', ''],
    ])('rejects %s', (_label, input) => {
        expect(parseYouTubeChannelUrl(input)).toBeNull();
    });

    it('returns null for a non-string', () => {
        expect(parseYouTubeChannelUrl(undefined)).toBeNull();
        expect(parseYouTubeChannelUrl(null)).toBeNull();
    });
});

describe('isYouTubeChannelUrl', () => {
    it('is true exactly when the URL parses as a channel', () => {
        expect(isYouTubeChannelUrl('https://www.youtube.com/@veritasium/shorts')).toBe(true);
        expect(isYouTubeChannelUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    });
});
