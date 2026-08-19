/**
 * research.js — 楽天APIを使ったトレンド商品リサーチ（スクレイピングフォールバック付き）
 *
 * 優先度:
 *  1. 楽天商品検索API（RAKUTEN_APP_ID 必須）→ imageUrl も同時取得
 *  2. APIキーがない場合のみPlaywrightスクレイピング（画像はOGPで取得）
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { extractProductKey } from './sync.js';

dotenv.config();

const QUEUE_PATH = path.resolve('storage/queue.json');

// ターゲット外商品の除外キーワード一覧
const EXCLUDE_KEYWORDS = [
  'playstation', 'ps5', 'ps4', 'dvd', 'blu-ray', 'ゲーム', '初回生産限定',
  'book', 'magazine', 'コミック', '漫画', 'ムック', '雑誌',
  '炭酸水', '500ml', '骨取り', 'お米', '白米', '無洗米', '天然水', 'ブレンド米',
  'コンタクトレンズ', 'ワンデーアキュビュー', 'カラコン', 'エバーカラー', 'teamo', '1day',
  'プロテイン', 'おむつ', 'オムツ', 'パンパース', 'メリーズ', 'マミーポコ',
  '医薬部外品', 'シャンプー', 'トリートメント', 'ブラトップ', 'キャミソール',
  'タンクトップ', '哺乳瓶', 'ミルク 粉', '離乳食',
  'ぬいぐるみ', 'マスコット', 'キャラクター', 'おもちゃ', '玩具', 'フィギュア',
  'キーホルダー', 'ストラップ', '缶バッジ', 'アクリルスタンド', 'アクスタ'
];

function isExcludedProduct(title, url) {
  const t = (title || '').toLowerCase();
  const u = (url || '').toLowerCase();
  if (u.includes('/book/') || u.includes('/game/')) return true;
  return EXCLUDE_KEYWORDS.some(kw => t.includes(kw.toLowerCase()));
}

function loadQueue() {
  if (fs.existsSync(QUEUE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
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

// ──────────────────────────────────────────────────────────
// 楽天商品検索API（APIキー必須）
// ──────────────────────────────────────────────────────────

// ターゲットキーワード一覧（3,000円〜100,000円・ジャンル多様化）
// ※ランダムに2キーワードずつ抽出されるため、重み付けのために件数で調整
const TARGET_KEYWORDS = [
  // 🍰 スイーツ・グルメ（4枠）
  { query: 'お取り寄せスイーツ 人気', minPrice: 3000, maxPrice: 20000 },
  { query: '高級チョコレート ギフト', minPrice: 3000, maxPrice: 15000 },
  { query: 'バウムクーヘン お取り寄せ', minPrice: 3000, maxPrice: 12000 },
  { query: 'チーズケーキ お取り寄せ 冷凍', minPrice: 3000, maxPrice: 10000 },
  // ☕ コーヒー・ドリンク・食材（3枠）
  { query: 'コーヒー豆 スペシャルティ', minPrice: 3000, maxPrice: 15000 },
  { query: 'プロテイン サプリメント', minPrice: 3000, maxPrice: 20000 },
  { query: 'お茶 高級 ギフト', minPrice: 3000, maxPrice: 15000 },
  // 🏠 便利家電・キッチン家電（5枠）
  { query: 'ロボット掃除機', minPrice: 15000, maxPrice: 100000 },
  { query: 'ノンフライヤー エアフライヤー', minPrice: 6000, maxPrice: 40000 },
  { query: '食洗機 食器洗い乾燥機', minPrice: 15000, maxPrice: 80000 },
  { query: '電気圧力鍋', minPrice: 5000, maxPrice: 50000 },
  { query: 'コーヒーメーカー エスプレッソ', minPrice: 5000, maxPrice: 60000 },
  // 🛋️ インテリア・家具・収納（3枠）
  { query: 'ソファ 一人暮らし コンパクト', minPrice: 10000, maxPrice: 80000 },
  { query: '収納 おしゃれ 棚', minPrice: 5000, maxPrice: 30000 },
  { query: '照明 おしゃれ LED', minPrice: 3000, maxPrice: 30000 },
  // 💄 ヘアケア家電（美顔器を除く）（2枠）
  { query: '高級ドライヤー ヘアドライヤー', minPrice: 8000, maxPrice: 60000 },
  { query: 'ヘアアイロン カールアイロン', minPrice: 5000, maxPrice: 40000 },
  // 🎒 アウトドア・スポーツ（3枠）
  { query: 'キャンプ アウトドア 焚き火台', minPrice: 5000, maxPrice: 50000 },
  { query: 'テント ソロキャンプ 軽量', minPrice: 10000, maxPrice: 80000 },
  { query: 'フィットネス 筋トレ ダンベル', minPrice: 5000, maxPrice: 40000 },
  // 💻 PC・ガジェット・スマホ周辺機器（4枠）
  { query: 'ワイヤレスイヤホン ノイズキャンセリング', minPrice: 5000, maxPrice: 50000 },
  { query: 'ゲーミングチェア デスクチェア', minPrice: 15000, maxPrice: 100000 },
  { query: 'スマートウォッチ ウェアラブル', minPrice: 5000, maxPrice: 60000 },
  { query: 'キーボード メカニカル ゲーミング', minPrice: 5000, maxPrice: 40000 },
  // 🏋️ 健康・リカバリー（2枠）
  { query: '体重計 スマート体重計 体組成計', minPrice: 3000, maxPrice: 20000 },
  { query: 'マッサージガン リカバリー', minPrice: 5000, maxPrice: 50000 },
  // 🎮 ホビー・趣味・エンタメ（2枠）
  { query: 'ボードゲーム カードゲーム 人気', minPrice: 3000, maxPrice: 15000 },
  { query: 'プラモデル ガンプラ 人気', minPrice: 3000, maxPrice: 20000 },
];

async function fetchFromRakutenAPI(data) {
  const appId = process.env.RAKUTEN_APP_ID || process.env.RAKUTEN_APPLICATION_ID;
  const affiliateId = process.env.RAKUTEN_AFFILIATE_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;

  if (!appId) {
    console.warn('⚠️ RAKUTEN_APP_ID が設定されていません。楽天APIは使用できません。');
    return [];
  }

  console.log(`✅ RAKUTEN_APP_ID を検出しました。楽天APIリサーチを開始します。`);

  // ランダムに2キーワードを選んで並列検索
  const shuffled = [...TARGET_KEYWORDS].sort(() => Math.random() - 0.5).slice(0, 2);
  const newProducts = [];

  for (const target of shuffled) {
    if (newProducts.length >= 15) break;

    console.log(`\n📡 楽天API検索中: "${target.query}" (${target.minPrice}〜${target.maxPrice}円)`);

    const params = new URLSearchParams({
      applicationId: appId,
      keyword: target.query,
      minPrice: target.minPrice.toString(),
      maxPrice: target.maxPrice.toString(),
      hits: '50',
      sort: 'standard',
      format: 'json',
    });
    if (affiliateId) params.append('affiliateId', affiliateId);

    const fetchHeaders = {};
    if (accessKey) {
      fetchHeaders['accessKey'] = accessKey;
    }

    try {
      const res = await fetch(
        `https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706?${params}`,
        {
          headers: fetchHeaders,
          signal: AbortSignal.timeout(20000)
        }
      );

      if (!res.ok) {
        try {
          const errJson = await res.json();
          console.warn(`  ⚠️ APIエラー: ${res.status} ${res.statusText} — ${errJson.error_description || errJson.error || JSON.stringify(errJson)}`);
        } catch (e) {
          console.warn(`  ⚠️ APIエラー: ${res.status} ${res.statusText}`);
        }
        continue;
      }

      const json = await res.json();
      const items = json.Items || [];
      console.log(`  📦 ${items.length} 件取得`);

      for (const wrapper of items) {
        if (newProducts.length >= 5) break;

        const item = wrapper.Item;
        if (!item) continue;

        // URL正規化
        let url = item.affiliateUrl || item.itemUrl;
        if (!url) continue;
        url = url.split('?')[0].split('#')[0];
        if (!url.endsWith('/')) url += '/';

        // タイトル
        let title = (item.itemName || '').replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
        title = title.replace(/レビュー高評価|スーパーDEAL|送料無料/gi, '').trim();
        if (title.length < 10) continue;

        // 除外チェック
        if (isExcludedProduct(title, url)) {
          console.log(`  ❌ 除外: ${title.substring(0, 40)}`);
          continue;
        }

        // 重複チェック
        const targetKey = extractProductKey(url);
        const inQueue = data.queue.some(p => {
          const k = extractProductKey(p.url);
          return k && k === targetKey;
        });
        const inHistory = (data.history || []).some(h => {
          const k = extractProductKey(h);
          return k && k === targetKey;
        });
        if (inQueue || inHistory) {
          console.log(`  ⏭️ 重複スキップ: ${title.substring(0, 40)}`);
          continue;
        }

        // 商品画像URL取得（楽天APIから直接取得）
        const rawImageUrl =
          item.mediumImageUrls?.[0]?.imageUrl ||
          item.smallImageUrls?.[0]?.imageUrl ||
          null;
        // クエリパラメータを除去して高画質URLを取得
        const imageUrl = rawImageUrl ? rawImageUrl.split('?')[0] : null;

        newProducts.push({
          url,
          title: title.substring(0, 80),
          addedAt: new Date().toISOString(),
          status: 'pending',
          genre: '絶品スイーツ・便利家電・美容家電',
          targetPrice: `〜${item.itemPrice}円`,
          imageUrl,           // ← 楽天APIから取得した実商品画像
          itemCode: item.itemCode || null,
        });
        console.log(`  ✅ 追加: ${title.substring(0, 50)} | 画像: ${imageUrl ? '✓' : '×'}`);
      }
    } catch (err) {
      console.warn(`  ⚠️ APIリクエストエラー: ${err.message}`);
    }
  }

  return newProducts;
}

// ──────────────────────────────────────────────────────────
// フォールバック: Playwrightスクレイピング（APIキーなし時のみ）
// ──────────────────────────────────────────────────────────

async function fetchByScrapingWithImages(data) {
  console.log('💡 APIキーなし。Playwrightスクレイピングを実行します。');

  const targetUrls = [
    {
      name: '絶品お取り寄せスイーツ（3,000円〜30,000円）',
      url: 'https://search.rakuten.co.jp/search/mall/%E3%81%8A%E5%8F%96%E3%82%8A%E5%AF%84%E3%81%9B%E3%82%B9%E3%82%A4%E3%83%BC%E3%83%84/?min=3000&max=30000&f=1',
    },
    {
      name: '話題の便利家電・キッチン家電（5,000円〜100,000円）',
      url: 'https://search.rakuten.co.jp/search/mall/%E4%BE%BF%E5%88%A9%E5%AE%B6%E9%9B%BB/?min=5000&max=100000&f=1',
    },
    {
      name: '人気の高級美容家電（5,000円〜100,000円）',
      url: 'https://search.rakuten.co.jp/search/mall/%E7%BE%8E%E5%AE%B9%E5%AE%B6%E9%9B%BB/?min=5000&max=100000&f=1',
    },
  ];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const newProducts = [];

  try {
    for (const target of targetUrls.sort(() => Math.random() - 0.5)) {
      if (newProducts.length >= 5) break;

      console.log(`\n🌐 ${target.name} をスクレイピング中...`);
      try {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);

        const pageTitle = await page.title();
        if (pageTitle.includes('アクセス制限') || pageTitle === '') {
          console.warn('  ⚠️ ボット判定。次へ。');
          continue;
        }

        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
        await page.waitForTimeout(2000);

        // 商品カード抽出（URL + タイトル + 画像）
        const items = await page.evaluate(() => {
          const allLinks = Array.from(document.querySelectorAll('a[href*="item.rakuten.co.jp"]'));
          const urlMap = new Map();
          for (const a of allLinks) {
            const href = a.href.split('?')[0].split('#')[0];
            const txt = (a.innerText || '').trim();
            // 最も長いテキストを採用
            if (txt.length >= 15) {
              if (!urlMap.has(href) || urlMap.get(href).text.length < txt.length) {
                // 同カードの画像を探す
                const card = a.closest('div, li, article, section');
                let imgUrl = null;
                if (card) {
                  const img = card.querySelector('img[src]');
                  if (img) imgUrl = img.src.split('?')[0];
                }
                urlMap.set(href, { text: txt, imgUrl });
              }
            }
          }
          return Array.from(urlMap.entries()).map(([href, v]) => ({
            href, text: v.text, imgUrl: v.imgUrl,
          }));
        });

        // 各商品を検証してキューへ
        const valPage = await context.newPage();
        try {
          for (const item of items) {
            if (newProducts.length >= 5) break;

            let url = item.href;
            if (!url.endsWith('/')) url += '/';

            const targetKey = extractProductKey(url);
            const inQueue = data.queue.some(p => {
              const k = extractProductKey(p.url);
              return k && k === targetKey;
            });
            const inHistory = (data.history || []).some(h => {
              const k = extractProductKey(h);
              return k && k === targetKey;
            });
            if (inQueue || inHistory) continue;

            let title = item.text.replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
            title = title.replace(/^\d+位\s*/, '').replace(/レビュー高評価|スーパーDEAL|送料無料/gi, '').trim();
            if (title.length < 15) continue;
            if (isExcludedProduct(title, url)) {
              console.log(`  ❌ 除外: ${title.substring(0, 40)}`);
              continue;
            }

            // 商品ページのOGP画像を取得（スクレイピング）
            let imageUrl = item.imgUrl || null;
            if (!imageUrl) {
              try {
                await valPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await valPage.waitForTimeout(4000);

                // OGP画像取得
                imageUrl = await valPage.evaluate(() => {
                  const og = document.querySelector('meta[property="og:image"]');
                  if (og?.content) return og.content.split('?')[0];
                  const r10 = document.querySelector('img[src*="r10s.jp"]');
                  if (r10?.src) return r10.src.split('?')[0];
                  return null;
                }).catch(() => null);

                // 在庫チェック (テキスト + 特定のボタン要素の有無)
                const bodyText = await valPage.innerText('body').catch(() => '');
                const cartButtonCount = await valPage.locator('button, input, a').evaluateAll(elements => {
                  return elements.filter(el => {
                    const text = (el.innerText || el.value || '').trim();
                    return text.includes('買い物かごに入れる') ||
                      text.includes('カートに入れる') ||
                      text.includes('ご購入手続き') ||
                      text.includes('寄付を申し込む') ||
                      text.includes('かごに追加') ||
                      text.includes('カートに追加');
                  }).length;
                }).catch(() => 0);

                const hasCart = bodyText.includes('買い物かごに入れる') ||
                  bodyText.includes('カートに入れる') ||
                  bodyText.includes('ご購入手続き') ||
                  bodyText.includes('寄付を申し込む') ||
                  cartButtonCount > 0;

                if (!hasCart) {
                  console.log(`  ❌ 売切れ・店舗TOPへ転送を検出: ${title.substring(0, 40)}`);
                  continue;
                }
              } catch (e) {
                console.warn(`  ⚠️ 検証エラー: ${e.message}`);
                continue;
              }
            }

            newProducts.push({
              url,
              title: title.substring(0, 80),
              addedAt: new Date().toISOString(),
              status: 'pending',
              genre: '実用インテリア・キッチン・おしゃれスイーツ',
              imageUrl: imageUrl || null,
            });
            console.log(`  ✅ 追加: ${title.substring(0, 50)} | 画像: ${imageUrl ? '✓' : '×'}`);
          }
        } finally {
          await valPage.close().catch(() => { });
        }

        if (newProducts.length >= 5) break;
      } catch (err) {
        console.warn(`  ⚠️ ${target.name} でエラー: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
    console.log('🚪 ブラウザを閉じました。');
  }

  return newProducts;
}

// ──────────────────────────────────────────────────────────
// エントリーポイント
// ──────────────────────────────────────────────────────────

async function run() {
  console.log('🔍 トレンド商品の自動リサーチを開始します...');

  const data = loadQueue();
  const pendingCount = data.queue.filter(p => p.status === 'pending').length;

  if (pendingCount >= 20) {
    console.log(`💡 pending 商品が ${pendingCount} 件あります。新規リサーチをスキップします。`);
    process.exit(0);
  }

  console.log(`📋 現在の pending 件数: ${pendingCount} 件。新商品を補充します。`);

  // 1. 楽天API（優先）
  let newProducts = await fetchFromRakutenAPI(data);

  // 2. APIで取得できなかった場合のみスクレイピング
  if (newProducts.length === 0) {
    newProducts = await fetchByScrapingWithImages(data);
  }

  if (newProducts.length > 0) {
    data.queue.push(...newProducts);
    saveQueue(data);
    console.log(`\n🎉 ${newProducts.length} 件の新商品をキューに追加しました！`);
    newProducts.forEach((p, i) => {
      console.log(`  [${i + 1}] ${p.title.substring(0, 50)} | 画像: ${p.imageUrl ? '✓' : '×'}`);
    });
  } else {
    console.warn('\n❌ 条件に合う商品が見つかりませんでした。');
  }

  console.log('🚪 リサーチを終了します。');
}

run();
