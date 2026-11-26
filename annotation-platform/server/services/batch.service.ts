import fs from 'node:fs';
import path from 'node:path';
import { getDb, transaction } from '../db.ts';
import { INCOMING_DIR, MODE_FILE, type Mode, type TaskKey } from '../config.ts';
import { translateAssetBasis, visitAssetBasis, type SourceEpisode } from './asset-basis.service.ts';

export interface ManifestItem {
  item_id: string;
  episode_id: string;
  lang: string;
  duration_s: number;
  second_review: boolean;
}

export interface Manifest {
  id: string;
  tool_version?: string;
  items: ManifestItem[];
  files?: Record<string, { records: number }>;
}

export function batchDir(batchId: string): string {
  return path.join(INCOMING_DIR, batchId);
}

/** List importable batch folders under data/incoming. */
export function listIncoming(): Array<{
  dir: string;
  hasManifest: boolean;
  hasPrimary: boolean;
  hasOverlap: boolean;
  imported: boolean;
}> {
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  const rows = getDb().prepare('SELECT batch_id FROM batches').all() as Array<{ batch_id: string }>;
  const imported = new Set(rows.map((r) => r.batch_id));
  return fs
    .readdirSync(INCOMING_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(INCOMING_DIR, e.name);
      const has = (f: string) => fs.existsSync(path.join(dir, f));
      return {
        dir: e.name,
        hasManifest: has('manifest.json'),
        hasPrimary: has(MODE_FILE.primary),
        hasOverlap: has(MODE_FILE.overlap),
        imported: imported.has(e.name),
      };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function readManifest(batchId: string): Manifest {
  const raw = fs.readFileSync(path.join(batchDir(batchId), 'manifest.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/** Read item metadata (title etc.) from a JSONL source file into a map. */
function readItemMeta(file: string, inspect: (row: SourceEpisode) => void): Map<string, { title: string; lang: string; duration_s: number; episode_id: string }> {
  const out = new Map<string, { title: string; lang: string; duration_s: number; episode_id: string }>();
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as SourceEpisode;
      inspect(rec);
      if (rec.item_id) {
        out.set(rec.item_id, {
          title: rec.title ?? '',
          lang: rec.lang ?? '',
          duration_s: rec.duration_s ?? 0,
          episode_id: rec.episode_id ?? '',
        });
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export async function importBatch(dirName: string): Promise<{ batchId: string; items: number; translated: number }> {
  if (typeof dirName !== 'string' || !/^[\w.\-]+$/.test(dirName) || dirName === '.' || dirName === '..') throw new Error('非法的批次目录名');
  const dir = batchDir(dirName);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('缺少 manifest.json');
  if (!fs.existsSync(path.join(dir, MODE_FILE.primary))) throw new Error('缺少 primary.jsonl');

  const manifest = readManifest(dirName);
  const batchId = manifest.id;
  if (batchId !== dirName) throw new Error('批次目录名需与清单中的批次编号一致');
  const existing = getDb().prepare('SELECT id FROM batches WHERE batch_id = ?').get(batchId);
  if (existing) throw new Error(`批次 ${batchId} 已导入`);

  const meta = new Map<string, { title: string; lang: string; duration_s: number; episode_id: string }>();
  const langs = new Map(manifest.items.map(item => [item.item_id, item.lang]));
  const english = new Set<string>();
  for (const f of [MODE_FILE.primary, MODE_FILE.overlap]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const rows = readItemMeta(p, row => {
      // FS-P001 is already localized in the editor for compatibility with its existing drafts.
      if (batchId === 'FS-P001') return;
      visitAssetBasis(row, langs.get(row.item_id ?? '') || row.lang || '', text => {
        english.add(text);
        return text;
      });
    });
    for (const [itemId, info] of rows) meta.set(itemId, info);
  }
  const translations = await translateAssetBasis([...english]);

  return transaction(db => {
    if (db.prepare('SELECT 1 FROM batches WHERE batch_id = ?').get(batchId)) throw new Error(`批次 ${batchId} 已导入`);
    db.prepare(
      'INSERT INTO batches (batch_id, tool_version, manifest, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(batchId, manifest.tool_version ?? null, JSON.stringify(manifest), 'imported', new Date().toISOString());

    const insert = db.prepare(
      'INSERT INTO batch_items (batch_id, item_id, title, lang, duration_s, episode_id, second_review) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const item of manifest.items) {
      const m = meta.get(item.item_id);
      insert.run(
        batchId, item.item_id, m?.title ?? '', item.lang || m?.lang || '',
        m?.duration_s ?? item.duration_s ?? 0, m?.episode_id ?? item.episode_id ?? '',
        item.second_review ? 1 : 0,
      );
    }

    const insertTranslation = db.prepare('INSERT INTO batch_asset_basis (batch_id, source, translation) VALUES (?, ?, ?)');
    for (const [source, chinese] of translations) insertTranslation.run(batchId, source, chinese);
    return { batchId, items: manifest.items.length, translated: translations.size };
  });
}

/** Build a JSONL slice containing only the given item_ids from a mode's source file. */
export function buildSlice(batchId: string, mode: Mode, itemIds: Set<string>, task: TaskKey, order = new Map<string, number>()): string {
  const file = path.join(batchDir(batchId), MODE_FILE[mode]);
  if (!fs.existsSync(file)) throw new Error(`找不到数据文件 ${MODE_FILE[mode]}`);
  const text = fs.readFileSync(file, 'utf8');
  const out: { text: string; priority: number }[] = [];
  const localize = task === 'assets' && batchId !== 'FS-P001';
  const db = getDb();
  const translationRows = localize ? db.prepare('SELECT source, translation FROM batch_asset_basis WHERE batch_id = ?').all(batchId) : [];
  const phrases = new Map(translationRows.map(row => [row.source, row.translation as string]));
  const languageRows = localize ? db.prepare('SELECT item_id, lang FROM batch_items WHERE batch_id = ?').all(batchId) : [];
  const langs = new Map(languageRows.map(row => [row.item_id, row.lang as string]));
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row: SourceEpisode;
    try {
      row = JSON.parse(t) as SourceEpisode;
    } catch {
      continue;
    }
    if (!row?.item_id || !itemIds.has(row.item_id)) continue;
    const changed = localize && visitAssetBasis(row, langs.get(row.item_id) || row.lang || '', source => {
      const chinese = phrases.get(source);
      if (!chinese) throw new Error('此批次有未经翻译的新依据，请联系管理员检查批次源文件。');
      return chinese;
    });
    out.push({ text: changed ? JSON.stringify(row) : t, priority: order.get(row.item_id) ?? 0 });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out.map(row => row.text).join('\n') + (out.length ? '\n' : '');
}

export function listBatches(): Array<{
  id: number;
  batch_id: string;
  tool_version: string | null;
  status: string;
  created_at: string;
  items: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.batch_id) AS items
       FROM batches b ORDER BY b.id DESC`,
    )
    .all() as Array<{ id: number; batch_id: string; tool_version: string | null; status: string; created_at: string; items: number }>;
  return rows;
}
