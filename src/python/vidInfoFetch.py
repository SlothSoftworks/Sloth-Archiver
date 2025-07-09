import yt_dlp
from yt_dlp.utils import DownloadError
import json
import sys


def getVideoInfo(url, additionalOptions = {}):    
    yt_opts = {
        'verbose': False,
        'quiet': True,
        'skip_download': True,
        #'cookiesfrombrowser': ('firefox',),
        # 'ffmpeg_location': '',  # optional
    }

    yt_opts = yt_opts | additionalOptions # merging option dictionaries

    with yt_dlp.YoutubeDL(yt_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        formats = info.get('formats', [])
        duration = info.get('duration')

        resolutions = []
        seen = set()

        for fmt in formats:
            height = fmt.get('height')
            if fmt.get('vcodec') == 'none' or not height:
                continue
            if height in seen:
                continue
            seen.add(height)

            size = fmt.get('filesize') or fmt.get('filesize_approx')
            if not size and fmt.get('tbr') and duration:
                size_kb = (fmt['tbr'] * duration) / 8
                size = size_kb * 1024
            if size is not None:
                size_mb = round(size / (1024 * 1024), 2)
            else:
                size_mb = None
            
            resolutions.append({
                'resolution': f"{height}",
                'filesizeMb': size_mb,
            })

        videoInfo = {
            'id': info['id'],
            'title': info['title'],
            'resolutions': resolutions,
            'thumbnail': info['thumbnail'],
            'additionalThumbnails': info['thumbnails'],
            'description': info['description'],
            'channelId': info['channel_id'],
            'duration': info['duration'],
            'durationString': info['duration_string'],
            'originalUrl': info['original_url'],
            'categories': info['categories'],
            'tags': info['tags'],
            'releaseTimestamp': info['release_timestamp'],
            'uploader': info['uploader'],
            'uploaderId': info['uploader_id'],
            'uploaderUrl': info['uploader_url'],
            'uploadDate': info['upload_date'],
            'playlist': info['playlist'],
            'playlistIndex': info['playlist_index'],
            'fullTitle': info['fulltitle'],
            'sourceFormat': info['ext'],
            'language': info['language'],
            }
        return videoInfo
    
if __name__ == '__main__':
    try:
        url = sys.argv[1]
        result = getVideoInfo(url)
        print(json.dumps({
            'success': True,
            'response': result,
        }))
    except DownloadError as e:
        print(json.dumps({
            'success': False,
            'error': 'DownloadError',
            'stacktrace': str(e),
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': 'Exception',
            'stacktrace': str(e),
        }))
        sys.exit(1)
    
