import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { extractProductKey } from './sync.js';

dotenv.config();

const QUEUE_PATH = path.resolve('storage/queue.json');
console.log(`📂 QUEUE_PATH 絶対パス: ${QUEUE_PATH}`);
console.log(`📂 現在の CWD: ${process.cwd()}`);

// キューデータの読み込み
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

// キューデータの保存
function saveQueue(data) {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
// 楽天商品検索APIを使用した商品取得
async function fetchFromRakutenAPI() {
  const appId = process.env.RAKUTEN_APP_ID || process.env.RAKUTEN_APPLICATION_ID;
  const affiliateId = process.env.RAKUTEN_AFFILIATE_ID || process.env.RAKUTEN_ACCESS_KEY;
  
  if (!appId) {
    console.log('💡 楽天APIの認証情報 (RAKUTEN_APP_ID) が設定されていないため、APIリサーチはスキップしスクレイピングを実行します。');
    return null;
  }

  // 18-40歳の主婦・女性にターゲットを厳格化
  const keywords = [
    { query: "かわいい インテリア 雑貨", minPrice: 1000, maxPrice: 30000 },
    { query: "韓国 インテリア 小物", minPrice: 1000, maxPrice: 30000 },
    { query: "スクイーズ キーホルダー かわいい", minPrice: 1000, maxPrice: 30000 },
    { query: "かわいい シール ステッカー デコ", minPrice: 1000, maxPrice: 3000 },
    { query: "期間限定 スイーツ デザート ギフト", minPrice: 1000, maxPrice: 6000 },
    { query: "かわいい お菓子 プレゼント", minPrice: 1000, maxPrice: 10000 }
  ];

  const target = keywords[Math.floor(Math.random() * keywords.length)];
  console.log(`📡 楽天APIを使用して商品を検索中... (キーワード: "${target.query}", 価格帯: ${target.minPrice}〜${target.maxPrice}円)`);

  const url = `https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706`;
  const params = new URLSearchParams({
    applicationId: appId,
    keyword: target.query,
    minPrice: target.minPrice.toString(),
    maxPrice: target.maxPrice.toString(),
    hits: '30',
    sort: 'standard',
    format: 'json'
  });
  if (affiliateId) {
    params.append('affiliateId', affiliateId);
  }

  try {
    const res = await fetch(`${url}?${params.toString()}`);
    if (!res.ok) {
      console.warn(`⚠️ 楽天APIエラー: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    return data.Items || [];
  } catch (err) {
    console.warn(`⚠️ 楽天APIリクエスト中にエラーが発生しました: ${err.message}`);
    return null;
  }
}

async function run() {
  console.log('🔍 可愛いインテリアおよびスクイーズなどの小物雑貨（〜1万円）を自動リサーチしています...');

  const data = loadQueue();
  const pendingCount = data.queue.filter(p => p.status === 'pending').length;
  if (pendingCount >= 10) {
    console.log(`💡 現在のキュー内には ${pendingCount} 件の未投稿商品が残っています。十分に在庫があるため、新規リサーチはスキップします。`);
    process.exit(0);
  }

  const newProducts = [];
  const foundUrls = new Set();

  // 1. まずは楽天API経由での取得を試みる
  const apiItems = await fetchFromRakutenAPI();
  if (apiItems && apiItems.length > 0) {
    console.log(`🎯 楽天APIから ${apiItems.length} 件の商品候補を取得しました。重複をチェックしてキューに追加します...`);
    
    for (const itemWrapper of apiItems) {
      const item = itemWrapper.Item;
      if (!item) continue;
      
      let url = item.affiliateUrl || item.itemUrl;
      if (!url) continue;
      url = url.split('?')[0].split('#')[0];
      if (!url.endsWith('/')) url += '/';

      if (foundUrls.has(url)) continue;
      foundUrls.add(url);

      const targetKey = extractProductKey(url);
      const alreadyInQueue = data.queue.some(p => {
        const pKey = extractProductKey(p.url);
        return pKey && pKey === targetKey;
      });
      const alreadyInHistory = data.history && data.history.some(hUrl => {
        const hKey = extractProductKey(hUrl);
        return hKey && hKey === targetKey;
      });

      if (!alreadyInQueue && !alreadyInHistory) {
        let title = item.itemName.replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
        title = title.replace(/レビュー高評価|スーパーDEAL|送料無料/gi, '');
        
        if (title.length < 15) continue;

        // 本・書籍・ゲーム・コミック等の除外フィルタ
        const lowercaseTitle = title.toLowerCase();
        const lowercaseUrl = url.toLowerCase();
        const isExcluded = 
          lowercaseTitle.includes('book') || lowercaseTitle.includes('magazine') || 
          lowercaseTitle.includes('コミック') || lowercaseTitle.includes('漫画') || 
          lowercaseTitle.includes('ムック') || lowercaseTitle.includes('雑誌') || 
          lowercaseTitle.includes('ゲーム') || lowercaseTitle.includes('playstation') || 
          lowercaseTitle.includes('ps5') || lowercaseTitle.includes('vr') || 
          lowercaseTitle.includes('dvd') || lowercaseTitle.includes('bd') ||
          lowercaseUrl.includes('/book/') || lowercaseUrl.includes('/game/');

        if (isExcluded) {
          console.log(`❌ 【除外フィルタ】ターゲット外の商品を除外しました: ${title}`);
          continue;
        }

        newProducts.push({
          url: url,
          title: title.substring(0, 80),
          addedAt: new Date().toISOString(),
          status: 'pending',
          genre: '可愛いインテリア・スクイーズ・小物雑貨・シール・スイーツ',
          targetPrice: `〜${item.itemPrice}円`
        });
      }

      if (newProducts.length >= 5) break;
    }
  }

  // 2. 楽天APIで商品が取れなかった場合は、Playwrightによるスクレイピングにフォールバック
  if (newProducts.length === 0) {
    console.log('💡 API経由で商品が取得できなかったため、Playwrightによるブラウザスクレイピングを実行します。');
    
    const browser = await chromium.launch({ 
      headless: true
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ja-JP',
    });
    
    const page = await context.newPage();

    // ボット検出回避
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    const targetUrls = [
      {
        name: 'かわいいインテリア雑貨（〜10,000円）',
        url: 'https://search.rakuten.co.jp/search/mall/%E3%81%8B%E3%82%8F%E3%81%84%E3%81%84+%E3%82%A4%E3%83%B3%E3%83%86%E3%83%AA%E3%82%A2/max=10000/?exch=1&f=1&grp=product&p2=10000&sf=0'
      },
      {
        name: '韓国風おしゃれインテリア小物（〜10,000円）',
        url: 'https://search.rakuten.co.jp/search/mall/%E9%9F%93%E5%9B%BD+%E3%82%A4%E3%83%B3%E3%83%86%E3%83%AA%E3%82%A2+%E5%B0%8F%E7%89%A9/max=10000/?exch=1&f=1&grp=product&p2=10000&sf=0'
      },
      {
        name: 'かわいいスクイーズ・マスコット（〜5,000円）',
        url: 'https://search.rakuten.co.jp/search/mall/%E3%82%B9%E3%82%AF%E3%82%A4%E3%83%BC%E3%82%BA+%E3%81%8B%E3%82%8F%E3%81%84%E3%81%84/max=5000/?exch=1&f=1&grp=product&p2=5000&sf=0'
      },
      {
        name: 'かわいいシール・ステッカー（〜3,000円）',
        url: 'https://search.rakuten.co.jp/search/mall/%E3%81%8B%E3%82%8F%E3%81%84%E3%81%84+%E3%82%B7%E3%83%BC%E3%83%AB+%E3%82%B9%E3%83%86%E3%83%83%E3%82%AB%E3%83%BC/max=3000/?exch=1&f=1&grp=product&p2=3000&sf=0'
      },
      {
        name: '期間限定の可愛いスイーツ・お菓子（〜6,000円）',
        url: 'https://search.rakuten.co.jp/search/mall/%E6%9C%9F%E9%96%93%E9%99%90%E5%AE%9A+%E3%82%B9%E3%82%A4%E3%83%BC%E3%83%85+%E3%81%8A%E8%8F%85%E5%AD%90+%E3%81%8B%E3%82%8F%E3%81%84%E3%81%84/max=6000/?exch=1&f=1&grp=product&p2=6000&sf=0'
      }
    ];

    try {
      let success = false;
      const shuffledTargets = targetUrls.sort(() => Math.random() - 0.5);

      for (const target of shuffledTargets) {
        console.log(`\n🌐 「${target.name}」の選定ページにアクセスしています...`);
        try {
          await page.goto(target.url, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
          });
          
          await page.waitForTimeout(5000); // 描画完了待ち
          const pageTitle = await page.title();

          if (pageTitle.includes('アクセス制限') || pageTitle.includes('アクセスが集中') || pageTitle === '') {
            console.warn(`⚠️ 「${target.name}」で一時的なボット判定が発生したため、次の特化リストへ移行します。`);
            continue;
          }

          // ページをスクロールしてアイテムを完全にロード
          console.log('📜 レア名品を掘り出すため、検索結果をスクロールロード中...');
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
          await page.waitForTimeout(2000);

          // 楽天市場の商品リンクを抽出
          const items = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll([
              'div.search-grid-item', 
              'div.ri-search-card', 
              'div[class*="item"]', 
              'div[class*="Card"]',
              'tr.shop-item'
            ].join(',')));

            if (cards.length > 0) {
              return cards.map(card => {
                const links = Array.from(card.querySelectorAll('a[href*="item.rakuten.co.jp"]'));
                if (links.length === 0) return null;

                let bestLink = links[0];
                let maxLen = 0;
                for (const l of links) {
                  const txt = (l.innerText || '').trim();
                  if (txt.length > maxLen) {
                    maxLen = txt.length;
                    bestLink = l;
                  }
                }

                const titleEl = card.querySelector([
                  '[class*="title"]',
                  '[class*="name"]',
                  'h2',
                  'h3'
                ].join(','));

                const titleText = titleEl ? (titleEl.innerText || '').trim() : '';
                const finalTitle = titleText.length > maxLen ? titleText : (bestLink.innerText || '').trim();

                return {
                  href: bestLink.href,
                  text: finalTitle,
                  price: '0'
                };
              }).filter(Boolean);
            }

            const allLinks = Array.from(document.querySelectorAll('a[href*="item.rakuten.co.jp"]'));
            const urlMap = new Map();
            for (const a of allLinks) {
              const url = a.href.split('?')[0].split('#')[0];
              const txt = (a.innerText || '').trim();
              if (txt.length >= 15) {
                if (!urlMap.has(url) || urlMap.get(url).length < txt.length) {
                  urlMap.set(url, txt);
                }
              }
            }

            return Array.from(urlMap.entries()).map(([href, text]) => ({
              href,
              text,
              price: '0'
            }));
          });

          const filteredItems = items.filter(item => {
            const href = item.href;
            return href.includes('item.rakuten.co.jp') && 
                   !href.includes('ranking.rakuten.co.jp') && 
                   !href.includes('coupon.rakuten.co.jp');
          });

          if (filteredItems.length > 0) {
            console.log(`🎯 ${target.name} から ${filteredItems.length} 件の商品候補を抽出しました。`);
            const valPage = await context.newPage();
            
            try {
              for (const item of filteredItems) {
                let url = item.href.split('?')[0].split('#')[0];
                if (!url.endsWith('/')) url += '/';

                if (foundUrls.has(url)) continue;
                foundUrls.add(url);

                const targetKey = extractProductKey(url);
                const alreadyInQueue = data.queue.some(p => {
                  const pKey = extractProductKey(p.url);
                  return pKey && pKey === targetKey;
                });
                const alreadyInHistory = data.history && data.history.some(hUrl => {
                  const hKey = extractProductKey(hUrl);
                  return hKey && hKey === targetKey;
                });

                if (!alreadyInQueue && !alreadyInHistory) {
                  let title = item.text.replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
                  title = title.replace(/^\d+位\s*/, '');
                  title = title.replace(/レビュー高評価|スーパーDEAL|送料無料/gi, '');

                  if (title.length < 15 || title.includes('お気に入り商品') || title.includes('レビュー')) {
                    continue;
                  }

                  // 本・書籍・ゲーム・コミック等の除外フィルタ
                  const lowercaseTitle = title.toLowerCase();
                  const lowercaseUrl = url.toLowerCase();
                  const isExcluded = 
                    lowercaseTitle.includes('book') || lowercaseTitle.includes('magazine') || 
                    lowercaseTitle.includes('コミック') || lowercaseTitle.includes('漫画') || 
                    lowercaseTitle.includes('ムック') || lowercaseTitle.includes('雑誌') || 
                    lowercaseTitle.includes('ゲーム') || lowercaseTitle.includes('playstation') || 
                    lowercaseTitle.includes('ps5') || lowercaseTitle.includes('vr') || 
                    lowercaseTitle.includes('dvd') || lowercaseTitle.includes('bd') ||
                    lowercaseUrl.includes('/book/') || lowercaseUrl.includes('/game/');

                  if (isExcluded) {
                    console.log(`❌ 【除外フィルタ】ターゲット外の商品を除外しました: ${title}`);
                    continue;
                  }

                  console.log(`🔎 候補商品の有効性を事前検証中...: ${url}`);
                  let isValid = false;
                  try {
                    await valPage.goto(url, { waitUntil: 'commit', timeout: 15000 });
                    await valPage.waitForTimeout(4000);
                    
                    const pageTitle = await valPage.title().catch(() => '');
                    const cleanTitleForCheck = title
                      .replace(/【[^】]+】/g, '')
                      .replace(/＼[^／]+／/g, '')
                      .replace(/[\[\]［］()（）「」『』]/g, '')
                      .trim();
                    
                    const keyword = cleanTitleForCheck.substring(0, 10);
                    const h1Texts = await valPage.locator('h1').allInnerTexts().catch(() => []);
                    const h1Combined = h1Texts.join(' ');
                    const hasH1Match = h1Combined.includes(keyword) || pageTitle.includes(keyword);
                    
                    if (!hasH1Match || pageTitle.includes('店舗のトップページ') || pageTitle.includes('ショップのトップページ')) {
                      console.log(`❌ 【すり替え転送検知】h1/タイトルに商品名キーワード (${keyword}) が含まれていません。`);
                    } else {
                      const bodyText = await valPage.innerText('body').catch(() => '');
                      const hasActivePurchaseBtn = 
                        bodyText.includes('買い物かごに入れる') || 
                        bodyText.includes('カートに入れる') || 
                        bodyText.includes('ご購入手続き') || 
                        bodyText.includes('カートに追加') || 
                        bodyText.includes('購入手続きへ') || 
                        bodyText.includes('予約注文する') || 
                        bodyText.includes('予約する');
                      
                      if (hasActivePurchaseBtn) {
                        isValid = true;
                      }
                    }
                  } catch (e) {
                    console.warn(`⚠️ 商品ページの事前検証中に一時エラーが発生しました: ${e.message}`);
                  }

                  if (!isValid) {
                    console.log(`❌ 売り切れまたは店舗トップへの自動転送を検知したため除外します。`);
                    continue;
                  }
                  console.log(`✅ 有効な現役商品であることを確認しました！キューに追加します。`);

                  newProducts.push({
                    url: url,
                    title: title.substring(0, 80),
                    addedAt: new Date().toISOString(),
                    status: 'pending',
                    genre: '可愛いインテリア・スクイーズ・小物雑貨・シール・スイーツ',
                    targetPrice: '〜10,000円'
                  });
                }

                if (newProducts.length >= 5) break;
              }

              if (newProducts.length > 0) {
                success = true;
                break; 
              }
            } finally {
              await valPage.close().catch(() => {});
            }
          }
        } catch (err) {
          console.error(`⚠️ 「${target.name}」の解析中にエラーが発生しました:`, err.message);
        }
      }
    } finally {
      await browser.close();
      console.log('🚪 ブラウザを閉じました。');
    }
  }

  // キューへ保存
  if (newProducts.length > 0) {
    data.queue.push(...newProducts);
    saveQueue(data);
    console.log(`\n🎉 新たに ${newProducts.length} 件の【可愛いインテリア・スクイーズ・小物雑貨】を厳選し、投稿キューに追加しました！`);
    newProducts.forEach((p, i) => {
      console.log(`[${i + 1}] 【${p.title.substring(0, 30)}...】\n   👉 ${p.url}`);
    });
  } else {
    console.log('\n❌ 条件に合致する商品の自動リサーチに失敗しました。');
  }
  console.log('🚪 リサーチを終了します。');
}

run();
