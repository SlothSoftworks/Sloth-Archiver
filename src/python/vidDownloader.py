import yt_dlp
from yt_dlp.utils import download_range_func
import sys

def downloadVideoByURL(url, outputFormat = None, expectedRes = 1080, fileOutputTemplate = f'%(title)s%(resolution)s', additionalOptions = {}):
    desired_resolution = expectedRes  # Change to '1080p', '480p', etc.
    output_template = f'%(title)s%(resolution)s'

    # Convert '720p' to integer height
    resolution_height = int(desired_resolution)

    
    yt_opts = {
        'verbose': True,
        #'download_ranges': download_range_func(None, [(start_time, end_time)]),
        'force_keyframes_at_cuts': True,
        'format': f'bestvideo[height<={resolution_height}]+bestaudio/best',
        'outtmpl': output_template,  # Save with correct extension
        #'cookiesfrombrowser': ('firefox',),
        # 'ffmpeg_location': '',  # optional
    }

    if outputFormat is not None:
        postProc = {
            'postprocessors': [{
            'key': 'FFmpegVideoConvertor',
            'preferedformat': outputFormat,  # Actual conversion happens here
        }],
        } 
        yt_opts = yt_opts | postProc

    yt_opts = yt_opts | additionalOptions # merging option dictionaries

    with yt_dlp.YoutubeDL(yt_opts) as ydl:
        ydl.download([url])

# downloadVideoByURL("https://www.youtube.com/watch?v=XneTxlzGYK0", "avi", "480")

print(sys.argv)