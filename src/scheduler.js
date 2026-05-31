import cron from 'node-cron';
import { fork } from 'child_process';
import path from 'path';

const SYNC_PATH = path.resolve('src/sync.js');
const RESEARCH_PATH = path.resolve('src/research.js');
const COLLECT_PATH = path.resolve('src/collect.js');
const ENGAGE_PATH = path.resolve('src/engage.js');

console.log('⏰ 楽天ROOM完全自動化・超高頻度ローカルスケジューラを起動しました。');
console.log('このプロセスはローカル常駐し、全自動でリサーチ・投稿・いいね巡回を実行します。');

// スクリプトを順次（同期的に）実行するヘルパー関数
function runScriptSync(scriptPath) {
  return new Promise((resolve, reject) => {
    const projectRoot = path.dirname(path.dirname(path.resolve(scriptPath)));
    console.log(`\n[${new Date().toLocaleString()}] 🔄 スクリプト実行開始: ${path.basename(scriptPath)} (CWD: ${projectRoot})`);
    
    // 🔥 cwdをプロジェクトルートに完全固定してパスのズレを防ぐ
    const process = fork(scriptPath, [], { cwd: projectRoot });

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

// 毎時のプロセス実行回数をカウントする変数
let hourCounter = 0;

// 全自動統合プロセスの中身
async function runIntegratedProcess() {
  console.log('\n📢 全自動アフィリエイト統合プロセスを開始します。');
  
  try {
    // 0. 楽天ROOMの最新投稿履歴を自動同期（重複を100%防止）
    await runScriptSync(SYNC_PATH).catch(() => {});

    // 1. キュー補充リサーチ（5件未満の時のみ実際に楽天市場をスクレイピング）
    await runScriptSync(RESEARCH_PATH).catch(() => {});
    
    // 2. 自動コレ！投稿（毎時1件投稿）
    await runScriptSync(COLLECT_PATH).catch(() => {});
    
    // 3. 周囲への自動いいね・フォロー巡回（3時間に1回実行＝3回に1回の頻度に制限して安全運用！）
    if (hourCounter % 3 === 0) {
      console.log('💖 3時間周期のタイミングです。自動いいね・フォロー巡回を実行します。');
      await runScriptSync(ENGAGE_PATH).catch(() => {});
    } else {
      console.log(`💡 今回はいいね巡回をスキップします（次回実行まであと ${3 - (hourCounter % 3)} 時間）`);
    }
    
    // カウンターを進める
    hourCounter++;
    
    console.log(`[${new Date().toLocaleString()}] 💖 毎時の統合プロセスが正常に完了しました。次回まで待機します。`);
  } catch (err) {
    console.error('❌ 統合プロセスの実行中に致命的なエラーが発生しました:', err);
  }
}

// 🚀 【起動時の即時実行】待ち時間での「時間の無駄」を完全にゼロにし、即座に投稿を開始します！
(async () => {
  console.log('\n🚀 スケジューラー起動に伴い、初回の統合プロセスを即時（ウェイトなし）で実行します...');
  await runIntegratedProcess();
})();

// -------------------------------------------------------------
// 毎時0分の完全自動自律稼働スケジュール (1日24回)
// -------------------------------------------------------------
cron.schedule('0 * * * *', async () => {
  console.log('\n📢 毎時スケジュールトリガーが発火しました。');
  await runIntegratedProcess();
});

console.log('\n--- 📅 登録されたローカル超高頻度スケジュール ---');
console.log('🔄 毎時0分 (1日24回) に以下をシームレスに連続実行します：');
console.log('   1. キュー自動補充 (残り5件未満時のみ作動)');
console.log('   2. 楽天ROOM自動投稿 (毎時1回・マニアック便利雑貨特化・超高CTA)');
console.log('   3. 周囲への自動いいね・フォロー巡回 (★3時間に1回の超安全マイルド設計)');
console.log('--------------------------------------------------\n');
console.log('⏳ 常駐待機モードに入りました。このターミナルを開いたまま最小化しておいてください。');
