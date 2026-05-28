import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const STATE_PATH = path.resolve('storage/state.json');

// storage ディレクトリがない場合は作成
const dir = path.dirname(STATE_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function run() {
  console.log('🔑 楽天ROOM 手動ログイン＆セッション保存スクリプトを起動します。');
  console.log('有頭ブラウザが起動します。楽天アカウントでログインを完了してください。');

  // ブラウザを有頭（headless: false）で起動
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // 可能ならシステム上のChromeを使う（ロボット検知を避けるため）
  }).catch(() => chromium.launch({ headless: false })); // エラー時はデフォルトChromium

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // 楽天ROOMのトップページへ遷移
  console.log('🌐 楽天ROOMのトップページを開いています...');
  await page.goto('https://room.rakuten.co.jp/', { waitUntil: 'domcontentloaded' });

  // ログインボタンが表示されていれば自動で押す、またはユーザーの入力を促す
  console.log('\n👉 ブラウザ上でログイン操作を行ってください。');
  console.log('ログインが完了し、マイページやフィードが表示されたら、ターミナルに戻って Enter キーを押してください。');

  // ユーザーがEnterキーを押すのを待機
  await askQuestion('▶️ ログインが完了したら、ここにEnterキーを押して進めてください: ');

  // セッション状態を保存
  console.log('💾 セッション情報を保存しています...');
  await context.storageState({ path: STATE_PATH });
  console.log(`✅ セッション情報が正常に保存されました！: ${STATE_PATH}`);

  await browser.close();
  console.log('🚪 ブラウザを閉じました。認証セットアップ完了です！');
}

run().catch((err) => {
  console.error('❌ エラーが発生しました:', err);
});
