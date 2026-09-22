import { Chip, Divider, Stack, Typography } from '@mui/material';
import { convertYYYYMMDDStringToDate } from '../../utils/utils.ts';
import type { LibraryVideoMetadata } from '../../types';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 90, flexShrink: 0 }}>{label}</Typography>
      <Typography variant="body2">{value}</Typography>
    </Stack>
  );
}

function ChipListField({ label, values }: { label: string; values: string[] }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap flexWrap="wrap">
        {values.map((value) => (
          <Chip key={value} size="small" label={value} variant="outlined" />
        ))}
      </Stack>
    </Stack>
  );
}

// yt-dlp's own per-video tags/categories (metadata.tags/metadata.categories)
// -- not to be confused with this app's own user-created "labels" system
// (videoTags/VideoTagsPopover, keyed by videoId in the sublibrary's own
// manifest, rendered elsewhere as pink chips). Different concept, different
// data source; kept visually distinct here (plain outlined chips) to avoid
// the two being conflated.
export default function ExtraDataTable({ metadata }: { metadata: LibraryVideoMetadata }) {
  const formattedUploadDate = metadata.uploadDate
    ? (convertYYYYMMDDStringToDate(metadata.uploadDate) || metadata.uploadDate)
    : null;
  const music = metadata.music;
  const hasMusicField = !!music && (music.track || music.artist || music.album || music.genre);
  const hasAnyField = !!metadata.channel || !!formattedUploadDate || !!metadata.license
    || !!(metadata.categories && metadata.categories.length > 0)
    || !!(metadata.tags && metadata.tags.length > 0)
    || hasMusicField;
  if (!hasAnyField) return null;

  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1 }}>
        Extra data
      </Typography>
      <Stack spacing={1}>
        {metadata.channel && <Field label="Uploader" value={metadata.channel} />}
        {formattedUploadDate && <Field label="Uploaded" value={formattedUploadDate} />}
        {metadata.license && <Field label="License" value={metadata.license} />}
        {metadata.categories && metadata.categories.length > 0 &&
          <ChipListField label="Categories" values={metadata.categories} />}
        {metadata.tags && metadata.tags.length > 0 &&
          <ChipListField label="Tags" values={metadata.tags} />}
        {hasMusicField &&
          <Stack spacing={0.5}>
            <Typography variant="body2" color="text.secondary">Music</Typography>
            {music.track && <Field label="Track" value={music.track} />}
            {music.artist && <Field label="Artist" value={music.artist} />}
            {music.album && <Field label="Album" value={music.album} />}
            {music.genre && <Field label="Genre" value={music.genre} />}
          </Stack>}
      </Stack>
    </>
  );
}
