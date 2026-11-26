const MODEL = process.env.ANNOTATION_TRANSLATION_MODEL || 'qwen2.5vl:3b';
const LOCAL_OLLAMA = 'http://127.0.0.1:11434/api/chat';

export interface SourceEpisode {
  item_id?: string;
  title?: string;
  lang?: string;
  duration_s?: number;
  episode_id?: string;
  tasks?: { G3?: { prelabel?: unknown; annotation?: unknown } };
}

interface AssetSegment {
  scene_mappings?: { mapping_basis?: unknown }[];
  prop_mappings?: { mapping_basis?: unknown }[];
}

function needsChinese(text: string): boolean {
  const chinese = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = text.match(/\b[A-Za-z]{2,}\b/g)?.length ?? 0;
  return englishWords > 0 && (chinese === 0 || englishWords >= 4 && englishWords > chinese);
}

export function visitAssetBasis(row: SourceEpisode, lang: string, translate: (text: string) => string): boolean {
  if (!/^(zh|cmn|yue)(?:[-_]|$)/i.test(lang)) return false;
  const task = row.tasks?.G3;
  if (!task) return false;
  let changed = false;
  for (const field of ['prelabel', 'annotation'] as const) {
    const raw = task[field];
    let value = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
      } catch {
        continue;
      }
    }
    const segments = (value as { segments?: AssetSegment[] } | null)?.segments;
    if (!Array.isArray(segments)) continue;
    let changedField = false;
    for (const segment of segments) {
      for (const list of [segment?.scene_mappings, segment?.prop_mappings]) {
        if (!Array.isArray(list)) continue;
        for (const mapping of list) {
          const text = mapping?.mapping_basis;
          if (typeof text !== 'string' || !needsChinese(text)) continue;
          const chinese = translate(text);
          if (chinese === text) continue;
          mapping.mapping_basis = chinese;
          changedField = true;
        }
      }
    }
    if (changedField && typeof raw === 'string') task[field] = JSON.stringify(value);
    changed ||= changedField;
  }
  return changed;
}

export async function translateAssetBasis(sources: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const instruction = '将影视标注依据翻译为简体中文，按原顺序输出 translations 数组。保留引用原文，不补充事实。不要省略地点等修饰语。例如 visible on the museum wall 译为“博物馆墙上可见”。';
  for (let offset = 0; offset < sources.length; offset += 8) {
    const batch = sources.slice(offset, offset + 8);
    let output: unknown;
    try {
      const response = await fetch(LOCAL_OLLAMA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          format: {
            type: 'object',
            properties: { translations: { type: 'array', items: { type: 'string' } } },
            required: ['translations'],
          },
          options: { temperature: 0, num_predict: 1024 },
          messages: [
            { role: 'system', content: instruction },
            { role: 'user', content: JSON.stringify(batch) },
          ],
        }),
      });
      if (!response.ok) throw new Error('本机翻译服务返回状态 ' + response.status);
      const payload = await response.json() as { message?: { content?: string } };
      output = (JSON.parse(payload.message?.content ?? '{}') as { translations?: unknown }).translations;
    } catch (error) {
      const reason = error instanceof Error && /返回状态/.test(error.message) ? '（' + error.message + '）' : '';
      throw new Error('无法使用本机翻译模型 ' + MODEL + '，请确认 Ollama 和模型可用后重新导入。' + reason);
    }
    if (!Array.isArray(output) || output.length !== batch.length ||
        output.some(text => typeof text !== 'string' || !/\p{Script=Han}/u.test(text) || needsChinese(text))) {
      throw new Error('本机模型未返回完整中文依据，批次未导入。请重试或检查源文件。');
    }
    for (const [index, source] of batch.entries()) result.set(source, output[index].trim());
  }
  return result;
}
