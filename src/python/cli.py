import sys
import os
import json

import certifi
os.environ.setdefault('SSL_CERT_FILE', certifi.where())
os.environ.setdefault('REQUESTS_CA_BUNDLE', certifi.where())

from vidInfoFetch import getVideoInfo
from vidDownloadWithProgressHook import downloadWithProgressEmitter, emit
from yt_dlp.utils import DownloadError


def runInfo(argv):
    url = argv[0]
    additionalOptions = json.loads(argv[1]) if len(argv) > 1 else {}
    try:
        result = getVideoInfo(url, additionalOptions)
        print(json.dumps({'success': True, 'response': result}))
    except DownloadError as e:
        print(json.dumps({'success': False, 'error': 'DownloadError', 'stacktrace': str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({'success': False, 'error': 'Exception', 'stacktrace': str(e)}))
        sys.exit(1)


def runDownload(argv):
    if len(argv) < 1:
        emit('error', {'message': 'No video URL provided'})
        sys.exit(1)

    params = json.loads(argv[0])
    vidUrl = params['videoUrl']
    outputPath = params['outputPath']
    format = params['format'] if params['format'] not in ['undefined', 'dflt'] else None
    resolution = params['resolution']
    additionalOptions = params.get('additionalOptions', {})

    downloadWithProgressEmitter(vidUrl, resolution, outputPath, format, additionalOptions)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'No subcommand provided'}))
        sys.exit(1)

    subcommand = sys.argv[1]
    rest = sys.argv[2:]

    if subcommand == 'info':
        runInfo(rest)
    elif subcommand == 'download':
        runDownload(rest)
    else:
        print(json.dumps({'success': False, 'error': f'Unknown subcommand: {subcommand}'}))
        sys.exit(1)
