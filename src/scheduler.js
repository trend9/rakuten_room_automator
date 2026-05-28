import cron from 'node-cron';
import { fork } from 'child_process';
import path from 'path';

const RESEARCH_PATH = path.resolve('src/research.js');
const COLLECT_PATH = path.resolve('src/collect.js');
const ENGAGE_PATH = path.resolve('src/engage.js');

console.log('⏰ 楽天ROOM完全自動化スケジューラを起動しました。');
console.log('このプロセスは常駐して指定時間にリサーチ、投稿、巡回をすべて全自動で実行します。');

// 子プロセスを安全に起動するヘルパー関数
function runScript(scriptPath) {
  console.log(`\n[${new Date().toLocaleString()}] 🔄 スクリプト実行開始: ${path.basename(scriptPath)}`);
  const process = fork(scriptPath);

  process.on('close', (code) => {
    console.log(`[${new Date().toLocaleString()}] 🏁 スクリプト実行終了 (終了コード: ${code}): ${path.basename(scriptPath)}`);
  });

  process.on('error', (err) => {
    console.error(`❌ プロセス実行エラー: ${path.basename(scriptPath)}`, err);
  });
}

// -------------------------------------------------------------
// 完全自動化スケジュール設定
// -------------------------------------------------------------

// 1. 自動リサーチ（トレンド商品自動収集）
// 毎日 朝 06:00 に楽天市場からその日のトレンド商品を自動で10件リサーチしてキューに補充
cron.schedule('0 6 * * *', () => {
  console.log('📢 スケジュールトリガー: トレンド商品の自動リサーチを開始します。');
  runScript(RESEARCH_PATH);
});

// 2. 自動投稿（コレ！）
// 毎日 朝 08:00 と 夜 20:00 (1日2回) にキューから自動で1件投稿
cron.schedule('0 8,20 * * *', () => {
  console.log('📢 スケジュールトリガー: 自動投稿の実行時間になりました。');
  runScript(COLLECT_PATH);
});

// 3. 自動いいね・フォロー巡回
// 毎日 7:00 から 23:00 までの間、1時間ごとに実行（深夜帯は避けて安全運用）
cron.schedule('0 7-23/1 * * *', () => {
  console.log('📢 スケジュールトリガー: 自動いいね・フォロー巡回の時間になりました。');
  runScript(ENGAGE_PATH);
});

console.log('\n--- 📅 登録された全自動スケジュール ---');
console.log('🔍 自動トレンドリサーチ : 毎日 06:00');
console.log('📢 トレンド商品自動投稿 : 毎日 08:00, 20:00 (1日2回)');
console.log('❤️ いいね・フォロー巡回 : 毎日 07:00〜23:00 の間、毎正時 (1時間ごと)');
console.log('------------------------------------\n');
console.log('⏳ 常駐待機モードに入りました。このままターミナルを開いておいてください...');
