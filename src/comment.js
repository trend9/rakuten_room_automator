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

  const page = await context.newPage();

  try {
    // 活性化のための楽天市場トップアクセス
    console.log('🌐 楽天市場のトップページにアクセスしています（セッション活性化のため）...');
    await page.goto('https://www.rakuten.co.jp/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const searchUrl = 'https://room.rakuten.co.jp/';
    console.log(`🔗 楽天市場のページ内にROOMトップへの偽装リンクを動的生成してクリック遷移します:\n👉 ${searchUrl}`);
    
    await page.evaluate((url) => {
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
      page.locator('#dummy-room-comment-link').click()
    ]);
    
    console.log('🌐 ROOMトップページへの遷移に成功しました！');
    
    console.log('⏳ フィードコンテンツの読み込みを待っています...');
    await page.waitForSelector('[class*="item"], [class*="Item"], [class*="post"], [class*="Post"], [class*="card"], [class*="Card"]', { timeout: 15000 }).catch(() => {
      console.log('⚠️ 投稿カードの検出タイムアウト。スクロールを開始します。');
    });

    console.log('📜 リストを読み込むために画面をスクロール中...');
    for (let s = 0; s < 4; s++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2500);
    }

    // デバッグ用スクリーンショット
    const dir = path.resolve('storage/steps');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'step_comment_loaded.png') }).catch(() => {});

    // フィードから投稿詳細URL (/room/ユーザーID/items/アイテムID) を抽出
    console.log('🔍 フィード内の投稿リンクを探索中...');
    const allLinks = await page.locator('a[href*="/room/"]').evaluateAll(links => 
      links.map(a => a.getAttribute('href'))
    );

    // 重複のない固有のアイテム詳細URLを抽出
    const itemUrls = [];
    const itemPattern = /\/room\/([^\/]+)\/items\/([^\/]+)/;
    for (const href of allLinks) {
      if (!href) continue;
      const match = href.match(itemPattern);
      if (match) {
        const fullUrl = `https://room.rakuten.co.jp${href}`;
        if (!itemUrls.includes(fullUrl)) {
          itemUrls.push({
            url: fullUrl,
            userId: match[1],
            itemId: match[2]
          });
        }
      }
    }

    console.log(`📊 抽出されたアイテム候補: ${itemUrls.length} 件`);

    let commentCount = 0;
    const limit = config.commentLimit || 3; // 1回あたりのコメント送信上限（デフォルト3回）

    for (const item of itemUrls) {
      if (commentCount >= limit) {
        console.log(`🎯 今回のコメント送信上限（${limit}回）に達したため、処理を終了します。`);
        break;
      }

      // 重複ユーザーチェック
      if (commentState.sentUsers.includes(item.userId)) {
        console.log(`⏭️ ユーザー ${item.userId} はすでに送信済みのためスキップします。`);
        continue;
      }

      console.log(`\n💬 [${commentCount + 1}/${limit}] 詳細ページへ移動します: ${item.url}`);
      try {
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // コメント入力欄の探索
        const commentAreaSelector = 'textarea[placeholder*="コメント"], textarea';
        const commentArea = page.locator(commentAreaSelector).first();

        if (await commentArea.count() > 0 && await commentArea.isVisible()) {
          await commentArea.scrollIntoViewIfNeeded();
          await page.waitForTimeout(1000);

          // コメントを交互に決定
          const commentIndex = commentState.lastCommentType;
          const targetComment = comments[commentIndex];

          console.log(`✍️ コメントを入力中: 「${targetComment}」`);
          await commentArea.focus();
          await commentArea.fill(targetComment);
          await page.waitForTimeout(1500);

          // 送信ボタンの探索とクリック
          const sendButton = page.locator('button:has-text("送信"), button:has-text("投稿"), [class*="submit" i], [class*="send" i]').first();
          if (await sendButton.count() > 0 && await sendButton.isVisible()) {
            await sendButton.click();
            console.log('🚀 送信ボタンをクリックしました。完了を待っています...');
            await page.waitForTimeout(3000);

            // 送信完了チェック（テキストボックスが空になったか確認）
            const afterValue = await commentArea.inputValue().catch(() => '');
            if (afterValue.trim() === '') {
              console.log('✅ コメント送信成功を確認しました！');
              
              // 状態の更新
              commentCount++;
              commentState.lastCommentType = (commentState.lastCommentType === 0) ? 1 : 0;
              commentState.sentUsers.push(item.userId);
              
              // 記録件数が多すぎる場合は古いものを削除 (直近150件をキープ)
              if (commentState.sentUsers.length > 150) {
                commentState.sentUsers.shift();
              }
              
              saveCommentState(commentState);
              await randomSleep(5000, 10000); // 送信後は長めに安全待機
            } else {
              console.warn('⚠️ 送信ボタンを押しましたが、コメント入力欄が空になっていません。失敗した可能性があります。');
            }
          } else {
            console.warn('⚠️ 送信ボタンが見つかりませんでした。');
          }
        } else {
          console.log('⏭️ コメント入力欄が見つからないか表示されていません。スキップします。');
        }
      } catch (err) {
        console.error(`⚠️ 処理中にエラーが発生したためスキップします:`, err.message);
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
