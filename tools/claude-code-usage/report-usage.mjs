#!/usr/bin/env node
// Claude Code の hook (Stop) から呼ばれて、トークン使用量を apps.wakalabo.net に送る。依存パッケージなし (Node 18 以上)。
//  - 会話の記録 (transcript) を読み、モデルごとの合計を出す
//  - 前回までに送った分を引いた差分だけ送る (何度呼ばれても二重に数えない)
//  - 失敗しても Claude Code の動作を止めない (常に exit 0。エラーは ~/.wakalabo-usage/error.log に残す)
// 設定: 環境変数 WAKALABO_USAGE_URL / WAKALABO_USAGE_KEY、または ~/.wakalabo-usage/config.json の { "url": "...", "key": "wk_..." }
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = process.env.WAKALABO_USAGE_DIR || join(homedir(), '.wakalabo-usage');
const MAX_SESSIONS = 200;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'requests'];

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });

/** 記録 (JSON Lines) から、モデルごとの合計を出す。同じメッセージが複数行に出るので、メッセージ id ごとに最後の行だけ数える */
export function summarizeTranscript(text) {
  const byId = new Map();
  let anon = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const m = entry?.message;
    if (entry?.type !== 'assistant' || !m?.usage) continue;
    byId.set(m.id ?? entry.uuid ?? `anon-${anon++}`, { model: m.model, usage: m.usage });
  }
  const totals = {};
  for (const { model, usage } of byId.values()) {
    if (typeof model !== 'string' || model.startsWith('<')) continue; // <synthetic> など、実際の呼び出しではないもの
    const t = (totals[model] ??= zero());
    t.input += usage.input_tokens || 0;
    t.output += usage.output_tokens || 0;
    t.cacheRead += usage.cache_read_input_tokens || 0;
    t.cacheWrite += usage.cache_creation_input_tokens || 0;
    t.requests += 1;
  }
  return totals;
}

/** 合計から送信済みを引いて、送る明細にする (マイナスは 0 にして、増えた分がなければ送らない) */
export function toEntries(totals, sent) {
  const entries = [];
  for (const [model, t] of Object.entries(totals)) {
    const s = sent[model] ?? zero();
    const d = Object.fromEntries(FIELDS.map((f) => [f, Math.max(0, t[f] - (s[f] || 0))]));
    if (FIELDS.every((f) => d[f] === 0)) continue;
    entries.push({ source: 'claude-code', model, ...d });
  }
  return entries;
}

function log(message) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(join(DIR, 'error.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ログも書けないときは何もしない */
  }
}

function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const hook = JSON.parse((await readStdin()) || '{}');
  const config = readJson(join(DIR, 'config.json'), {});
  const url = process.env.WAKALABO_USAGE_URL || config.url;
  const key = process.env.WAKALABO_USAGE_KEY || config.key;
  if (!url || !key) return log('設定がありません (WAKALABO_USAGE_URL / WAKALABO_USAGE_KEY または config.json)');
  if (!hook.session_id || !hook.transcript_path || !existsSync(hook.transcript_path)) return;

  const totals = summarizeTranscript(readFileSync(hook.transcript_path, 'utf8'));
  const statePath = join(DIR, 'state.json');
  const state = readJson(statePath, { sessions: {} });
  const entries = toEntries(totals, state.sessions[hook.session_id] ?? {});
  if (entries.length === 0) return;

  const res = await fetch(`${url.replace(/\/$/, '')}/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wakalabo-key': key },
    body: JSON.stringify({ entries }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return log(`送信に失敗しました (${res.status})`);

  // 送れたら、ここまでを送信済みにする (失敗したときは次回にまとめて送る)
  state.sessions[hook.session_id] = totals;
  const ids = Object.keys(state.sessions);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete state.sessions[id];
  mkdirSync(DIR, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => log(String(e?.stack || e))).finally(() => process.exit(0));
}
