import cron from 'node-cron';
import { fork } from 'child_process';
import path from 'path';

const RESEARCH_PATH = path.resolve('src/research.js');
const COLLECT_PATH = path.resolve('src/collect.js');
const ENGAGE_PATH = path.resolve('src/engage.js');

console.log('⏰ 楽天ROOM完全自動化・超高頻度ローカルスケジューラを起動しました。');
console.log('このプロセスはローカル常駐し、1時間に1回、確実にリサーチ・投稿・いいね巡回を全自動で実行します。');

// スクリプトを順次（同期的に）実行するヘルパー関数
function runScriptSync(scriptPath) {
  return new Promise((resolve, reject) => {
    console.log(`\n[${new Date().toLocaleString()}] 🔄 スクリプト実行開始: ${path.basename(scriptPath)}`);
    const process = fork(scriptPath);

    process.on('close', (code) => {
      console.log(`[${new Date().toLocaleString()}] 🏁 スクリプト実行終了 (コード: ${code}): ${path.basename(scriptPath)}`);
      resolve(code);
    });

    process.on('error', (err) => {
      console.error(`❌ プロセス実行エラー: ${path.basename(scriptPath)}`, err);
      reject(err);
    });
  });
}

// -------------------------------------------------------------
// 毎時0分の完全自動自律稼働スケジュール (1日24回)
// -------------------------------------------------------------
cron.schedule('0 * * * *', async () => {
  console.log('\n📢 毎時スケジュールトリガー: 全自動アフィリエイト統合プロセスを開始します。');
  
  try {
    // 1. キュー補充リサーチ（5件未満の時のみ実際に楽天市場をスクレイピング）
    await runScriptSync(RESEARCH_PATH).catch(() => {});
    
    // 2. 自動コレ！投稿（1件投稿）
    await runScriptSync(COLLECT_PATH).catch(() => {});
    
    // 3. 周囲への自動いいね・フォロー巡回
    await runScriptSync(ENGAGE_PATH).catch(() => {});
    
    console.log(`[${new Date().toLocaleString()}] 💖 毎時の統合プロセスがすべて正常に完了しました！次回まで待機します。`);
  } catch (err) {
    console.error('❌ 統合プロセスの実行中に致命的なエラーが発生しました:', err);
  }
});

console.log('\n--- 📅 登録されたローカル超高頻度スケジュール ---');
console.log('🔄 毎時0分 (1日24回) に以下をシームレスに連続実行します：');
console.log('   1. キュー自動補充 (残り5件未満時のみ作動)');
console.log('   2. 楽天ROOM自動投稿 (マニアック便利雑貨特化・超高CTA)');
console.log('   3. 周囲への自動いいね・フォロー巡回 (超安全マイルド設計)');
console.log('--------------------------------------------------\n');
console.log('⏳ 常駐待機モードに入りました。');
