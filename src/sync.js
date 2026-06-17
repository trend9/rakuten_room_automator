/**
 * sync.js — ローカル queue.json の整合性を保つだけのシンプルな前処理
 *
 * ブラウザを一切使わない。
 * 以前は楽天ROOMのマイページをスクレイピングしていたが、
 * SPAの描画タイミングによって0件になるケースが頻発したため廃止。
 *
 * 処理内容:
 *  1. queue.json の status:'posted' な商品URLを全て history に追加（重複防止リスト）
 *  2. status:'failed' な商品を status:'pending' に復活
 *  3. status:'duplicate' な商品URLも history に追加（二重コレ！防止）
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const QUEUE_PATH  = path.resolve('storage/queue.json');
const CONFIG_PATH = path.resolve('config.json');

// 楽天市場の商品URLから固有の商品ID（店舗コード＋商品コード）を抽出するヘルパー
export function extractProductKey(url) {
  try {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const match = cleanUrl.match(/item\.rakuten\.co\.jp\/([^\/]+)\/([^\/]+)/);
    if (match) {
      return `${match[1]}/${match[2]}`.toLowerCase();
    }
  } catch (e) {}
  return null;
}

function loadQueue() {
  if (fs.existsSync(QUEUE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
      if (!data.queue)   data.queue   = [];
      if (!data.history) data.history = [];
      return data;
    } catch (e) {
      return { queue: [], history: [] };
    }
  }
  return { queue: [], history: [] };
}

function saveQueue(data) {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

async function run() {
  console.log('🔄 【前処理】queue.json の整合性チェックと history 同期を実行します...');

  const data = loadQueue();
  const existingKeys = new Set(data.history.map(u => extractProductKey(u)).filter(Boolean));
  const existingUrls = new Set(data.history.map(u => u.split('?')[0].replace(/\/$/, '')));

  let historyAdded  = 0;
  let failedRevived = 0;

  // 1. posted・duplicate 商品を history に追加（今後の重複防止）
  for (const p of data.queue) {
    if (p.status === 'posted' || p.status === 'duplicate') {
      const cleanUrl = p.url.split('?')[0].replace(/\/$/, '');
      const key      = extractProductKey(p.url);
      const isDup    = existingUrls.has(cleanUrl) || (key && existingKeys.has(key));

      if (!isDup) {
        const canonical = p.url.endsWith('/') ? p.url : p.url + '/';
        data.history.push(canonical);
        existingUrls.add(cleanUrl);
        if (key) existingKeys.add(key);
        historyAdded++;
        console.log(`  ✅ history に追加: ${p.title?.substring(0, 40) || p.url}`);
      }
    }
  }

  // 2. failed → pending に復活（次の実行で再挑戦できるように）
  for (const p of data.queue) {
    if (p.status === 'failed') {
      // history にある商品は duplicate として処理（復活させない）
      const cleanUrl = p.url.split('?')[0].replace(/\/$/, '');
      const key      = extractProductKey(p.url);
      const inHistory = existingUrls.has(cleanUrl) || (key && existingKeys.has(key));

      if (inHistory) {
        p.status = 'duplicate';
        console.log(`  ⏭️ history 済みのため duplicate にマーク: ${p.title?.substring(0, 40) || p.url}`);
      } else {
        p.status = 'pending';
        failedRevived++;
        console.log(`  🔄 pending に復活: ${p.title?.substring(0, 40) || p.url}`);
      }
    }
  }

  saveQueue(data);

  console.log(`\n✅ 前処理完了！`);
  console.log(`  📚 history に新規追加: ${historyAdded} 件`);
  console.log(`  🔄 failed → pending 復活: ${failedRevived} 件`);
  console.log(`  📋 現在の pending 件数: ${data.queue.filter(p => p.status === 'pending').length} 件`);
  console.log(`  📚 history 総件数: ${data.history.length} 件`);
}

// スクリプトが直接実行された場合のみ動作
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sync.js')) {
  run();
}

export { run };
