import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const STATE_PATH = path.resolve('storage/state.json');
const CONFIG_PATH = path.resolve('config.json');
const QUEUE_PATH = path.resolve('storage/queue.json');

// 設定の読み込み
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

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
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ランダムな待機時間を生成する関数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomSleep = async (min = config.minDelayMs, max = config.maxDelayMs) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  console.log(`⏱️ 安全のため ${ms / 1000} 秒間待機します...`);
  await sleep(ms);
};

// 安全にスクリーンショットを撮影するヘルパー関数
async function takeScreenshot(page, stepName) {
  const dir = path.resolve('storage/steps');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const screenshotPath = path.join(dir, `${stepName}.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  console.log(`📸 [デバッグ録画] ${stepName}.png を保存しました。`);
}

// 【API不要・ローカル完結型】超インテリジェント紹介文生成エンジン
function generateDynamicMessage(title) {
  const intros = [
    `＼これ、めちゃくちゃ話題になってます！✨／`,
    `楽天市場のリアルタイムトレンドで大注目のアイテムを発見！🔥`,
    `リピーター続出 of 超人気商品をシェアします！😆`,
    `＼見逃し厳禁！今売れに売れている大注目アイテム／`,
    `「買ってよかった！」の口コミが溢れる大人気商品をご紹介します！✨`,
    `SNSや口コミでも話題沸騰中のトレンド商品を見つけました！💖`
  ];

  let appeals = [];

  if (title.includes('ランキング') || title.includes('1位')) {
    appeals.push('🏆 楽天総合ランキングで何度も上位を獲得している、実績も人気も抜群のベストセラー商品です！');
  }
  if (title.includes('送料無料') || title.includes('送料無料※一部地域除く')) {
    appeals.push('🚚 うれしい【送料無料】なので、ネットショッピングでも余計な出費がなく安心です！');
  }
  if (title.includes('訳あり') || title.includes('わけあり') || title.includes('アウトレット')) {
    appeals.push('🉐 お得な「訳あり」プライスだからこその、圧倒的なコストパフォーマンスが最大の魅力！');
  }
  if (title.includes('プロテイン') || title.includes('ホエイ')) {
    appeals.push('💪 日々のトレーニング、本格的なボディメイク、健康管理の栄養補給として今大人気です！');
  }
  if (title.includes('日傘') || title.includes('折りたたみ') || title.includes('軽量')) {
    appeals.push('☀️ 紫外線が気になる季節 of 必須アイテム！超軽量で持ち運びも楽々なのが嬉しいですね。');
  }
  if (title.includes('炭酸水') || title.includes('水') || title.includes('ラベルレス')) {
    appeals.push('🥛 毎日の水分補給や災害用の備蓄水、お酒の割り材にも最適な、高品質・大容量の定番品！');
  }
  if (title.includes('コンタクト') || title.includes('ワンデー') || title.includes('1day') || title.includes('カラコン')) {
    appeals.push('👀 毎日使う消耗品だからこそ、お得なまとめ買いやキャンペーンで賢くストックしておくのがおすすめ！');
  }
  if (title.includes('保冷剤') || title.includes('ステンレス')) {
    appeals.push('❄️ これからの暑い季節、アウトドアやお弁当の保冷・熱中症対策に大活躍間違いなしの優れもの！');
  }
  if (title.includes('限定') || title.includes('先着') || title.includes('予約') || title.includes('無料')) {
    appeals.push('🎁 今だけの「限定特典」や「割引キャンペーン」などのお買い得なタイミングも見逃せません！');
  }

  if (appeals.length === 0) {
    const genericAppeals = [
      `🌟 抜群の実用性と高いデザイン性を兼ね備えた、長く愛用できる大満足のクオリティです。`,
      `✨ 実際に購入したユーザーの満足度も非常に高く、大切な人へのプレゼントや自分へのご褒美にも超おすすめ！`,
      `📦 日常生活をちょっと豊かに、そして便利にしてくれるアイデア満載 of 注目アイテム。`,
      `👍 圧倒的な使いやすさと信頼性で、様々な生活シーンで大活躍してくれること間違いなしの商品。`
    ];
    appeals.push(genericAppeals[Math.floor(Math.random() * genericAppeals.length)]);
  }

  const reviews = [
    `実物の写真や詳しい購入者のクチコミ、現在の在庫状況などは、楽天市場のページで詳しくチェックしてみてくださいね！👇👇`,
    `お得なセール情報やポイント還元のイベント、最新の口コミ評価は、楽天市場の公式ページで今すぐチェックできます！👇`,
    `「本当に買ってよかった！」というみんなのレビューや、お得なキャンペーン情報は楽天市場で公開されています！ぜひ見てみてくださいね👇👇`,
    `お得なセール情報や限定クーポン、気になるリアルな口コミは楽天市場の公式ページで今すぐ確認できます！🔗`
  ];

  const tagSets = [
    ['#楽天市場', '#おすすめ', '#買ってよかった', '#お買い物マラソン'],
    ['#楽天市場', '#便利グッズ', '#リピ買い', '#買ってよかった'],
    ['#楽天市場', '#トレンドアイテム', '#おすすめ商品', '#お買い物'],
    ['#楽天市場', '#買ってよかった', '#アフィリエイト', '#おすすめ', '#ライフハック'],
    ['#楽天市場', '#買ってよかった', '#プレゼント', '#自分へのご褒美']
  ];

  const intro = intros[Math.floor(Math.random() * intros.length)];
  const appeal = appeals.join('\n');
  const review = reviews[Math.floor(Math.random() * reviews.length)];
  const tags = tagSets[Math.floor(Math.random() * tagSets.length)].join(' ');

  const cleanTitle = title
    .replace(/【[^】]+】/g, '')
    .replace(/＼[^／]+／/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const fullText = `${intro}\n\n【商品名】\n${cleanTitle.substring(0, 75)}...\n\n${appeal}\n\n${review}\n\n${tags}`;
  
  return fullText.substring(0, 490);
}

async function run() {
  console.log('🚀 自動コレ！（投稿）スクリプトを開始します。');

  if (!fs.existsSync(STATE_PATH)) {
    console.error('❌ セッションファイルが存在しません。先に npm run auth を実行してログインを完了してください。');
    process.exit(1);
  }

  const data = loadQueue();
  const pendingProduct = data.queue.find(p => p.status === 'pending');

  if (!pendingProduct) {
    console.log('💡 投稿待ちの商品がキュー内にありません。');
    process.exit(0);
  }

  const targetUrl = pendingProduct.url;
  const targetTitle = pendingProduct.title;

  console.log(`📦 今回の自動投稿対象:\n🔗 URL: ${targetUrl}\n🏷️ タイトル: ${targetTitle}`);

  const isCI = process.env.GITHUB_ACTIONS === 'true';
  console.log(`🤖 稼働環境: ${isCI ? 'GitHub Actions (クラウド自動運転)' : 'ローカル PC'}`);

  // HTTP2プロトコルエラー回避
  const browser = await chromium.launch({
    headless: isCI ? true : false,
    channel: isCI ? undefined : 'chrome',
    args: ['--disable-http2']
  }).catch(() => chromium.launch({ 
    headless: isCI,
    args: ['--disable-http2']
  }));

  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    let officialRecommendUrl = null;
    let useDirectPasteRoute = false;

    // 💡 【究極のクラウドIP規制バイパス・ハイブリッドルーティング】
    // GitHub Actions（クラウド環境）のIPアドレスは、楽天市場（item.rakuten.co.jp）のAkamaiセキュリティによりボットと判定され、
    // 商品ページへのアクセス自体が100%タイムアウト（フリーズ）させられます。
    // そのため、GitHub Actions上では危険な楽天市場へのアクセスを【完全にスキップ】し、
    // IP制限の全くない楽天ROOMの「通常コピペ投稿画面」に直接アクセスして、爆速・安全に投稿を完遂します！
    
    if (isCI) {
      console.log('🌐 [Actions自動運転] 楽天市場へのアクセスをスキップし、直接楽天ROOMコピペ投稿画面に遷移します（IP規制回避）。');
      useDirectPasteRoute = true;
      officialRecommendUrl = 'https://room.rakuten.co.jp/mix/items/create/url';
    } else {
      // ローカルPC（ご自宅の一般プロバイダ回線）の場合は、これまで通り最もリアルな「商品詳細からの公式ボタン抽出ワープ」を実行します！
      console.log('🌐 楽天市場の商品ページにアクセスしています...');
      
      let loaded = false;
      let retries = 0;
      const maxRetries = 3;

      while (retries < maxRetries && !loaded) {
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          loaded = true;
        } catch (err) {
          retries++;
          console.warn(`⚠️ アクセス一時エラー: ${err.message}。1.5秒後にリトライします...`);
          await page.waitForTimeout(1500);
        }
      }

      if (!loaded) {
        throw new Error('楽天市場の商品ページのロードに失敗しました（リトライ上限超過）。');
      }

      await page.waitForTimeout(4000);
      await takeScreenshot(page, 'step1_rakuten_loaded');

      console.log('🔍 ページ内から「ROOMに投稿」ボタンを探しています...');
      const roomLinkLocator = page.locator('a[href*="room.rakuten.co.jp/recommend"]');
      if (await roomLinkLocator.count() > 0) {
        officialRecommendUrl = await roomLinkLocator.first().getAttribute('href');
        console.log('🎯 楽天市場から「ROOMに投稿」の公式正規URLを自動検出しました！');
      } else {
        const fallbackLocator = page.locator('a:has-text("ROOM"), a[class*="room"]');
        if (await fallbackLocator.count() > 0) {
          officialRecommendUrl = await fallbackLocator.first().getAttribute('href');
          console.log('🎯 フォールバックで公式ROOM投稿URLを検出しました。');
        }
      }

      if (!officialRecommendUrl) {
        console.log('💡 楽天市場上に公式投稿ボタンがないため、「通常投稿（URLコピペ）ルート」で実行します。');
        useDirectPasteRoute = true;
        officialRecommendUrl = 'https://room.rakuten.co.jp/mix/items/create/url';
      }
    }

    // -------------------------------------------------------------
    // ステップ2: 楽天ROOMの投稿画面へ遷移
    // -------------------------------------------------------------
    if (useDirectPasteRoute) {
      console.log(`🌐 投稿作成画面に直接アクセスしています: ${officialRecommendUrl}`);
      await page.goto(officialRecommendUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
    } else {
      console.log(`🚀 正規の公式投稿URLへ直接ワープします:\n👉 ${officialRecommendUrl}`);
      await page.goto(officialRecommendUrl, { waitUntil: 'commit', timeout: 0 });
    }

    console.log('⏳ 編集・入力画面の表示を待っています...');
    const commentAreaSelector = 'textarea[placeholder*="コメント"], textarea[placeholder*="オススメ"], textarea';
    const inputSelector = 'input[type="text"], input[placeholder*="URL"], input';

    if (useDirectPasteRoute) {
      await page.waitForSelector(inputSelector, { timeout: 25000 });
    } else {
      await page.waitForSelector(commentAreaSelector, { timeout: 25000 }).catch(async () => {
        console.warn('⚠️ 編集画面の表示に時間がかかっています。追加で待機します。');
        await page.waitForTimeout(5000);
      });
    }
    await takeScreenshot(page, 'step2_editor_loaded');

    // ログインセッションチェック
    const isLoginNeeded = await page.locator('text=ログイン, input[placeholder*="メール"]').count() > 0;
    if (isLoginNeeded) {
      throw new Error('セッションの有効期限が切れているか、未ログインです。再度 npm run auth を実行してください。');
    }

    // 重複投稿警告ダイアログの自動突破
    const isAlreadyCollectedModal = await page.locator('text=すでにコレ！しています, text=もう一度コレ！').count() > 0;
    if (isAlreadyCollectedModal) {
      console.log('⚠️ すでにコレ！済みのダイアログが出現しました。ダイアログを突破します...');
      await page.locator('button:has-text("はい"), button:has-text("コレ！する")').first().click().catch(() => {});
      await page.waitForTimeout(3000);
      await takeScreenshot(page, 'step2_modal_bypassed');
    }

    // -------------------------------------------------------------
    // 【コピペルートのみ】URLのコピペ入力と商品検索の実行
    // -------------------------------------------------------------
    if (useDirectPasteRoute) {
      console.log('✍️ コピペルート：URL入力欄の特定と入力を行います...');
      let urlInput = null;
      const inputs = page.locator('input, textarea');
      const inputCount = await inputs.count();
      
      for (let i = 0; i < inputCount; i++) {
        const el = inputs.nth(i);
        if (await el.isVisible()) {
          const placeholder = await el.getAttribute('placeholder') || '';
          const type = await el.getAttribute('type') || 'text';
          const id = await el.getAttribute('id') || '';
          const className = await el.getAttribute('class') || '';

          const isSearchBox = placeholder.includes('キーワード') || 
                              placeholder.includes('検索') || 
                              placeholder.includes('さがす') || 
                              id.includes('search') || 
                              className.includes('search');
          const isHiddenOrAction = type === 'submit' || type === 'button' || type === 'hidden';

          if (!isSearchBox && !isHiddenOrAction) {
            urlInput = el;
            break;
          }
        }
      }

      if (!urlInput) {
        throw new Error('コピペ用URL入力フォームが見つかりませんでした。');
      }

      await urlInput.fill(targetUrl);
      await randomSleep(1500, 2500);
      console.log('⌨️ 入力欄でEnterキーを入力して商品検索を実行します...');
      await urlInput.press('Enter');
      
      console.log('🔍 商品情報の解析中（8秒待機）...');
      await page.waitForTimeout(8000);

      await page.waitForSelector(commentAreaSelector, { timeout: 15000 });
      await takeScreenshot(page, 'step2_copypaste_resolved');
    }

    // -------------------------------------------------------------
    // ステップ3: 商品名（Name）入力欄の自動穴埋め
    // -------------------------------------------------------------
    console.log('✍️ 商品名入力欄（Name）のチェックと自動入力を試みています...');
    const nameInputSelector = 'input[placeholder*="商品名"], input[placeholder*="タイトル"], input[name*="title"], input[name*="name"], input[type="text"]';
    const nameInput = page.locator(nameInputSelector).first();
    
    if (await nameInput.isVisible()) {
      const currentName = await nameInput.inputValue();
      if (!currentName || currentName.trim() === '') {
        console.log('📝 商品名が空欄であることを検知したため、正しい商品名を入力します。');
        await nameInput.focus();
        await nameInput.click();
        await page.keyboard.press('Meta+A').catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        
        const cleanTitle = targetTitle.replace(/【[^】]+】/g, '').trim();
        await page.keyboard.insertText(cleanTitle.substring(0, 50));
        console.log(`✅ 商品名を入力しました: ${cleanTitle.substring(0, 50)}`);
      } else {
        console.log(`✅ すでに商品名が自動入力されています: ${currentName}`);
      }
    } else {
      console.log('💡 商品名入力欄は表示されていない、または自動入力済みです。');
    }
    await takeScreenshot(page, 'step3_name_checked');

    // -------------------------------------------------------------
    // ステップ4: 紹介コメント（メッセージ）のタイピング入力
    // -------------------------------------------------------------
    const commentArea = page.locator(commentAreaSelector).first();
    let commentInputSuccess = false;

    if (await commentArea.isVisible()) {
      const customComment = generateDynamicMessage(targetTitle);
      
      console.log('✍️ 独自のおすすめメッセージをタイピングします...');
      await commentArea.focus();
      await commentArea.click();
      
      await page.keyboard.press('Meta+A').catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(500);
      
      await page.keyboard.insertText(customComment);
      await page.keyboard.press('Space');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(1000);
      
      console.log('✅ おすすめ紹介メッセージとハッシュタグを入力しました！');
      commentInputSuccess = true;
    }

    if (!commentInputSuccess) {
      throw new Error('アフィリエイト編集画面に正常に入力できませんでした。');
    }
    await takeScreenshot(page, 'step4_message_typed');

    // -------------------------------------------------------------
    // ステップ5: ページ最下部へスクロールして確定ボタンの表示
    // -------------------------------------------------------------
    console.log('📜 投稿完了ボタンを表示させるため、画面の最下部へスクロールします...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'step5_scrolled_to_bottom');

    // -------------------------------------------------------------
    // ステップ6: 投稿完了確定
    // -------------------------------------------------------------
    console.log('🚀 投稿確定（完了）ボタンを探しています...');
    const submitBtnSelector = 'button:has-text("投稿"), button:has-text("完了"), button:has-text("コレ！"), button[class*="submit"], button[class*="post"]';
    const submitBtn = page.locator(submitBtnSelector).first();
    
    if (await submitBtn.isVisible() && await submitBtn.isEnabled()) {
      await takeScreenshot(page, 'step6_before_click');
      await submitBtn.click();
      console.log('🎉 コレ！の自動投稿ボタンをクリックしました！');
      
      console.log('⏳ 楽天のサーバー側で投稿処理が完了するのを待っています（最大20秒）...');
      await page.waitForTimeout(6000);
      
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
        console.log('⚠️ 投稿完了後の画面切り替え待ちタイムアウト。');
      });
      await page.waitForTimeout(5000);
      await takeScreenshot(page, 'step7_final_success');

      // キューデータのステータスを更新して保存
      pendingProduct.status = 'posted';
      pendingProduct.postedAt = new Date().toISOString();
      if (!data.history) data.history = [];
      data.history.push(targetUrl);
      saveQueue(data);
      console.log('💾 投稿キューと履歴を更新しました。正常終了！');
    } else {
      throw new Error('投稿確定ボタンが見つかりませんでした。');
    }

  } catch (error) {
    console.error('❌ 投稿実行中にエラーが発生しました:', error.message);
    await takeScreenshot(page, 'step_error_occurred');
    pendingProduct.status = 'failed';
    saveQueue(data);
  } finally {
    await browser.close();
    console.log('\n🚪 ブラウザを閉じ、自動投稿処理を終了しました。');
  }
}

run();
