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
  console.log('🔍 楽天市場のリアルタイムトレンド商品をリサーチしています...');

  // ボット検出を回避するためにGoogle Chromeがあれば優先使用
  const browser = await chromium.launch({ 
    headless: true,
    channel: 'chrome' // システムのChromeを利用することでボット判定を大幅に低減
  }).catch(() => chromium.launch({ headless: true })); // なければ内蔵Chromium

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    acceptDownloads: false
  });
  
  const page = await context.newPage();

  // ボット検知回避コード：navigator.webdriver を undefined に偽装
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  const data = loadQueue();
  const foundUrls = new Set();
  const newProducts = [];

  // リサーチ候補URLリスト（ランキングが制限されたらフォールバックする）
  const targetUrls = [
    { name: '総合リアルタイムランキング', url: 'https://ranking.rakuten.co.jp/' },
    { name: '楽天市場トップ（トレンド枠）', url: 'https://www.rakuten.co.jp/' },
    { name: 'スーパーDEAL（高還元イベント）', url: 'https://event.rakuten.co.jp/superdeal/' }
  ];

  try {
    let success = false;

    for (const target of targetUrls) {
      console.log(`\n🌐 「${target.name}」にアクセスしています...`);
      try {
        await page.goto(target.url, { 
          waitUntil: 'domcontentloaded', 
          timeout: 20000 
        });
        
        await page.waitForTimeout(4000); // 描画待ち
        const pageTitle = await page.title();
        console.log(`📄 取得したページタイトル: 「${pageTitle}」`);

        // アクセス制限の画面に飛ばされた場合は次のソースへ切り替え
        if (pageTitle.includes('アクセス制限') || pageTitle.includes('アクセスが集中') || pageTitle === '') {
          console.warn(`⚠️ 「${target.name}」でボット検知またはアクセス制限が発生しました。次のソースへ移行します。`);
          continue;
        }

        // 遅延ロード対策のスクロール
        console.log('📜 ページを少しスクロールしてアイテムをロード中...');
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5));
        await page.waitForTimeout(2000);

        // リンク抽出
        const links = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a'));
          return anchors.map(a => {
            let href = a.href || '';
            let text = a.innerText || '';
            if (!text.trim() && a.querySelector('img')) {
              text = a.querySelector('img').alt || '';
            }
            return { href, text: text.trim() };
          });
        });

        // フィルタリング（item.rakuten.co.jp を含むリンク）
        const filteredLinks = links.filter(link => {
          const href = link.href;
          return href.includes('item.rakuten.co.jp') && !href.includes('ranking.rakuten.co.jp/specs/');
        });

        if (filteredLinks.length > 0) {
          console.log(`🎯 ${target.name} から ${filteredLinks.length} 件の商品リンクを抽出しました。`);
          
          for (const link of filteredLinks) {
            let url = link.href.split('?')[0].split('#')[0];
            if (!url.endsWith('/')) url += '/';

            if (foundUrls.has(url)) continue;
            foundUrls.add(url);

            const alreadyInQueue = data.queue.some(p => p.url === url);
            const alreadyInHistory = data.history && data.history.includes(url);

            if (!alreadyInQueue && !alreadyInHistory) {
              let title = link.text.replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
              title = title.replace(/^\d+位\s*/, '');

              if (title.length < 5 || title === '写真' || title === '詳細を見る') {
                title = '楽天市場 話題の人気トレンド商品';
              }

              newProducts.push({
                url: url,
                title: title.substring(0, 80),
                addedAt: new Date().toISOString(),
                status: 'pending'
              });
            }

            if (newProducts.length >= 10) break;
          }

          if (newProducts.length > 0) {
            success = true;
            break; // 必要な件数が集まったら他のソースは回らない
          }
        }
      } catch (err) {
        console.error(`⚠️ 「${target.name}」の解析中にエラーが発生しました:`, err.message);
      }
    }

    if (success && newProducts.length > 0) {
      data.queue.push(...newProducts);
      saveQueue(data);
      console.log(`\n🎉 新たに ${newProducts.length} 件のトレンド商品を自動リサーチし、投稿キューに追加しました！`);
      newProducts.forEach((p, i) => {
        console.log(`[${i + 1}] 【${p.title.substring(0, 30)}...】\n   👉 ${p.url}`);
      });
    } else {
      console.log('\n❌ すべてのソースでアクセス制限されるか、商品を取得できませんでした。');
      console.log('💡 時間をあけて再度実行するか、PC上の本物のChromeブラウザを起動させて動作する「npm run auth」をお試しください。');
    }

  } catch (error) {
    console.error('❌ リサーチ実行中に致命的なエラーが発生しました:', error);
  } finally {
    await browser.close();
    console.log('🚪 ブラウザを閉じました。リサーチを終了します。');
  }
}

run();
