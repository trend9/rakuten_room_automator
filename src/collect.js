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

// 💡 【主婦・日常おしゃれ便利雑貨特化】高クリック率（CTA）文章生成エンジン
function generateDynamicMessage(title) {
  // 1. 主婦の共感を引き出す導入フック（デパートやリアル店舗では売っていないレア感の強調）
  const intros = [
    `＼普通のデパートやニトリではまず見かけない、隠れた名作です！✨／`,
    `お家時間が一気に垢抜ける、ちょっとマニアックでおしゃれな超便利グッズを見つけました♪🏠`,
    `＼これ、SNSで見かけて気になってたやつ！／普通の雑貨屋さんには中々置いてなくてネットでやっと発見🌟`,
    `生活感が消えて驚くほどスッキリ片付く！インテリア好き of 主婦の間で密かに大バズり中の名品です😆`,
    `＼これは本当に家事がラクになる！／近所のお店では売ってない、知る人ぞ知る高見え＆超優秀な日用雑貨です✨`,
    `普通のホームセンターには置いていない、洗練された暮らしを演出するマニアックで大人気なアイテム💖`
  ];

  // 2. マニアックで便利なレアもののベネフィットアピール
  let appeals = [];

  // タイトルからキーワードを自動判別して訴求を最適化
  if (title.includes('収納') || title.includes('ラック') || title.includes('整理') || title.includes('ボックス')) {
    appeals.push('📦 生活感を完全におしゃれに隠してくれる上、デッドスペースをフル活用できる極上の収納アイデアグッズ！');
  } else if (title.includes('キッチン') || title.includes('調理') || title.includes('便利')) {
    appeals.push('🍳 毎日のごはん作りや水回りの作業が劇的にスムーズになる、主婦の知恵が詰まった時短便利ツールです！');
  } else if (title.includes('北欧') || title.includes('インテリア') || title.includes('おしゃれ')) {
    appeals.push('🌿 お部屋にポンと置いておくだけで、まるでセレクトショップ of ディスプレイのようにお部屋全体が垢抜けます♪');
  } else {
    // 汎用のおしゃれ雑貨アピール
    const genericAppeals = [
      `🌟 よくある安価な生活雑貨とは一線を画す、細部までこだわり抜かれた機能美とデザイン性に思わず惚れ惚れしてしまいます！`,
      `✨ 「こういうの本当に欲しかった！」を形にしたマニアックな名品で、遊びに来たお友達にも「これどこで買ったの？」と聞かれること間違いなし♪`,
      `👍 毎日の暮らしがちょっと贅沢に、そして劇的に快適になる、知る人ぞ知る暮らし of アイデア商品です。`
    ];
    appeals.push(genericAppeals[Math.floor(Math.random() * genericAppeals.length)]);
  }

  // 価格帯（3,000円〜5,000円）のアピールと送料無料などのメリット
  appeals.push('🉐 チープに見えない洗練された圧倒的クオリティなのに、お買い物マラソン等の店舗買い回り（店舗追加）にも絶妙にちょうどいい3,000円〜5,000円の価格帯なのが嬉しすぎます！');

  // 3. 宣伝臭を徹底排除した、自然で強烈にクリック（CTA）を誘発する感想・誘導文（ランダム）
  const reviews = [
    `⚠️ 大人気の隠れ名品のため、楽天市場でもよく品切れ（予約待ち）になっています。現在のリアルタイムな在庫状況や、使える限定クーポン情報は今すぐこちらから確認できます👇🔗`,
    `🎁 今だけの限定割引クーポンや、ポイントアップの最新情報は楽天市場の公式ページで公開されています！損する前にぜひチェックしてみてね👇✨`,
    `「本当に買って暮らしのQOLが上がった！」というリアルな愛用者たちの引退口コミや、現在の割引価格は楽天市場の公式ページで今すぐチェックできます！👇🔗`,
    `これ、本当にすぐ売り切れてしまうので、現在のお得なプライスや在庫の有無は楽天市場の公式ページで今すぐ確認しておくのがおすすめです！🔗👇`
  ];

  // 4. 主婦層に特化したハッシュタグ
  const tagSets = [
    ['#楽天市場', '#北欧インテリア', '#便利グッズ', '#暮らしを整える', '#お家時間'],
    ['#楽天市場', '#買ってよかった', '#家事楽', '#すっきり暮らす', '#インテリア雑貨'],
    ['#楽天市場', '#おしゃれインテリア', '#暮らしの知恵', '#主婦の味方', '#お買い物'],
    ['#楽天市場', '#北欧ナチュラル', '#買ってよかった', '#垢抜け部屋', '#リピ買い'],
    ['#楽天市場', '#便利グッズ', '#買ってよかった', '#お買い物マラソン', '#買い回り']
  ];

  const intro = intros[Math.floor(Math.random() * intros.length)];
  const appeal = appeals.join('\n');
  const review = reviews[Math.floor(Math.random() * reviews.length)];
  const tags = tagSets[Math.floor(Math.random() * tagSets.length)].join(' ');

  // クレンジング：余計な記号を排除
  const cleanTitle = title
    .replace(/【[^】]+】/g, '')
    .replace(/＼[^／]+／/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 楽天ROOMの500文字制限に美しく収める
  const fullText = `${intro}\n\n【商品名】\n${cleanTitle.substring(0, 65)}...\n\n${appeal}\n\n${review}\n\n${tags}`;
  
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

  // 仮想ディスプレイ Xvfb で駆動するため、常時 headless: false
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  }).catch(() => chromium.launch({ 
    headless: false
  }));

  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    let officialRecommendUrl = null;

    // 💡 【超重要】ローカル環境では、まず楽天市場の個別商品ページにアクセスすることで、
    // 楽天の巨大なドメインをまたぐクロスドメイン認証クッキー（ITP/SameSite規制）を完全にアクティブ化させます！
    if (!isCI) {
      console.log('🌐 楽天市場の商品ページにアクセスしています（クッキーのアクティブ化・セッション橋渡しのため）...');
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

      if (loaded) {
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
      }
    }

    // 検出できなかった場合、またはGitHub Actions（CI）上では、自己生成のワープURLを使用します。
    if (!officialRecommendUrl) {
      const encodedTargetUrl = encodeURIComponent(targetUrl);
      officialRecommendUrl = `https://room.rakuten.co.jp/recommend/recommend.html?url=${encodedTargetUrl}`;
      console.log('🌐 公式投稿ワープURLを生成しました。');
    }
    
    console.log(`🚀 正規の公式投稿URLへ遷移します:\n👉 ${officialRecommendUrl}`);
    await page.goto(officialRecommendUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    console.log('⏳ 編集・入力画面の表示を待っています...');
    const commentAreaSelector = 'textarea[placeholder*="コメント"], textarea[placeholder*="オススメ"], textarea';
    
    await page.waitForSelector(commentAreaSelector, { timeout: 35000 }).catch(async () => {
      console.warn('⚠️ 編集画面の表示に時間がかかっています。追加で待機します。');
      await page.waitForTimeout(5000);
    });
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
      // 💡 超インテリジェント高クリック率（CTA）紹介文を自動生成！
      const customComment = generateDynamicMessage(targetTitle);
      
      console.log('✍️ 独自のおすすめメッセージをReactセッター経由で確実に入力します...');
      await commentArea.focus();
      await commentArea.click();
      
      // 🔥 Reactの入力トラッキング（Value Setterフック）を突破する魔法のコード
      // これにより、ReactのStateに文字が100%バインドされ、送信時に絶対に消えなくなります。
      await commentArea.evaluate((el, val) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(el, val);
        // Reactの変更検知イベントをバブリングで発火
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, customComment);
      
      await page.waitForTimeout(1000);
      
      // テキストエリアからフォーカスを外して値を確定させる
      await commentArea.blur();
      await page.waitForTimeout(1000);
      
      console.log('✅ おすすめ紹介メッセージとハッシュタグをReactステートに完全同期しました！');
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

const isCI = process.env.GITHUB_ACTIONS === 'true';
run();
