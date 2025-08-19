import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

function isValidUrl(string: string) {
    try {
      new URL(string);
      return true;
    } catch (err) {
      return false;
    }
  };

function convertYYYYMMDDStringToDate(stringDate: string, format = 'YYYY / MMM / DD') {
  if (stringDate?.length != 8) {
    return null;
  }
  dayjs.extend(customParseFormat);

  return dayjs(stringDate, 'YYYYMMDD').format(format);
}

function converDurationStringToSeconds(durationString: string) {
  const segments = durationString.split(':');
  let hours = 0, mins = 0, seconds = 0;

  switch(segments.length) {
    case 3:
    hours = parseInt(segments[0]);
    mins = parseInt(segments[1]);
    seconds = parseInt(segments[2]);
    break;
    case 2:
      mins = parseInt(segments[0]);
      seconds = parseInt(segments[1]);
      break;
    case 1:
      seconds = parseInt(segments[0]);
      break;
  }

  return (hours * 24 * 60) + (mins * 60) + seconds;
}

function getEstimateFileSizeMbForMP3(durationString: string, kbps=320) {
  const bitrate = kbps * 1000;
  return ((converDurationStringToSeconds(durationString) * bitrate) / (8 * 1024 * 1024)).toFixed(2);
}

export { isValidUrl, convertYYYYMMDDStringToDate, getEstimateFileSizeMbForMP3, converDurationStringToSeconds };

