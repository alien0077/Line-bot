import { config } from '../config.js';

export function isoNow(): string {
  return new Date().toISOString();
}

export function formatDateFolder(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function startOfToday(): number {
  const now = new Date();
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  return new Date(`${local}T00:00:00+08:00`).getTime();
}

export function startOfLast7Days(): number {
  return Date.now() - 7 * 24 * 60 * 60 * 1000;
}
