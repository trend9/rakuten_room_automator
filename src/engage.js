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

  // 💡 【GitHub Actions対策】クラウドでは自動で headless: true、ローカルでは headless: false に切り替えます
  const isCI = process.env.GITHUB_ACTIONS === 'true';
  console.log(`🤖 稼働環境: ${isCI ? 'GitHub Actions (クラウド自動運転)' : 'ローカル PC'}`);

  const browser = await chromium.launch({
    headless: isCI ? true : false
  });

  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // 💡 【タイムアウト対策】広告やトラッカーのみを遮断し、UI表示を正常に保ちます
  await page.route('**/*', (route) => {
    const request = route.request();
    const url = request.url();

    if (
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
    // タイムアウトを120秒に設定し、SPAの非同期読み込みを確実に待ちます
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 120000 }).catch(() => {});
    
    console.log('📜 リストを読み込むために画面をスクロール中...');
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(5000); // 描画完了・非同期ロード待ち

    // デバッグ用のスクリーンショット
    const dir = path.resolve('storage/steps');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'step_engage_loaded.png') }).catch(() => {});

    // ログイン状態の確認
    const isLoginNeeded = await page.locator('text=ログイン, input[placeholder*="メール"]').count() > 0;
    if (isLoginNeeded) {
      console.warn('⚠️ セッションが適用されていない可能性があります。正常に「いいね」を行うため、事前に npm run auth を完了してください。');
    }

    // いいね（ハートボタン）の検出
    // 楽天ROOMの様々な「いいね」ボタンやハートアイコンのDOM構造を強力に網羅
    let likeButtons = page.locator([
      'button:has(svg)',
      'button[class*="like"]',
      'button[class*="heart"]',
      '[class*="like-button"]',
      '[class*="LikeButton"]',
      '[class*="heart-icon"]',
      'span[class*="like"]',
      'div[class*="like"]',
      'i[class*="heart"]',
      'button:has-text("いいね")',
      'button:has-text("コレ！")'
    ].join(','));
    
    let count = await likeButtons.count();

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
