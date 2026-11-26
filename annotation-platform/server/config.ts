import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root (parent of server/). */
export const ROOT = path.resolve(here, '..');

export const PORT = Number(process.env.PORT || 3210);
export const HOST = process.env.HOST || '127.0.0.1';

/** Runtime data directory: sqlite db, incoming batches, uploaded results. */
export const DATA_DIR = process.env.ANNOTATION_DATA_DIR || path.join(ROOT, 'data');

/** Drop a batch folder here (manifest.json + primary.jsonl + overlap.jsonl) then import from the admin panel. */
export const INCOMING_DIR = path.join(DATA_DIR, 'incoming');

/** Uploaded result files (JSON) and timing CSVs are stored here, keyed by result id. */
export const RESULTS_DIR = path.join(DATA_DIR, 'results');

export const DB_PATH = path.join(DATA_DIR, 'platform.sqlite');

export const SESSION_COOKIE = 'dap_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** The four split tasks and their vendored annotation pages. */
export const TASKS = {
  people: { key: 'people', splitTask: 'A', page: 'people.html', title: '人物与对白' },
  assets: { key: 'assets', splitTask: 'B', page: 'assets.html', title: '场景道具' },
  shots: { key: 'shots', splitTask: 'C', page: 'shots.html', title: '镜头' },
  story: { key: 'story', splitTask: 'S', page: 'story.html', title: '剧情' },
} as const;

export type TaskKey = keyof typeof TASKS;
export const TASK_KEYS = Object.keys(TASKS) as TaskKey[];

export const MODES = ['primary', 'overlap'] as const;
export type Mode = (typeof MODES)[number];

/** Source file in a batch folder for each mode. */
export const MODE_FILE: Record<Mode, string> = {
  primary: 'primary.jsonl',
  overlap: 'overlap.jsonl',
};
