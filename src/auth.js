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

  // 💡 collect.jsと100%同一のセッション互換性を維持するため、標準のChromiumを使用します！
  const browser = await chromium.launch({
    headless: false
  });

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

  // 🔥 【超インテリジェント重複投稿禁止システム】
  // マイページから過去に自分が手動・自動問わずコレ！した全商品を検出し、履歴に自動同期します！
  console.log('\n🔄 楽天ROOMのマイページから過去の投稿（コレ！）履歴を自動同期しています...');
  try {
    const QUEUE_PATH = path.resolve('storage/queue.json');
    const loadQueue = () => {
      if (fs.existsSync(QUEUE_PATH)) {
        try { return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8')); } catch (e) { return { queue: [], history: [] }; }
      }
      return { queue: [], history: [] };
    };
    const saveQueue = (d) => fs.writeFileSync(QUEUE_PATH, JSON.stringify(d, null, 2), 'utf-8');

    // 自分のルームボタンやプロフィールリンクからマイページを探す
    const myPageSelector = 'a[href*="/room/"]';
    const myPageEl = page.locator(myPageSelector).first();
    
    if (await myPageEl.count() > 0) {
      let myPageUrl = await myPageEl.getAttribute('href');
      if (myPageUrl) {
        if (!myPageUrl.startsWith('http')) {
          myPageUrl = 'https://room.rakuten.co.jp' + myPageUrl;
        }
        const myItemsUrl = myPageUrl.endsWith('/items') ? myPageUrl : `${myPageUrl}/items`;
        console.log(`🌐 過去投稿の抽出を開始します: ${myItemsUrl}`);
        
        await page.goto(myItemsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);
        
        // 過去の投稿を掘り起こすため、下部に複数回自動スクロール
        console.log('📜 過去のコレ！履歴を読み込むために自動スクロールしています...');
        for (let i = 0; i < 6; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1200);
        }
        
        // 楽天市場へのアフィリエイトリンクをすべて抽出
        const postedUrls = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="recommend.html?url="], a[href*="item.rakuten.co.jp"]'));
          return links.map(l => {
            const href = l.href;
            if (href.includes('item.rakuten.co.jp')) {
              return href.split('?')[0].split('#')[0];
            }
            return null;
          }).filter(Boolean);
        });
        
        const uniquePostedUrls = [...new Set(postedUrls)];
        console.log(`🎯 マイページから ${uniquePostedUrls.length} 件の投稿済み商品を自動検出しました！`);
        
        const queueData = loadQueue();
        if (!queueData.history) queueData.history = [];
        let addedCount = 0;
        
        for (let url of uniquePostedUrls) {
          if (!url.endsWith('/')) url += '/';
          if (!queueData.history.includes(url)) {
            queueData.history.push(url);
            addedCount++;
          }
        }
        
        saveQueue(queueData);
        console.log(`💾 過去のコレ！重複禁止リストに新しく ${addedCount} 件を同期追加しました。`);
      }
    } else {
      console.log('💡 マイページへのリンクが見つかりませんでした。スキップします。');
    }
  } catch (e) {
    console.warn('⚠️ 履歴の自動同期中に一時エラーが発生しました（同期をスキップして終了します）:', e.message);
  }

  await browser.close();
  console.log('🚪 ブラウザを閉じました。認証セットアップ完了です！');
}

run().catch((err) => {
  console.error('❌ エラーが発生しました:', err);
});
