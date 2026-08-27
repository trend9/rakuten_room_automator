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
  'カーペット', 'ラグ', '絨毯', 'シャギーラグ', 'マット', '訪問着', '中古', '置物', '風水', '貔貅', '観葉植物', '生ぶり', '鰤', 
  'playstation', 'ps5', 'ps4', 'dvd', 'blu-ray', 'ゲーム', '初回生産限定',
  'book', 'magazine', 'コミック', '漫画', 'ムック', '雑誌',
  '炭酸水', '500ml', '骨取り', 'お米', '白米', '無洗米', '天然水', 'ブレンド米',
  'コンタクトレンズ', 'ワンデーアキュビュー', 'カラコン', 'エバーカラー', 'teamo', '1day',
  'おむつ', 'オムツ', 'パンパース', 'メリーズ', 'マミーポコ',
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
  // 🍰 スイーツ・お菓子・グルメ
  { query: 'スイーツ', minPrice: 500, maxPrice: 30000, genre: 'スイーツ' },
  { query: 'デザート', minPrice: 500, maxPrice: 30000, genre: 'デザート' },
  { query: 'プリン', minPrice: 500, maxPrice: 15000, genre: 'プリン' },
  { query: 'ピスタチオ', minPrice: 500, maxPrice: 20000, genre: 'ピスタチオ' },
  { query: 'モンブラン', minPrice: 800, maxPrice: 20000, genre: 'モンブラン' },
  { query: 'バームクーヘン', minPrice: 800, maxPrice: 20000, genre: 'バームクーヘン' },
  { query: 'お菓子', minPrice: 500, maxPrice: 30000, genre: 'お菓子' },
  { query: 'おつまみ', minPrice: 500, maxPrice: 30000, genre: 'おつまみ' },
  { query: 'チョコレート', minPrice: 500, maxPrice: 30000, genre: 'チョコレート' },
  { query: 'フィナンシェ', minPrice: 500, maxPrice: 20000, genre: 'フィナンシェ' },

  // 💄 コスメ・スキンケア・ビューティー
  { query: 'コスメ', minPrice: 800, maxPrice: 50000, genre: 'コスメ' },
  { query: 'スキンケア', minPrice: 800, maxPrice: 50000, genre: 'スキンケア' },
  { query: 'リップ', minPrice: 500, maxPrice: 15000, genre: 'リップ' },
  { query: 'バーム', minPrice: 500, maxPrice: 20000, genre: 'バーム' },
  { query: 'アディクション', minPrice: 1000, maxPrice: 30000, genre: 'アディクション' },
  { query: 'デパコス', minPrice: 1000, maxPrice: 50000, genre: 'デパコス' },
  { query: '頭皮ケア', minPrice: 800, maxPrice: 30000, genre: '頭皮ケア' },

  // 🎁 季節・ふるさと納税
  { query: 'おせち', minPrice: 2000, maxPrice: 50000, genre: 'おせち' },
  { query: 'ふるさと納税', minPrice: 2000, maxPrice: 50000, genre: 'ふるさと納税' },
  { query: 'シャインマスカット', minPrice: 2000, maxPrice: 40000, genre: 'シャインマスカット' },
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
  const shuffled = [...TARGET_KEYWORDS].sort(() => Math.random() - 0.5).slice(0, 5);
  const newProducts = [];

    const sortOptions = ['standard', '-reviewCount', '-updateTimestamp', '-score', '+itemPrice', '-itemPrice'];
  const subModifiers = ['ギフト', '限定', '2026', 'お取り寄せ', '大容量', '個包装', '高級', '訳あり', '国産', '人気', 'ランキング', '送料無料', 'セット', '詰め合わせ', '公式', '贅沢'];

  for (const target of shuffled) {
    if (newProducts.length >= 30) break;

    // 検索語にサブモディファイアをランダムに付与して超ニッチ化
    const modifier = Math.random() > 0.3 ? subModifiers[Math.floor(Math.random() * subModifiers.length)] : '';
    const query = modifier ? `${target.query} ${modifier}` : target.query;
    const pageNum = Math.floor(Math.random() * 15) + 1; // APIの1〜15ページ目
    const sort = sortOptions[Math.floor(Math.random() * sortOptions.length)];

    console.log(`\n📡 楽天API検索中: "${query}" (p.${pageNum}, sort:${sort}, ${target.minPrice}〜${target.maxPrice}円)`);

    const cleanAccessKey = (accessKey || '').trim();
    const params = new URLSearchParams({
      applicationId: (appId || '').trim(),
      accessKey: cleanAccessKey,
      keyword: query,
      minPrice: target.minPrice.toString(),
      maxPrice: target.maxPrice.toString(),
      page: pageNum.toString(),
      hits: '30',
      sort: sort,
      format: 'json',
    });
    if (affiliateId) params.append('affiliateId', affiliateId.trim());

    const fetchHeaders = {
      'accessKey': cleanAccessKey,
      'Referer': 'https://www.rakuten.co.jp/',
      'Origin': 'https://www.rakuten.co.jp',
    };

    try {
      const res = await fetch(
        `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601?${params.toString()}`,
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
        // if (newProducts.length >= 25) break;

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
          genre: target.genre || 'おすすめ商品',
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

                        const rawKeywords = [
    { name: 'スイーツ', genre: 'スイーツ', query: 'スイーツ', min: 500, max: 30000 },
    { name: 'デザート', genre: 'デザート', query: 'デザート', min: 500, max: 30000 },
    { name: 'プリン', genre: 'プリン', query: 'プリン', min: 500, max: 15000 },
    { name: 'ピスタチオ', genre: 'ピスタチオ', query: 'ピスタチオ', min: 500, max: 20000 },
    { name: 'モンブラン', genre: 'モンブラン', query: 'モンブラン', min: 800, max: 20000 },
    { name: 'バームクーヘン', genre: 'バームクーヘン', query: 'バームクーヘン', min: 800, max: 20000 },
    { name: 'お菓子', genre: 'お菓子', query: 'お菓子', min: 500, max: 30000 },
    { name: 'おつまみ', genre: 'おつまみ', query: 'おつまみ', min: 500, max: 30000 },
    { name: 'チョコレート', genre: 'チョコレート', query: 'チョコレート', min: 500, max: 30000 },
    { name: 'フィナンシェ', genre: 'フィナンシェ', query: 'フィナンシェ', min: 500, max: 20000 },
    { name: 'コスメ', genre: 'コスメ', query: 'コスメ', min: 800, max: 50000 },
    { name: 'スキンケア', genre: 'スキンケア', query: 'スキンケア', min: 800, max: 50000 },
    { name: 'リップ', genre: 'リップ', query: 'リップ', min: 500, max: 15000 },
    { name: 'バーム', genre: 'バーム', query: 'バーム', min: 500, max: 20000 },
    { name: 'アディクション', genre: 'アディクション', query: 'アディクション', min: 1000, max: 30000 },
    { name: 'デパコス', genre: 'デパコス', query: 'デパコス', min: 1000, max: 50000 },
    { name: '頭皮ケア', genre: '頭皮ケア', query: '頭皮ケア', min: 800, max: 30000 },
    { name: 'おせち', genre: 'おせち', query: 'おせち', min: 2000, max: 50000 },
    { name: 'ふるさと納税', genre: 'ふるさと納税', query: 'ふるさと納税', min: 2000, max: 50000 },
    { name: 'シャインマスカット', genre: 'シャインマスカット', query: 'シャインマスカット', min: 2000, max: 40000 },
  ];

  const sorts = ['standard', '-reviewCount', '-updateTimestamp', '-score', '+itemPrice'];
  const targetUrls = rawKeywords.map(k => {
    const pageNum = Math.floor(Math.random() * 5) + 1; // 1〜5ページ目（確実に商品が存在する範囲）
    const randomSort = sorts[Math.floor(Math.random() * sorts.length)];
    return {
      name: `${k.genre}: ${k.query} (p.${pageNum})`,
      genre: k.genre,
      url: `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(k.query)}/?min=${k.min}&max=${k.max}&p=${pageNum}&s=${encodeURIComponent(randomSort)}&f=1`
    };
  });

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
      if (newProducts.length >= 25) break;

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

        // 商品カード抽出（楽天市場の全バージョンDOM構造に対応）
        const items = await page.evaluate(() => {
          const allLinks = Array.from(document.querySelectorAll('a[href*="item.rakuten.co.jp"]'));
          const urlMap = new Map();
          for (const a of allLinks) {
            const href = a.href.split('?')[0].split('#')[0];
            if (!href.includes('item.rakuten.co.jp/')) continue;

            const card = a.closest('div, li, article, section') || a;
            let txt = (a.innerText || a.getAttribute('title') || '').trim();
            if (txt.length < 10 && card) {
              const titleEl = card.querySelector('h2, h3, [class*="title"], [class*="name"], img[alt]');
              if (titleEl) {
                txt = (titleEl.innerText || titleEl.getAttribute('alt') || titleEl.getAttribute('title') || '').trim();
              }
            }

            if (txt.length >= 10) {
              if (!urlMap.has(href) || urlMap.get(href).text.length < txt.length) {
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

        // 各ジャンルから偏りなく集めるため、1ジャンルあたり最大3件に制限
        let categoryCount = 0;
        const MAX_PER_CATEGORY = 3;
        for (const item of items) {
          if (newProducts.length >= 25) break;
          if (categoryCount >= MAX_PER_CATEGORY) break;

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

          // キュー内・新規追加リスト内の類似タイトルを事前チェック
          const titleCore = title.replace(/【[^】]+】/g, '').replace(/\s+/g, ' ').trim().substring(0, 15);
          const isDupTitle = data.queue.some(p => p.title && (p.title.includes(titleCore) || titleCore.includes(p.title.substring(0, 15)))) ||
                             newProducts.some(p => p.title && (p.title.includes(titleCore) || titleCore.includes(p.title.substring(0, 15))));

          if (isDupTitle) {
            console.log(`  ⏭️ 類似タイトル事前スキップ: ${title.substring(0, 40)}`);
            continue;
          }

          categoryCount++;
          newProducts.push({
            url,
            title: title.substring(0, 80),
            addedAt: new Date().toISOString(),
            status: 'pending',
            genre: target.genre || target.name,
            imageUrl: item.imgUrl || null,
          });
          console.log(`  ✅ 追加: ${title.substring(0, 50)}`);
        }

        if (newProducts.length >= 25) break;
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
  // history（重複判定済み）に含まれていない真のpending件数をカウント
  const existingKeys = new Set((data.history || []).map(u => extractProductKey(u)).filter(Boolean));
  const validPending = data.queue.filter(p => {
    if (p.status !== 'pending') return false;
    const k = extractProductKey(p.url);
    return !existingKeys.has(k);
  });

  if (validPending.length >= 15) {
    console.log(`💡 有効な pending 商品が ${validPending.length} 件あります。新規リサーチをスキップします。`);
    process.exit(0);
  }

  // 古い重複・非対応ステータスの商品をキューから除外してスリム化
  data.queue = data.queue.filter(p => p.status === 'pending');

  console.log(`📋 現在の pending 件数: ${validPending.length} 件。新商品を補充します。`);

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
