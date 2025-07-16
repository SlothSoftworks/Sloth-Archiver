import sys
import json
import os
from yt_dlp import YoutubeDL
from yt_dlp import DownloadError
import re

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

def downloadWithProgressEmitter(vidUrl, outputPath=None, format=None):
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
        'outtmpl': outputPath or "%(title)s.%(ext)s",
        'quiet': True,
        'no_warnings': True,
        'logger': CustomLogger()
    }
    if format:
        ydlOpts['format'] = format

    try:
        with YoutubeDL(ydlOpts) as ydl:
            ydl.download(vidUrl)
            emit('done', { 'filename': finalOutputName[0] })
    except DownloadError as e:
        emit('error', { 'message': str(e)})
        sys.exit(1)
    except Exception as e:
        emit('error', { 'message': str(e)})
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        emit('error', { 'message': 'No video URL provided'})
        sys.exit(1)

vidUrl = sys.argv[1]
outputPath = sys.argv[2] if len(sys.argv) > 2 else None
format = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'undefined' else None

#print('pythonvalues', vidUrl, outputPath, format, type(format))

downloadWithProgressEmitter(vidUrl, outputPath, format)