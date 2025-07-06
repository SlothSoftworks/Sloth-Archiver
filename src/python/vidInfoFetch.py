import yt_dlp
from yt_dlp.utils import download_range_func
import json
import sys


def getVideoInfo(url, outputFormat = None, expectedRes = 1080, fileOutputTemplate = f'%(title)s%(resolution)s', additionalOptions = {}):
    desired_resolution = expectedRes  # Change to '1080p', '480p', etc.
    output_template = f'%(title)s%(resolution)s'

    # Convert '720p' to integer height
    resolution_height = int(desired_resolution)

    
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

        resolutions = sorted(set(
            fmt['height'] for fmt in formats
            if fmt.get('vcodec') != 'none' and fmt.get('height') is not None
        ))

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

url = sys.argv[1]
res = getVideoInfo(url)

#with open('data.json', 'w', encoding='utf-8') as fp: # print to file for debugging
#    json.dump(res, fp, ensure_ascii=False, indent=4)

print("VIDINFO=",json.dumps(res))



# info:
#     id
#     title
#     formats:
#         resolutions
#     thumnails: []
#     thumbnail: ""
#     description:
#     channel_url:
#     categories: []
#     tags:
#     release_timestamp:
#     channel: "channel name"
#     upload_date:
#     uploader_url:
#     original_url:
#     playlist: 
#     fulltitle:
#     diration_string:
#     release_date:
#     release_year:
#     _has_drm: ??? might be usefu
#     format:
#     ext: "mp4"
#     language: 
#     resolution: (actual reoslution it was downloaded in)
    
