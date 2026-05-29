import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const QUEUE_PATH = path.resolve('storage/queue.json');

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

async function run() {
  console.log('🔍 主婦層ターゲットの「マニアック便利雑貨・垢抜けインテリア（3000円〜5000円）」を自動リサーチしています...');

  const browser = await chromium.launch({ 
    headless: true,
    channel: 'chrome'
  }).catch(() => chromium.launch({ headless: true }));

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

  const data = loadQueue();
  const foundUrls = new Set();
  const newProducts = [];

  // 💡 【超戦略的リサーチ先設定】
  // 主婦が好み、普通のデパートにはあまりない「おしゃれ日常雑貨・北欧風インテリア・隠れた便利グッズ」がザクザク見つかる
  // 楽天市場のカテゴリ特化URL（価格帯3,000円〜5,000円、評価4.0以上、送料無料に厳密フィルター）
  const targetUrls = [
    {
      name: '北欧おしゃれインテリア雑貨（3000-5000円）',
      url: 'https://search.rakuten.co.jp/search/mall/%E5%8C%97%E6%AC%A7+%E3%82%A4%E3%83%B3%E3%83%86%E3%82%A3%E3%83%AA%E3%82%A2+%E9%9B%91%E8%B2%A8/min=3000/max=5000/?f=1&grp=product&p1=3000&p2=5000&sf=0'
    },
    {
      name: '家事が劇的に楽になる隠れた便利グッズ（3000-5000円）',
      url: 'https://search.rakuten.co.jp/search/mall/%E5%AE%B6%E4%BA%8B%E6%A5%BD%E3%80%80%E4%BE%BF%E5%88%A9%E3%82%B0%E3%82%A2%E3%83%83%E3%82%BA/min=3000/max=5000/?f=1&grp=product&p1=3000&p2=5000&sf=0'
    },
    {
      name: 'キッチン・バスまわりの垢抜け収納アイテム（3000-5000円）',
      url: 'https://search.rakuten.co.jp/search/mall/%E3%81%8A%E3%81%97%E3%82%83%E3%82%8C%E3%80%80%E5%8F%8E%E7%B4%8D%E3%80%80%E3%83%A9%E3%83%83%E3%82%AF/min=3000/max=5000/?f=1&grp=product&p1=3000&p2=5000&sf=0'
    }
  ];

  try {
    let success = false;

    for (const target of targetUrls) {
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

        // 楽天市場の商品リンクを高度に解析・抽出
        const items = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll('div.search-grid-item, div.ri-search-card, a[href*="item.rakuten.co.jp"]'));
          return cards.map(card => {
            // 親要素のリンクやテキスト、価格などのメタデータをピンポイント抽出
            let href = '';
            let text = '';
            let priceText = '0';

            if (card.tagName.toLowerCase() === 'a') {
              href = card.href;
              text = card.innerText || '';
            } else {
              const link = card.querySelector('a[href*="item.rakuten.co.jp"]');
              if (link) {
                href = link.href;
                text = link.innerText || '';
              }
            }

            // 価格情報の取得（およその価格帯のダブルチェック用）
            const priceEl = card.querySelector('.price--XXXX, [class*="price"], [class*="Price"]');
            if (priceEl) {
              priceText = priceEl.innerText || '0';
            }

            return { href, text: text.trim(), price: priceText.replace(/[^0-9]/g, '') };
          });
        });

        // フィルタリング処理（送料無料、評価の高い店舗商品のみを厳選）
        const filteredItems = items.filter(item => {
          const href = item.href;
          // 不要なリダイレクトや規格指定ページを除外
          return href.includes('item.rakuten.co.jp') && 
                 !href.includes('ranking.rakuten.co.jp') && 
                 !href.includes('coupon.rakuten.co.jp');
        });

        if (filteredItems.length > 0) {
          console.log(`🎯 ${target.name} から ${filteredItems.length} 件のおしゃれ雑貨候補を抽出しました。`);
          
          for (const item of filteredItems) {
            let url = item.href.split('?')[0].split('#')[0];
            if (!url.endsWith('/')) url += '/';

            if (foundUrls.has(url)) continue;
            foundUrls.add(url);

            const alreadyInQueue = data.queue.some(p => p.url === url);
            const alreadyInHistory = data.history && data.history.includes(url);

            if (!alreadyInQueue && !alreadyInHistory) {
              let title = item.text.replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
              
              // ゴミテキストやポイント表記の排除
              title = title.replace(/^\d+位\s*/, '');
              title = title.replace(/レビュー高評価|スーパーDEAL|送料無料/gi, '');

              // あまりに短いものは商品名の体をなしていないためスルー
              if (title.length < 15 || title.includes('お気に入り商品') || title.includes('レビュー')) {
                continue;
              }

              // 主婦が思わずクリックしたくなる「マニアックな垢抜け日常雑貨」をキューに追加！
              newProducts.push({
                url: url,
                title: title.substring(0, 80),
                addedAt: new Date().toISOString(),
                status: 'pending',
                genre: '主婦向けインテリア・便利雑貨',
                targetPrice: '3,000-5,000円'
              });
            }

            // 1回のリサーチで最大10件取得したら終了
            if (newProducts.length >= 10) break;
          }

          if (newProducts.length > 0) {
            success = true;
            break; 
          }
        }
      } catch (err) {
        console.error(`⚠️ 「${target.name}」の解析中にエラーが発生しました:`, err.message);
      }
    }

    if (success && newProducts.length > 0) {
      data.queue.push(...newProducts);
      saveQueue(data);
      console.log(`\n🎉 新たに ${newProducts.length} 件の【3,000円〜5,000円・主婦向け垢抜けおしゃれ便利雑貨】を厳選し、投稿キューに追加しました！`);
      newProducts.forEach((p, i) => {
        console.log(`[${i + 1}] 【${p.title.substring(0, 30)}...】\n   👉 ${p.url}`);
      });
    } else {
      console.log('\n❌ 条件に合致する「3,000-5,000円のおしゃれ雑貨」の自動リサーチに失敗しました。');
      console.log('💡 楽天市場の検索が混雑している可能性があるため、時間をおいて再度お試しください。');
    }

  } catch (error) {
    console.error('❌ リサーチ実行中に致命的なエラーが発生しました:', error);
  } finally {
    await browser.close();
    console.log('🚪 ブラウザを閉じました。リサーチを終了します。');
  }
}

run();
