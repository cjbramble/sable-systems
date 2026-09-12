export function supportDateKey(
  value: string | null,
  timeZone?: string,
): string | null {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  const parts = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(new Date(value));
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}

export function supportDateLabel(
  value: string | null,
  now = new Date(),
  timeZone?: string,
): string {
  const key = supportDateKey(value, timeZone);
  if (!key) return 'New conversation';
  const today = supportDateKey(now.toISOString(), timeZone)!;
  if (key === today) return 'Today';
  // Calendar arithmetic, not elapsed hours, keeps DST boundaries consistent.
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (key === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeZone,
  }).format(new Date(value!));
}

export function supportTimeLabel(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}
