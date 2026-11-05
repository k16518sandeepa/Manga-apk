import { db } from './db.js';

const z = (n) => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

const IDLE_MS = 90_000; // stop counting after 90s without any interaction

// Counts only time the reader is visible AND recently touched.
export class ReadingTimer {
  constructor(bookId, onTick) {
    this.bookId = bookId;
    this.onTick = onTick;
    this.session = 0; // seconds this session
    this.pending = 0;
    this.pendingPages = 0;
    this.last = Date.now();
    this.iv = null;
  }
  start() {
    this.last = Date.now();
    this.iv = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - this.last < IDLE_MS) {
        this.session++;
        this.pending++;
        if (this.pending >= 15) this.flush();
      }
      this.onTick?.(this.session);
    }, 1000);
  }
  poke() { this.last = Date.now(); }
  addPages(n = 1) { this.pendingPages += n; }
  async flush() {
    const sec = this.pending;
    const pages = this.pendingPages;
    if (!sec && !pages) return;
    this.pending = 0;
    this.pendingPages = 0;
    const day = dayKey();
    await db.update('days', day, (d) => {
      d = d || { day, seconds: 0, pages: 0 };
      d.seconds += sec;
      d.pages += pages;
      return d;
    });
    await db.update('books', this.bookId, (b) => {
      if (!b) return undefined;
      b.seconds = (b.seconds || 0) + sec;
      return b;
    });
  }
  async stop() {
    clearInterval(this.iv);
    await this.flush();
  }
}

export async function summary(goalMinutes = 20) {
  const [days, books] = await Promise.all([db.all('days'), db.all('books')]);
  const map = new Map(days.map((d) => [d.day, d]));
  const today = dayKey();

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const k = dayKey(dt);
    last7.push({ day: k, label: dt.toLocaleDateString(undefined, { weekday: 'short' }), seconds: map.get(k)?.seconds || 0 });
  }

  // streak: consecutive days with >= 1 minute; today may still be empty
  let streak = 0;
  const cur = new Date();
  if ((map.get(dayKey(cur))?.seconds || 0) < 60) cur.setDate(cur.getDate() - 1);
  while ((map.get(dayKey(cur))?.seconds || 0) >= 60) {
    streak++;
    cur.setDate(cur.getDate() - 1);
  }

  const totalSeconds = days.reduce((a, d) => a + d.seconds, 0);
  const totalPages = days.reduce((a, d) => a + d.pages, 0);
  const weekSeconds = last7.reduce((a, d) => a + d.seconds, 0);
  const top = [...books].filter((b) => b.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, 5);

  return {
    todaySeconds: map.get(today)?.seconds || 0,
    goalSeconds: goalMinutes * 60,
    weekSeconds,
    totalSeconds,
    totalPages,
    streak,
    finished: books.filter((b) => b.finished).length,
    last7,
    top,
  };
}
