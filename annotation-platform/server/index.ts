import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR, HOST, INCOMING_DIR, PORT, RESULTS_DIR, ROOT } from './config.ts';
import { getDb } from './db.ts';
import { hashPassword } from './auth.ts';
import { authRouter } from './routes/auth.routes.ts';
import { adminRouter } from './routes/admin.routes.ts';
import { annotatorRouter } from './routes/annotator.routes.ts';

import { reviewRouter } from './routes/review.routes.ts';

const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'vendor');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100mb' }));

// Static: vendored annotation pages under /annotate/<task>.html, portal under /.
app.use('/annotate', express.static(VENDOR_DIR));
app.use(express.static(PUBLIC_DIR));

// ---------- API ----------

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, name: 'annotation-platform', time: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/annotator', annotatorRouter);
app.use('/api/reviews', reviewRouter);

// Fallback for unknown API paths.
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: '未找到接口' });
});

// JSON error handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: '服务器内部错误' });
});

// ---------- seed admin ----------

function seedAdmin(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count === 0) {
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare(
      "INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES ('admin', ?, '管理员', 'admin', ?)",
    ).run(hashPassword(password), new Date().toISOString());
    console.log('');
    console.log('  [annotation-platform] 已创建初始管理员账号：');
    console.log(`      用户名: admin   密码: ${password}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('      提示：默认密码 admin123，请登录后尽快修改（可用环境变量 ADMIN_PASSWORD 覆盖）。');
    }
    console.log('');
  }
}

fs.mkdirSync(INCOMING_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });
seedAdmin();

app.listen(PORT, HOST, (error?: Error) => {
  if (error) {
    console.error(`[annotation-platform] 启动失败：${error.message}`);
    process.exitCode = 1;
    return;
  }
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  console.log(`[annotation-platform] 已启动：${url}`);
  console.log(`  门户入口：        ${url}/`);
  console.log(`  标注页（人物）：  ${url}/annotate/people.html`);
  console.log(`  数据目录：        ${DATA_DIR}`);
});
