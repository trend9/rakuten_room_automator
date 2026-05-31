import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_PATH = path.resolve('storage/state.json');

async function run() {
  console.log('🔍 自分のROOMページを確認します...');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  }).catch(() => chromium.launch({ headless: false }));

  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  try {
    const itemsUrl = 'https://room.rakuten.co.jp/jack555/items';
    console.log(`🌐 ユーザーマイページにアクセスしています: ${itemsUrl}`);
    await page.goto(itemsUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForTimeout(10000); // 描画完了を十分に待つ
    
    // スクロールを1回してカードをロードさせる
    console.log('📜 スクロール実行...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    // 最初の商品の画像リンク（a.link-image--2kguM）をクリックしてみる
    const cardLocator = page.locator('a.link-image--2kguM').first();
    if (await cardLocator.count() > 0) {
      console.log('🎯 1番目の商品カードをクリックします...');
      await cardLocator.click();
      await page.waitForTimeout(6000); // 遷移またはモーダルロード待ち
      
      const newUrl = page.url();
      console.log(`🎯 クリック後のURL: ${newUrl}`);

      // 遷移先またはモーダル内に楽天市場へのリンクがあるか確認
      const rakutenLink = await page.locator('a[href*="recommend.html?url="], a[href*="item.rakuten.co.jp"]').first().getAttribute('href').catch(() => '');
      console.log(`🎯 検出された楽天市場URL: ${rakutenLink}`);
      
      // スクリーンショット保存
      const screenshotPath = path.resolve('storage/myroom_debug_clicked.png');
      await page.screenshot({ path: screenshotPath });
      console.log(`📸 クリック後のスクリーンショットを保存しました: ${screenshotPath}`);
    } else {
      console.log('❌ 商品カードが見つかりませんでした。');
    }

  } catch (error) {
    console.error('❌ エラーが発生しました:', error.message);
  } finally {
    await browser.close();
  }
}

run();
