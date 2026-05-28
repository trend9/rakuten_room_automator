import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_PATH = path.resolve('storage/state.json');
const CONFIG_PATH = path.resolve('config.json');

// 設定の読み込み
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

// ランダムな待機時間を生成する関数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomSleep = async (min = config.minDelayMs, max = config.maxDelayMs) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  console.log('⏱️ 安全待機中:', ms / 1000, '秒...');
  await sleep(ms);
};

async function run() {
  console.log('🚀 自動いいね・フォロー巡回スクリプトを開始します。');

  if (!fs.existsSync(STATE_PATH)) {
    console.error('❌ セッションファイルが存在しません。先に npm run auth を実行してログインを完了してください。');
    process.exit(1);
  }

  const keywords = config.searchKeywords || ["北欧インテリア"];
  const selectedKeyword = keywords[Math.floor(Math.random() * keywords.length)];
  console.log(`🔍 今回のターゲットキーワード: 「${selectedKeyword}」`);

  // 💡 【タイムアウト対策】有頭ブラウザ（headless: false）で実行
  const browser = await chromium.launch({
    headless: false, // ボット判定を徹底回避
    channel: 'chrome' // システムのChromeを利用
  }).catch(() => chromium.launch({ headless: false }));

  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // 💡 【タイムアウト対策】画像、フォント、広告、解析トラッカーの通信をすべて遮断
  await page.route('**/*', (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();

    if (
      resourceType === 'image' || 
      resourceType === 'font' || 
      url.includes('google-analytics') || 
      url.includes('analytics.js') || 
      url.includes('doubleclick') || 
      url.includes('adsystem') || 
      url.includes('track')
    ) {
      route.abort(); // 読み込み中断
    } else {
      route.continue();
    }
  });

  try {
    const searchUrl = `https://room.rakuten.co.jp/mix/search/keyword?keyword=${encodeURIComponent(selectedKeyword)}`;
    console.log(`🌐 検索結果ページへ直接遷移します: ${searchUrl}`);
    // タイムアウトを120秒に設定
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(5000); // 描画完了待ち

    // ログイン状態の確認
    const isLoginNeeded = await page.locator('text=ログイン').count() > 0;
    if (isLoginNeeded) {
      console.warn('⚠️ セッションが適用されていない可能性があります。正常に「いいね」を行うため、事前に npm run auth を完了してください。');
    }

    // いいね（ハートボタン）の検出
    let likeButtons = page.locator('button:has(svg), button[class*="like"], button[class*="heart"]');
    let count = await likeButtons.count();

    if (count === 0) {
      likeButtons = page.locator('span[class*="like"], div[class*="like"]');
      count = await likeButtons.count();
    }

    console.log(`📊 画面上に ${count} 個のリアクション対象要素が見つかりました。`);

    let engagedCount = 0;
    const limit = config.engagementLimit || 10;

    for (let i = 0; i < count; i++) {
      if (engagedCount >= limit) {
        console.log(`🎯 今回の巡回上限（${limit}回）に達したため、処理を終了します。`);
        break;
      }

      const btn = likeButtons.nth(i);
      if (await btn.isVisible()) {
        try {
          const classAttr = await btn.getAttribute('class') || '';
          if (classAttr.includes('active') || classAttr.includes('liked')) {
            console.log(`⏭️ [${i + 1}/${count}] すでに「いいね！」済みの要素のためスキップします。`);
            continue;
          }

          await btn.scrollIntoViewIfNeeded();
          await randomSleep(1500, 3000);

          await btn.click({ force: true });
          engagedCount++;
          console.log(`❤️ [${engagedCount}/${limit}] いいね！ を送信しました。`);

          await randomSleep();

        } catch (clickErr) {
          console.warn(`⚠️ [${i + 1}] クリック処理中にスキップが発生しました:`, clickErr.message);
        }
      }
    }

    console.log(`\n🎉 巡回完了！ 合計 ${engagedCount} 件のユーザーにアクションを行いました。`);

  } catch (error) {
    console.error('❌ 巡回実行中にエラーが発生しました:', error.message);
  } finally {
    await browser.close();
    console.log('🚪 ブラウザを閉じました。巡回処理を終了します。');
  }
}

run();
