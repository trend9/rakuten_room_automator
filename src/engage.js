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

  try {
    // 💡 【超重要】ドメインをまたぐクロスドメイン認証クッキー（SameSite/ITP規制）を完全にアクティブ化させるため、
    // まず楽天市場のトップページへ直接アクセスします。
    console.log('🌐 楽天市場のトップページにアクセスしています（セッション活性化のため）...');
    await page.goto('https://www.rakuten.co.jp/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const searchUrl = 'https://room.rakuten.co.jp/';
    console.log(`🔗 楽天市場のページ内にROOMトップへの偽装リンクを動的生成してクリック遷移します:\n👉 ${searchUrl}`);
    
    // ページ内にAタグを動的に作成してクリックする
    await page.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.id = 'dummy-room-search-link';
      a.style.display = 'block';
      a.style.position = 'fixed';
      a.style.top = '10px';
      a.style.left = '10px';
      a.style.zIndex = '99999';
      a.innerText = 'Go to ROOM Search';
      document.body.appendChild(a);
    }, searchUrl);

    // 作成したAタグをクリックして、別タブではなく現在のタブで遷移させる
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      page.locator('#dummy-room-search-link').click()
    ]);
    
    console.log('🌐 検索結果ページへのリンククリック遷移に成功しました！');
    
    // 💡 投稿カードがフィード上にロードされるのを確実に待ちます（最大15秒）
    console.log('⏳ フィードコンテンツの読み込みを待っています...');
    await page.waitForSelector('[class*="item"], [class*="Item"], [class*="post"], [class*="Post"], [class*="card"], [class*="Card"]', { timeout: 15000 }).catch(() => {
      console.log('⚠️ 投稿カードの検出タイムアウト。スクロールを開始します。');
    });

    console.log('📜 リストを読み込むために画面をスクロール中...');
    // 複数回スクロールを行い、Ajaxロードを強力に促進します
    for (let s = 0; s < 3; s++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2500);
    }
    
    // デバッグ用のスクリーンショット保存先作成
    const dir = path.resolve('storage/steps');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 最新状態をデバッグ用スクリーンショットに保存
    await page.screenshot({ path: path.join(dir, 'step_engage_loaded.png') }).catch(() => {});

    // ログイン状態の確認
    const isLoginNeeded = await page.locator('text=ログイン, input[placeholder*="メール"]').count() > 0;
    if (isLoginNeeded) {
      console.warn('⚠️ セッションが適用されていない可能性があります。正常に「いいね」を行うため、事前に npm run auth を完了してください。');
    }

    // いいね（ハートボタン）の検出
    // 画面上の「いいね」テキストを持つクリック可能なすべての要素（button, div, span等）を極めて正確に補足します
    let likeButtons = page.locator('button, div, span, a').filter({ hasText: /^いいね$/ }).or(
      page.locator('[class*="like" i], [class*="heart" i]').filter({ hasText: 'いいね' })
    ).or(
      page.locator('button:has-text("いいね")')
    );
    
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
