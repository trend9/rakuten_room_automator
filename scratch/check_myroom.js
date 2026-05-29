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
    // 楽天ROOMのマイページにアクセス
    await page.goto('https://room.rakuten.co.jp/v2/myroom', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);
    
    // マイページのスクリーンショットを保存
    const dir = path.resolve('storage/steps');
    const screenshotPath = path.join(dir, 'myroom_check.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`📸 マイページの確認画像を保存しました: ${screenshotPath}`);

    // 最新の投稿のコメント部分のテキストを取得してみる
    const posts = page.locator('.room-item-card, [class*="ItemCard"], [class*="item-card"]');
    const count = await posts.count();
    console.log(`📝 ページ内の投稿数: ${count}`);
    
  } catch (error) {
    console.error('❌ エラーが発生しました:', error.message);
  } finally {
    await browser.close();
  }
}

run();
