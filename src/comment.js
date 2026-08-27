import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_PATH = path.resolve('storage/state.json');
const CONFIG_PATH = path.resolve('config.json');
const COMMENT_STATE_PATH = path.resolve('storage/comment_state.json');

// 設定の読み込み
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

// ランダムな待機時間を生成する関数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomSleep = async (min = config.minDelayMs || 2000, max = config.maxDelayMs || 5000) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  console.log('⏱️ 安全待機中:', ms / 1000, '秒...');
  await sleep(ms);
};

// コメント状態管理のロード
function loadCommentState() {
  if (fs.existsSync(COMMENT_STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(COMMENT_STATE_PATH, 'utf-8'));
    } catch (e) {
      console.warn('⚠️ comment_state.json の解析に失敗しました。初期化します。');
    }
  }
  return { lastCommentType: 0, sentUsers: [] };
}

// コメント状態管理の保存
function saveCommentState(state) {
  const dir = path.dirname(COMMENT_STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COMMENT_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

async function run() {
  console.log('🚀 自動コメント送信スクリプトを開始します。');

  if (!fs.existsSync(STATE_PATH)) {
    console.error('❌ セッションファイルが存在しません。先に npm run auth を実行してログインを完了してください。');
    process.exit(1);
  }

  const commentState = loadCommentState();
  const comments = [
    "素敵なルームですね⭐️",
    "気になる商品ご紹介ありがとうございます！"
  ];

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

  // ボット防止対策
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ja', 'en-US', 'en'] });
  });

  const page = await context.newPage();

  try {
    const dir = path.resolve('storage/steps');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 活性化のための楽天市場トップアクセス
    console.log('🌐 楽天市場のトップページにアクセスしています（セッション活性化のため）...');
    await page.goto('https://www.rakuten.co.jp/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const searchUrl = 'https://room.rakuten.co.jp/';
    console.log(`🔗 楽天市場のページ内にROOMトップへの偽装リンクを動的生成してクリック遷移します:\n👉 ${searchUrl}`);
    
    let fallbackNeeded = false;
    try {
      await page.evaluate((url) => {
        if (!document.body) throw new Error('No body element');
        const a = document.createElement('a');
        a.href = url;
        a.id = 'dummy-room-comment-link';
        a.style.display = 'block';
        a.style.position = 'fixed';
        a.style.top = '10px';
        a.style.left = '10px';
        a.style.zIndex = '99999';
        a.innerText = 'Go to ROOM';
        document.body.appendChild(a);
      }, searchUrl);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
        page.locator('#dummy-room-comment-link').click({ force: true })
      ]);
    } catch (e) {
      console.warn('⚠️ 偽装リンクでの遷移に失敗したため、直接遷移します:', e.message);
      fallbackNeeded = true;
    }

    if (fallbackNeeded) {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    
    console.log('🌐 ROOMトップページへの遷移に成功しました！');
    await page.waitForTimeout(3000);

    // ログイン状態の簡易チェック（警告のみ）
    const isLoginNeeded = await page.locator('text=ログイン, input[placeholder*="メール"]').count() > 0;
    if (isLoginNeeded) {
      console.warn('⚠️ 未ログイン状態、またはセッション切れの可能性があります。処理は続行します。');
    }

    // ── 「見つける」タブ -> 「商品」サブフィルタへの遷移 ──
    console.log('🌐 「見つける」タブをクリックしてDiscover画面へ遷移します...');
    const discoverTab = page.locator('li.discover a, a:has-text("見つける")').first();
    if (await discoverTab.count() > 0) {
      await discoverTab.click();
      await page.waitForTimeout(5000);
    } else {
      console.warn('⚠️ 「見つける」タブが見つかりません。直接 discover URL への遷移を試みます。');
      await page.goto('https://room.rakuten.co.jp/discover/items', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(6000);
    }

    // 「商品」フィルタをクリック（表示されている場合のみ）
    const itemFilterLink = page.locator('.collectCoordinateItemFilter a, .collectItemFilter a').first();
    if (await itemFilterLink.count() > 0 && await itemFilterLink.isVisible()) {
      console.log('🌐 「商品」サブフィルタをクリックします...');
      await itemFilterLink.click();
      await page.waitForTimeout(5000);
    }

    let commentCount = 0;
    const limit = config.commentLimit || 3; // 2〜3人で素早く切り上げ // 1回あたりのコメント送信上限
    let processedIndex = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 15;

    // 詳細ページでのコメント送信ロジックを関数化
    async function handleCommentSubmission(targetPage, onSuccess, activeComments, activeState, screenshotDir) {
      const currentUrl = targetPage.url();
      console.log(`🌐 詳細ページURL: ${currentUrl}`);
      
      const urlMatch = currentUrl.match(/https:\/\/room\.rakuten\.co\.jp\/([a-zA-Z0-9_-]+)\/([0-9]+)/);
      const activeUser = urlMatch ? urlMatch[1] : '';

      if (!activeUser) {
        console.warn('⚠️ 詳細ページのURLからアカウント名を抽出できませんでした。');
        return false;
      }

      try {
        console.log('📜 詳細ページの初期表示を待ちます...');
        await targetPage.waitForTimeout(3000);

        await targetPage.screenshot({ path: path.join(screenshotDir, 'step_detail_page.png') }).catch(() => {});

        const commentBtn = targetPage.locator('text=コメント(').first();
        if (await commentBtn.count() > 0) {
          console.log('👉 「コメント」ボタンをクリックします。');
          await commentBtn.scrollIntoViewIfNeeded();
          await targetPage.waitForTimeout(1000);
          await commentBtn.click({ force: true });
          await targetPage.waitForTimeout(4000);
          await targetPage.screenshot({ path: path.join(screenshotDir, 'step_comment_clicked.png') }).catch(() => {});
        } else {
          console.warn('⚠️ 「コメント(X件)」ボタンが見つかりませんでした。');
          return false;
        }

        const commentAreaSelector = 'textarea[placeholder*="コメントを書いてください"], textarea[placeholder*="コメント"], textarea[placeholder*="メッセージ"], textarea[placeholder*="返信"], textarea, input[type="text"][placeholder*="コメント"]';
        console.log('⏳ コメント入力欄の出現を待機しています...');
        await targetPage.waitForSelector(commentAreaSelector, { timeout: 15000 }).catch(() => {});
        const commentArea = targetPage.locator(commentAreaSelector).first();

        if (await commentArea.count() > 0 && await commentArea.isVisible()) {
          await commentArea.scrollIntoViewIfNeeded();
          await targetPage.waitForTimeout(1500);

          const commentIndex = activeState.lastCommentType;
          const targetComment = activeComments[commentIndex];

          console.log(`✍️ コメントを入力中: 「${targetComment}」`);
          await commentArea.focus();
          await commentArea.fill(targetComment);
          await targetPage.waitForTimeout(2000);

          const sendButton = targetPage.locator('[class*="popup" i] button:has-text("送信"), [class*="modal" i] button:has-text("送信"), button:has-text("送信"), button[class*="send" i], button[class*="submit" i], button[type="submit"], [class*="send-icon" i], [class*="submit-icon" i]').first();
          
          if (await sendButton.count() > 0) {
            console.log('🚀 送信ボタンをクリックします...');
            await sendButton.click({ force: true });
          } else {
            console.log('🚀 送信ボタンが見つからないため、Enterキーで送信します...');
            await commentArea.press('Enter');
          }
          await targetPage.waitForTimeout(4000);
          await targetPage.screenshot({ path: path.join(screenshotDir, 'step_comment_sent_result.png') }).catch(() => {});

          const afterValue = await commentArea.inputValue().catch(() => '');
          if (afterValue.trim() === '') {
            console.log(`✅ コメント送信成功を確認しました！ (ユーザー: ${activeUser})`);
            onSuccess(activeUser);
            return true;
          } else {
            console.warn('⚠️ 送信ボタンを押しましたが、コメント欄がクリアされていません。');
          }
        } else {
          console.log('⏭️ コメント入力欄が見つかりません。');
        }
      } catch (err) {
        console.error(`⚠️ コメント送信処理中にエラーが発生しました:`, err.message);
      }
      return false;
    }

    while (commentCount < limit && scrollAttempts < maxScrollAttempts) {
      console.log(`\n📊 送信状況: ${commentCount}/${limit} (走査開始インデックス: ${processedIndex})`);
      
      const cards = page.locator('.discoverItems li');
      const totalItems = await cards.count();
      console.log(`📊 画面上に商品カードが ${totalItems} 件読み込まれています。`);

      if (totalItems === 0) {
        console.log('📜 商品カードがありません。スクロールして読み込みを待ちます。');
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(3000);
        scrollAttempts++;
        continue;
      }

      if (processedIndex >= totalItems) {
        console.log('📜 全ての表示済みカードを走査しました。さらにスクロールして追加読み込みします。');
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(4000);
        scrollAttempts++;
        
        const newTotal = await cards.count();
        if (newTotal === totalItems) {
          console.log('⏭️ スクロールしても新しい商品が読み込まれないため、終了します。');
          break;
        }
        continue;
      }

      let foundAndProcessed = false;

      for (let i = processedIndex; i < totalItems; i++) {
        processedIndex = i + 1;
        const card = cards.nth(i);

        if (!(await card.isVisible())) continue;

        console.log(`\n🔍 [検証中] ${i + 1}/${totalItems} 個目のカードをチェックします。`);
        await card.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1000);

        let username = await page.evaluate((el) => {
          try {
            const ngEl = window.angular && window.angular.element(el);
            if (ngEl) {
              const scope = ngEl.scope();
              if (scope && scope.item && scope.item.userName) {
                return scope.item.userName;
              }
            }
          } catch (e) {}
          
          const userLinkEl = el.querySelector('a[href*="/items"]');
          if (userLinkEl) {
            const href = userLinkEl.getAttribute('href') || '';
            const match = href.match(/\/([a-zA-Z0-9_-]+)\/items/);
            if (match) return match[1];
          }
          return '';
        }, await card.elementHandle());

        if (!username) {
          const userLink = card.locator('a[href*="/items"]').first();
          if (await userLink.count() > 0) {
            const href = await userLink.getAttribute('href') || '';
            const match = href.match(/\/([a-zA-Z0-9_-]+)\/items/);
            if (match) username = match[1];
          }
        }

        if (!username) {
          console.warn('⚠️ アカウント名を取得できませんでした。スキップします。');
          continue;
        }

        console.log(`👤 投稿者アカウント: ${username}`);

        if (commentState.sentUsers.includes(username)) {
          console.log(`⏭️ アカウント ${username} はすでに送信済みのためスキップします。`);
          continue;
        }

        console.log(`🎯 未送信ターゲット確定。プレビューを開きます。`);
        const imgLink = card.locator('img[ng-click*="gotoItem"], img, a').first();
        if (await imgLink.count() > 0) {
          await imgLink.click({ force: true });
          
          await page.waitForSelector('.item-preview', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2000);
          
          const seeMoreBtn = page.locator('.see-more, .status-box').first();
          
          if (await seeMoreBtn.count() > 0) {
            console.log('👉 「さらに見る」をクリックして詳細ページへ遷移します。');
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
              seeMoreBtn.click({ force: true })
            ]);
            await page.waitForTimeout(4000);
            
            const success = await handleCommentSubmission(page, (activeUser) => {
              commentState.lastCommentType = (commentState.lastCommentType === 0) ? 1 : 0;
              commentState.sentUsers.push(activeUser);
              if (commentState.sentUsers.length > 150) {
                commentState.sentUsers.shift();
              }
              saveCommentState(commentState);
            }, comments, commentState, dir);

            if (success) {
              commentCount++;
            }
            
            console.log('🌐 商品一覧画面へ戻ります。');
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
              await page.goto('https://room.rakuten.co.jp/discover/items', { waitUntil: 'domcontentloaded', timeout: 30000 });
            });
            await page.waitForTimeout(5000);
            
            foundAndProcessed = true;
            break; 
          } else {
            console.warn('⚠️ モーダル内の「さらに見る」が見つかりませんでした。モーダルを閉じます。');
            const closeBtn = page.locator('.close-button, [ng-click*="closePreview"]').first();
            if (await closeBtn.count() > 0) await closeBtn.click();
            await page.waitForTimeout(1500);
          }
        } else {
          console.warn('⚠️ 画像リンクが見つかりませんでした。');
        }
      }
      
      if (!foundAndProcessed) {
        await page.waitForTimeout(2000);
      }
    }

    console.log(`\n🎉 自動コメント巡回完了！ 合計 ${commentCount} 件のコメントを送信しました。`);

  } catch (error) {
    console.error('❌ 自動コメント実行中にエラーが発生しました:', error.message);
  } finally {
    await browser.close();
    console.log('🚪 ブラウザを閉じました。処理を終了します。');
  }
}

run();
