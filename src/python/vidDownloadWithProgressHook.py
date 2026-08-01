import sys
import json
import os
from yt_dlp import YoutubeDL
from yt_dlp import DownloadError
from yt_dlp.postprocessor.ffmpeg import FFmpegVideoConvertorPP
import subprocess
import re
import traceback

ansi_escape = re.compile(r'\x1b\[[0-9;]*m')

finalOutputName = [None]

def stripAnsi(text):
    return ansi_escape.sub('', text or '').strip()

class CustomLogger:
    def debug(self, msg):
        pass
    def warning(self, msg):
        pass
    def error(self, msg):
        emit('error', { 'message': str(self), 'type': 'YTDLP'})
        pass

def emit(eventType, data=None):
    message = {
        'type': eventType,
        'payload': data
    }
    print(json.dumps(message), flush=True)

def cleanFilename(filename):
    if not filename:
        return None
    base, ext = os.path.splitext(filename)
    cleaned_base = re.sub(r'\.f\d+$', '', base)
    return f"{cleaned_base}{ext}"

def downloadWithProgressEmitter(vidUrl, resolution, outputPath=None, format=None, additionalOptions=None):
    def progressHook(data):
        if data['status'] == 'downloading':
            percentStr = stripAnsi(data.get('_percent_str', ""))
            speedStr = stripAnsi(data.get('_speed_str', ""))
            emit('progress', {
                'filename': data.get('filename'),
                'downloadedBytes': data.get('downloaded_bytes'),
                'totalBytes': data.get('total_bytes') or data.get('total_bytes_estimate'),
                'percent': percentStr or None,
                'eta': data.get('eta'),
                'speed': speedStr or None,
            })
        elif data['status'] == 'finished':
            emit('downloadDone', {
                'filename': cleanFilename(data.get('filename')),
            })

    def post_hook(d):
        status = d.get("status")
        postproc = d.get("postprocessor", "unknown")
        filename = d.get("info_dict", {}).get("filepath") or d.get("filename")

        if status == "started":
            emit("postprocessing", {
                "stage": "start",
                "processor": postproc,
                "filename": filename
            })

        elif status == "finished":
            finalOutputName[0] = filename
            emit("postprocessing", {
                "stage": "finished",
                "processor": postproc,
                "filename": filename
            })

        elif status == "error":
            emit("postprocessing", {
                "stage": "error",
                "processor": postproc,
                "filename": filename,
                "error": d.get("error")
            })
    ydlOpts = {
        'progress_hooks': [progressHook],
        'postprocessor_hooks': [post_hook],
        'format': f'bestvideo[height<={resolution}]+bestaudio/best',
        'outtmpl': outputPath or "%(title)s.%(ext)s",
        'quiet': True,
        'no_warnings': True,
        'logger': CustomLogger()
    }

    postProc = {}
    if resolution.lower() == 'mp3':
        postProc = {
            'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192'
        }],
        'format': f'bestvideo[height<=144]+bestaudio/best',
        }
    elif format is not None:
        postProc = {
            'postprocessors': [{
            'key': 'FFmpegVideoConvertor',
            'preferedformat': format,
        }],
        }
    
    ydlOpts = ydlOpts | postProc | (additionalOptions or {})

    try:
        with YoutubeDL(ydlOpts) as ydl:
            ydl.download(vidUrl)
            emit('done', { 'filename': finalOutputName[0] })
    except DownloadError as e:
        emit('error', { 'message': str(e), 'type': 'DownloadError'})
        sys.exit(1)
    except Exception as e:
        tb = traceback.format_exc()
        emit('error', { 'message': tb, 'type': 'Exception'})
        import time
        time.sleep(2)
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        emit('error', { 'message': 'No video URL provided'})
        sys.exit(1)

    options = sys.argv[1]
    params = json.loads(options)

    vidUrl = params['videoUrl']
    outputPath = params['outputPath']
    format = params['format'] if params['format'] not in ['undefined', 'dflt'] else None
    resolution = params['resolution']
    additionalOptions = params.get('additionalOptions', {})

    downloadWithProgressEmitter(vidUrl, resolution, outputPath, format, additionalOptions)
