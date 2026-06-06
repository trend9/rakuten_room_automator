import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_PATH = path.resolve('storage/state.json');
const CONFIG_PATH = path.resolve('config.json');
const QUEUE_PATH = path.resolve('storage/queue.json');

// 設定の読み込み
const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  : { minDelayMs: 2000, maxDelayMs: 5000 };

// キューデータの読み込み
function loadQueue() {
  if (fs.existsSync(QUEUE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
      if (!data.queue) data.queue = [];
      if (!data.history) data.history = [];
      return data;
    } catch (e) {
      return { queue: [], history: [] };
    }
  }
  return { queue: [], history: [] };
}

// キューデータの保存
function saveQueue(data) {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// 楽天市場の商品URLから固有の商品ID（店舗コード＋商品コード）を抽出するヘルパー
export function extractProductKey(url) {
  try {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const match = cleanUrl.match(/item\.rakuten\.co\.jp\/([^\/]+)\/([^\/]+)/);
    if (match) {
      return `${match[1]}/${match[2]}`.toLowerCase();
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// マイページの全カードをスクロールで完全に描画させるヘルパー
async function ensureAllCardsLoaded(page) {
  // 段階的にスクロールして、React仮想DOMの遅延ロードを全て発火させる
  const scrollSteps = 6;
  for (let s = 1; s <= scrollSteps; s++) {
    const ratio = s / scrollSteps;
    await page.evaluate((r) => window.scrollTo(0, document.body.scrollHeight * r), ratio);
    await page.waitForTimeout(1500);
  }
  // 「さらに読み込む」ボタンがあればクリック
  const loadMoreBtn = page.locator('text=さらに読み込む');
  if (await loadMoreBtn.count() > 0 && await loadMoreBtn.first().isVisible()) {
    console.log('📥 「さらに読み込む」をクリックして追加カードをロード中...');
    await loadMoreBtn.first().click();
    await page.waitForTimeout(5000);
  }
  // 最上部に戻してからもう一度最下部へ（全カードのReactハンドラーを確実にアタッチ）
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
}

async function run() {
  console.log('🔄 【全自動同期】楽天ROOMから最近の投稿履歴を取得し、重複禁止リストにマージします...');

  if (!fs.existsSync(STATE_PATH)) {
    console.error('❌ セッションファイル（storage/state.json）が存在しません。先に npm run auth を実行してログインを完了してください。');
    process.exit(1);
  }

  const isCI = process.env.GITHUB_ACTIONS === 'true';

  let browser;
  if (isCI) {
    browser = await chromium.launch({ headless: true });
  } else {
    browser = await chromium.launch({ headless: false, channel: 'chrome' })
      .catch(() => chromium.launch({ headless: false }));
  }

  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    const myItemsUrl = 'https://room.rakuten.co.jp/jack555/items';
    console.log(`🌐 マイページ商品一覧へ直接アクセスします: ${myItemsUrl}`);
    await page.goto(myItemsUrl, { waitUntil: 'commit', timeout: 45000 });

    console.log('⏳ ページの描画安定を待機中（10秒）...');
    await page.waitForTimeout(10000);

    // 全カードをスクロールで描画
    console.log('📜 マイページをスクロールして全商品カードをロード中...');
    await ensureAllCardsLoaded(page);

    const cardSelector = 'a.link-image--2kguM';
    const cardCount = await page.locator(cardSelector).count();
    console.log(`📋 マイページ上に ${cardCount} 件の商品カードを検出しました。`);

    if (cardCount === 0) {
      console.log('⚠️ 商品カードが0件です。デバッグ用スクリーンショットを保存します。');
      await page.screenshot({ path: 'storage/error_sync_0cards.png' }).catch(() => {});
      await browser.close();
      console.log('🚪 自動同期セッションを終了しました。');
      return;
    }

    const uniqueUrls = [];
    const maxSyncCount = Math.min(cardCount, 15);

    for (let i = 0; i < maxSyncCount; i++) {
      try {
        console.log(`🔎 [${i + 1}/${maxSyncCount}] 商品詳細をロード中...`);

        // Playwright locator.click() でSPA遷移を発火（テスト検証済み）
        let navigated = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const card = page.locator(cardSelector).nth(i);
            await card.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(1000);
            await card.click({ timeout: 8000 });
          } catch (err) {
            if (err.message.includes('context was destroyed') || err.message.includes('navigation')) {
              console.log('   ⚡ SPA遷移を検知しました。');
              navigated = true;
              await page.waitForTimeout(6000);
              break;
            }
          }

          await page.waitForTimeout(6000);

          if (!page.url().endsWith('/items')) {
            navigated = true;
            break;
          }

          console.log(`   ⏳ 遷移待ち（試行 ${attempt}/3）...`);
          // スクロールして描画を促進してから再クリック
          await page.evaluate((idx) => {
            const cards = document.querySelectorAll('a.link-image--2kguM');
            if (cards[idx]) cards[idx].scrollIntoView({ block: 'center' });
          }, i).catch(() => {});
          await page.waitForTimeout(2000);
        }

        if (!navigated || page.url().endsWith('/items')) {
          console.log(`   ⚠️ カード [${i + 1}] の詳細ページへの遷移に失敗。スキップします。`);
          continue;
        }

        // 詳細ページから楽天市場URLを抽出（3回リトライ）
        let foundUrl = null;
        for (let r = 0; r < 3; r++) {
          try {
            foundUrl = await page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a')).map(a => a.href).filter(Boolean);
              // 優先度1: item.rakuten.co.jp の直接リンク
              for (const href of links) {
                if (href.includes('item.rakuten.co.jp')) {
                  return href.split('?')[0].split('#')[0];
                }
              }
              // 優先度2: recommend URL内のitem URL
              for (const href of links) {
                if (href.includes('recommend.html?url=')) {
                  try {
                    const urlParam = new URL(href).searchParams.get('url');
                    if (urlParam && urlParam.includes('item.rakuten.co.jp')) {
                      return urlParam.split('?')[0].split('#')[0];
                    }
                  } catch (e) {}
                }
              }
              // 優先度3: pc=パラメータ付きアフィリエイトから復元
              for (const href of links) {
                if (href.includes('afl.rakuten.co.jp') && href.includes('pc=')) {
                  try {
                    const urlParam = new URL(href).searchParams.get('pc');
                    if (urlParam && urlParam.includes('item.rakuten.co.jp')) {
                      return decodeURIComponent(urlParam).split('?')[0].split('#')[0];
                    }
                  } catch (e) {}
                }
              }
              // 優先度4: アフィリエイトURL（最終フォールバック）
              for (const href of links) {
                if (href.includes('afl.rakuten.co.jp')) {
                  return href;
                }
              }
              return null;
            });
            if (foundUrl) break;
          } catch (e) {
            await page.waitForTimeout(1500);
          }
        }

        if (foundUrl) {
          let cleanUrl = foundUrl;

          // アフィリエイトURLのリダイレクト解決（item.rakuten.co.jpを取得）
          if (cleanUrl.includes('afl.rakuten.co.jp') && !cleanUrl.includes('item.rakuten.co.jp')) {
            console.log('   🔗 アフィリエイトURLをitem.rakuten.co.jpへ解決中...');
            try {
              const tempPage = await context.newPage();
              // requestイベントでリダイレクト先を監視
              let resolvedItemUrl = null;
              tempPage.on('request', (req) => {
                const reqUrl = req.url();
                if (reqUrl.includes('item.rakuten.co.jp')) {
                  resolvedItemUrl = reqUrl.split('?')[0].split('#')[0];
                }
              });
              await tempPage.goto(cleanUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
              // 最大10秒待ってリダイレクト先を検出
              for (let j = 0; j < 10; j++) {
                if (resolvedItemUrl) break;
                if (tempPage.url().includes('item.rakuten.co.jp')) {
                  resolvedItemUrl = tempPage.url().split('?')[0].split('#')[0];
                  break;
                }
                await tempPage.waitForTimeout(1000);
              }
              if (resolvedItemUrl) {
                console.log(`   🎯 解決成功: ${resolvedItemUrl}`);
                cleanUrl = resolvedItemUrl;
              } else {
                console.log(`   ⚠️ リダイレクト解決タイムアウト。アフィリエイトURLのまま保存します。`);
              }
              await tempPage.close().catch(() => {});
            } catch (e) {
              console.log(`   ⚠️ リダイレクト解決エラー: ${e.message}`);
            }
          }

          if (!cleanUrl.endsWith('/')) cleanUrl += '/';
          console.log(`   ✅ 同期成功 [${i + 1}]: ${cleanUrl}`);
          uniqueUrls.push(cleanUrl);
        } else {
          console.log(`   ⚠️ カード [${i + 1}] からURLを抽出できませんでした。`);
        }

        // マイページに戻る（goBack → 失敗なら直接遷移）
        console.log('   🔙 マイページに戻ります...');
        try {
          await page.goBack({ waitUntil: 'commit', timeout: 10000 });
          await page.waitForTimeout(3000);
        } catch (e) {
          // goBack失敗
        }

        if (!page.url().includes('/items')) {
          console.log('   🔄 直接遷移でリカバリします...');
          await page.goto(myItemsUrl, { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(8000);
          // リカバリ後は全カードを再描画する
          await ensureAllCardsLoaded(page);
        }

      } catch (cardErr) {
        console.warn(`   ⚠️ カード [${i + 1}] の処理エラー: ${cardErr.message}`);
        console.log('   🔄 マイページへ再アクセスしてリカバリします...');
        await page.goto(myItemsUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(8000);
        await ensureAllCardsLoaded(page);
      }
    }

    console.log(`🎯 スキャン完了！合計 ${uniqueUrls.length} 件の投稿済み楽天市場商品を同期しました。`);

    if (uniqueUrls.length === 0) {
      console.log('⚠️ 同期された商品URLが0件です。デバッグ用スクリーンショットを保存します。');
      await page.screenshot({ path: 'storage/error_sync_0cards.png' }).catch(() => {});
    }

    if (uniqueUrls.length > 0) {
      const data = loadQueue();
      let addedCount = 0;

      // 既存の履歴URLをセットに変換（完全一致チェック用）
      const existingUrlSet = new Set(data.history.map(url => url.split('?')[0].split('#')[0].replace(/\/$/, '')));
      // 既存の商品キーをセットに変換（商品ID一致チェック用）
      const existingKeys = new Set(data.history.map(url => extractProductKey(url)).filter(Boolean));

      for (const url of uniqueUrls) {
        const normalizedUrl = url.split('?')[0].split('#')[0].replace(/\/$/, '');
        const key = extractProductKey(url);

        // URL完全一致 または 商品キー一致 で重複チェック
        const isDuplicate = existingUrlSet.has(normalizedUrl) || (key && existingKeys.has(key));

        if (!isDuplicate) {
          data.history.push(url);
          existingUrlSet.add(normalizedUrl);
          if (key) existingKeys.add(key);
          addedCount++;
        }
      }

      if (addedCount > 0) {
        saveQueue(data);
        console.log(`🎉 重複禁止リスト（history）に ${addedCount} 件の新着商品を同期追加しました！現在合計: ${data.history.length} 件`);
      } else {
        console.log('💡 新しく同期追加された重複禁止商品はありません（すべて同期済み）。');
      }
    }
  } catch (error) {
    console.error('❌ 同期処理中にエラーが発生しました:', error.message);
  } finally {
    await browser.close();
    console.log('🚪 自動同期セッションを終了しました。');
  }
}

// スクリプトが直接実行された場合のみ動作
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sync.js')) {
  run();
}

export { run };
