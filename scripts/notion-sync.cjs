const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const clean = s => s.normalize('NFC').replace(/\s+/gu, ' ').trim();
function section(text, name) {
  return text.match(new RegExp('^### '+name+'\\s*\\n([\\s\\S]*?)(?=^### |$(?![\\s\\S]))', 'm'))?.[1]?.trim() || '';
}
function parse(file, text, fallback) {
  const platform = file.split('/')[0];
  const prefix = { '프로그래머스': 'P', SWEA: 'S', '백준': 'B', Codetree: 'C' }[platform];
  if (!prefix) return null;
  const folder = clean(path.basename(path.dirname(file)));
  const match = folder.match(/^(\d+)\.\s*(.+)$/);
  let title;
  if (match) {
    const heading = text.match(/^# \[[^\n]+?\] (.+) - \d+\s*$/m);
    title = `${prefix}${match[1]}. ${clean(heading?.[1] || match[2])}`;
  } else if (prefix === 'C') {
    const heading = text.match(/^# \[([^\n]+)\]\((https:\/\/[^)]+)\)/m);
    if (!heading) throw new Error(`Codetree 제목 인식 실패: ${file}`);
    const slug = new URL(heading[2]).pathname.split('/').filter(Boolean).pop();
    title = `C${slug}. ${clean(heading[1])}`;
  } else return null;
  const submitted = section(text, '제출 일자');
  const dateParts = submitted.match(/(\d{4})(?:년\s*|-)(\d{1,2})(?:월\s*|-)(\d{1,2})/);
  const date = dateParts ? `${dateParts[1]}-${dateParts[2].padStart(2,'0')}-${dateParts[3].padStart(2,'0')}` : fallback;
  const performance = section(text, '성능 요약').split('\n').filter(x => /시간|메모리/.test(x)).join('\n');
  return { title, date, performance, file };
}
async function api(endpoint, method = 'GET', body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method, headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, Math.min(60000, Number(res.headers.get('retry-after') || 2) * 1000)));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message}`);
    return data;
  }
  throw new Error('Notion 요청 제한: Actions에서 재실행하세요.');
}
async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const head = process.env.GITHUB_SHA;
  let files;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    files = git('ls-files', '-z').split('\0');
  } else if (!event.before || /^0+$/.test(event.before)) {
    console.log('첫 push는 기존 문제 자동 등록을 생략합니다.'); return;
  } else {
    files = git('diff', '--name-only', '--diff-filter=AM', '-z', event.before, head).split('\0');
  }
  const problems = [];
  for (const file of files.filter(x => x.endsWith('/README.md'))) {
    const timestamp = git('log', '-1', '--format=%cI', head, '--', file);
    const fallback = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
    const p = parse(file, fs.readFileSync(file, 'utf8'), fallback);
    if (p) problems.push(p);
  }
  if (!problems.length) { console.log('등록할 문제 없음'); return; }
  if (process.env.DRY_RUN === 'true') { console.log(JSON.stringify(problems, null, 2)); return; }
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN Secret이 필요합니다.');
  let sourceId = process.env.NOTION_DATA_SOURCE_ID;
  if (!sourceId) {
    if (!process.env.NOTION_DATABASE_ID) throw new Error('NOTION_DATABASE_ID Secret이 필요합니다.');
    const db = await api(`databases/${process.env.NOTION_DATABASE_ID}`);
    if (db.data_sources?.length !== 1) throw new Error('데이터 소스가 여러 개입니다. 사용할 NOTION_DATA_SOURCE_ID Secret을 설정하세요.');
    sourceId = db.data_sources[0].id;
  }
  const schema = await api(`data_sources/${sourceId}`);
  const titleName = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title');
  if (!titleName) throw new Error('제목 속성이 없습니다.');
  const sql = process.env.CATEGORY === 'SQL';
  for (const [name, type] of [['날짜','date'], ['완료','checkbox'], ...(sql ? [['과제','select']] : [])]) {
    if (schema.properties[name]?.type !== type) throw new Error(`${name} 속성은 ${type} 타입이어야 합니다.`);
  }
  for (const p of problems) {
    const found = await api(`data_sources/${sourceId}/query`, 'POST', { filter: { property: titleName, title: { equals: p.title } }, page_size: 1 });
    if (found.results.length) { console.log(`이미 존재: ${p.title}`); continue; }
    const properties = { [titleName]: { title: [{ text: { content: p.title } }] }, '날짜': { date: { start: p.date } }, '완료': { checkbox: true } };
    if (sql) properties['과제'] = { select: { name: 'SQL' } };
    const children = !sql && p.performance ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.performance.slice(0,2000) } }] } }] : [];
    await api('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: sourceId }, properties, children });
    console.log(`생성: ${p.title} (${p.date})`);
  }
}
module.exports = { parse, section };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
