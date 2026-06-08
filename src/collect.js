import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { extractProductKey } from './sync.js';

dotenv.config();

// 1回の実行で最大何件を連続投稿するか
const MAX_POSTS_PER_RUN = 3;

// Colab API URL
let COLAB_API_URL = process.argv.find(arg => arg.startsWith("http://") || arg.startsWith("https://"))
  || process.env.COLAB_API_URL;

if (COLAB_API_URL) {
  COLAB_API_URL = COLAB_API_URL.replace(/\/$/, '');
}

const STATE_PATH  = path.resolve('storage/state.json');
const CONFIG_PATH = path.resolve('config.json');
const QUEUE_PATH  = path.resolve('storage/queue.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

function loadQueue() {
  if (fs.existsSync(QUEUE_PATH)) {
    try { return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8')); }
    catch (e) { return { queue: [], history: [] }; }
  }
  return { queue: [], history: [] };
}
function saveQueue(data) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeScreenshot(page, stepName) {
  const dir = path.resolve('storage/steps');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${stepName}.png`) }).catch(() => {});
  console.log(`📸 [デバッグ録画] ${stepName}.png を保存しました。`);
}

// =============================================================
// 💡 LLM高CTA文章生成エンジン（HuggingFace Inference API経由）
//   HF_API_TOKEN 環境変数を設定するだけで即起動。
//   失敗時はテンプレートベースのフォールバックへ自動切替。
// =============================================================

/** フォールバック用テンプレートベースの文章生成 */
function generateFallbackMessage(title) {
  const cleanTitle = title
    .replace(/【[^】]+】/g, '')
    .replace(/＼[^／]+／/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const intros = [
    '普通のデパートやニトリではまず見かけない、隠れた名作を見つけちゃった✨',
    'お家時間が一気に垢抜ける！ちょっとマニアックな超便利グッズを発見🏠',
    'SNSで話題になってたやつをやっとゲット！普通の雑貨屋には置いてないんだよね🌟',
    '生活感が消えて驚くほどスッキリ片付く！インテリア好き主婦の間で密かに大バズり中の名品😆',
    'これ、本当に家事がラクになるやつ！知る人ぞ知る高見えアイテムです✨',
  ];
  const ctaList = [
    '\n\n⚠️ 大人気のため品切れ多発中。リアルタイムな在庫状況や限定クーポンは今すぐ楽天市場公式ページで確認してね👇',
    '\n\n🎁 今だけの限定割引クーポンやポイントアップ最新情報は楽天市場公式ページで公開中！損する前にチェックして👇✨',
    '\n\n💬 愛用者のリアル口コミや現在の割引価格は楽天市場公式ページで今すぐ確認できます！👇🔗',
  ];
  const tagSets = [
    '#楽天市場 #北欧インテリア #便利グッズ #暮らしを整える #お家時間',
    '#楽天市場 #買ってよかった #家事楽 #すっきり暮らす #インテリア雑貨',
    '#楽天市場 #おしゃれインテリア #暮らしの知恵 #主婦の味方 #お買い物',
    '#楽天市場 #北欧ナチュラル #買ってよかった #垢抜け部屋 #リピ買い',
    '#楽天市場 #便利グッズ #買ってよかった #お買い物マラソン #買い回り',
  ];

  const intro = intros[Math.floor(Math.random() * intros.length)];
  const cta   = ctaList[Math.floor(Math.random() * ctaList.length)];
  const tags  = tagSets[Math.floor(Math.random() * tagSets.length)];

  return `${intro}\n\n${cleanTitle.substring(0, 70)}...${cta}\n\n${tags}`.substring(0, 490);
}

/**
 * Colab API 経由でLLMに高CTA日本語文章を生成させる。
 * 失敗またはCOLAB_API_URLが未設定の場合はフォールバックを返す。
 */
async function generateLLMMessage(title) {
  const colabUrl = COLAB_API_URL;
  if (!colabUrl) {
    console.log('⚠️ COLAB_API_URLが未設定。フォールバックで生成します。');
    return generateFallbackMessage(title);
  }

  const cleanTitle = title
    .replace(/【[^】]+】/g, '')
    .replace(/＼[^／]+／/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const prompt = `以下の商品を主婦向けに「自然に購入欲をかきたてる」高CTA（クリック誘発）の日本語コメントを書いてください。

【ルール】
- 文字数は400文字以内（楽天ROOMの制限）
- 語尾は話し言葉で親しみやすく（「〜だよ！」「〜なんです♪」など）
- 宣伝と分からないよう自然に書く（「PR」「広告」禁止）
- 絵文字を効果的に使う（5〜8個程度）
- 最後にハッシュタグを3〜5個つける（#楽天市場 は必須）
- 品切れ・レア感・限定感を匂わせてCTAを高める
- 「レビュー」「口コミ」「在庫確認はこちら」などで締める

【商品名】
${cleanTitle.substring(0, 100)}

【コメント本文のみ出力。前置きや説明文は不要】`;

  try {
    const response = await fetch(
      `${colabUrl.replace(/\/$/, '')}/generate/text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          system_prompt: 'あなたは楽天ROOMでフォロワー急増中のインフルエンサーです。',
          user_prompt: prompt,
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!response.ok) {
      console.warn(`⚠️ Colab API エラー (${response.status})。フォールバックを使用します。`);
      return generateFallbackMessage(title);
    }

    const json = await response.json();
    const generated = json?.result?.trim();

    if (!generated || generated.length < 30) {
      console.warn('⚠️ LLMの出力が短すぎます。フォールバックを使用します。');
      return generateFallbackMessage(title);
    }

    const finalText = generated.substring(0, 490);
    console.log(`🤖 LLM生成成功！(${finalText.length}文字)`);
    return finalText;

  } catch (err) {
    console.warn(`⚠️ LLM生成エラー: ${err.message}。フォールバックを使用します。`);
    return generateFallbackMessage(title);
  }
}

// =============================================================
// メイン投稿処理（1商品）
// =============================================================
async function postOneProduct(pendingProduct, data) {
  const targetUrl   = pendingProduct.url;
  const targetTitle = pendingProduct.title;

  // 重複防止ガード（投稿前チェック）
  const targetKey = extractProductKey(targetUrl);
  const alreadyInHistory = data.history && data.history.some(hUrl => {
    const hKey = extractProductKey(hUrl);
    return hKey && hKey === targetKey;
  });

  if (alreadyInHistory) {
    console.log(`⚠️ 【事前重複防止ガード】「${targetTitle}」はすでに投稿済みです。スキップします。`);
    pendingProduct.status = 'duplicate';
    saveQueue(data);
    return false; // 重複スキップ
  }

  console.log(`📦 自動投稿対象:\n🔗 URL: ${targetUrl}\n🏷️ タイトル: ${targetTitle}`);
  
  // ブラウザ起動・遷移の前にLLM文章生成を終わらせておく（遷移後のアイドル時間によるセッション切れ・エラー防止）
  const customComment = await generateLLMMessage(targetTitle);

  const isCI = process.env.GITHUB_ACTIONS === 'true';
  const browser = await chromium.launch({
    headless: isCI ? true : false,
    channel:  isCI ? undefined : 'chrome',
  }).catch(() => chromium.launch({ headless: true }));

  try {
    const context = await browser.newContext({
      storageState: STATE_PATH,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // ── ステップ1: 楽天市場へ事前アクセス（クッキー活性化） ──
    console.log('🌐 楽天市場の商品ページにアクセスしています（クッキー活性化・セッション橋渡しのため）...');
    let loaded = false;
    for (let retries = 0; retries < 3 && !loaded; retries++) {
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        loaded = true;
      } catch (err) {
        console.warn(`⚠️ アクセス一時エラー: ${err.message}。リトライします...`);
        await page.waitForTimeout(1500);
      }
    }

    let officialRecommendUrl = null;
    if (loaded) {
      await page.waitForTimeout(4000);
      await takeScreenshot(page, 'step1_rakuten_loaded');

      const roomLinkLocator = page.locator('a[href*="room.rakuten.co.jp/recommend"], a[href*="room.rakuten.co.jp/mix"]');
      if (await roomLinkLocator.count() > 0) {
        const href = await roomLinkLocator.first().getAttribute('href');
        if (href && (href.includes('room.rakuten.co.jp/recommend') || href.includes('room.rakuten.co.jp/mix'))) {
          officialRecommendUrl = href;
          console.log('🎯 楽天市場から「ROOMに投稿」の公式正規URLを自動検出しました！');
        }
      }
    }

    if (!officialRecommendUrl) {
      officialRecommendUrl = `https://room.rakuten.co.jp/recommend/recommend.html?url=${encodeURIComponent(targetUrl)}`;
      console.log('🌐 公式投稿ワープURLを生成しました。');
    }

    // ── ステップ2: ROOMの投稿編集画面へ遷移 ──
    console.log(`🚀 公式投稿URLへ遷移します:\n👉 ${officialRecommendUrl}`);
    await page.goto(officialRecommendUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const commentAreaSelector = 'textarea[placeholder*="コメント"], textarea[placeholder*="オススメ"]';
    await page.waitForSelector(commentAreaSelector, { timeout: 35000 }).catch(async () => {
      console.warn('⚠️ 編集画面の表示に時間がかかっています。追加で待機します。');
      await page.waitForTimeout(5000);
    });
    await takeScreenshot(page, 'step2_editor_loaded');

    // ログインチェック
    const isLoginNeeded = await page.locator('text=ログイン, input[placeholder*="メール"]').count() > 0;
    if (isLoginNeeded) {
      throw new Error('セッション切れ。再度 npm run auth を実行してください。');
    }

    // ブラウザ上の重複ダイアログチェック
    const isAlreadyCollectedModal = await page.locator('text=すでにコレ！しています, text=もう一度コレ！, text=すでに登録されています').count() > 0;
    if (isAlreadyCollectedModal) {
      console.log('⚠️ 【重複投稿防止】楽天ROOM側の警告を検知。安全にスキップします。');
      pendingProduct.status = 'duplicate';
      saveQueue(data);
      return false;
    }

    // ── ステップ3: 商品名入力欄の自動穴埋め ──
    const nameInputSelector = 'input[placeholder*="商品名"], input[placeholder*="タイトル"], input[name*="title"], input[name*="name"], input[type="text"]';
    const nameInput = page.locator(nameInputSelector).first();
    if (await nameInput.isVisible()) {
      const currentName = await nameInput.inputValue();
      if (!currentName || currentName.trim() === '') {
        const cleanTitle = targetTitle.replace(/【[^】]+】/g, '').trim();
        await nameInput.focus();
        await nameInput.click({ force: true }).catch(() => {});
        await page.keyboard.press('Meta+A').catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        await page.keyboard.insertText(cleanTitle.substring(0, 50));
        console.log(`✅ 商品名を入力しました: ${cleanTitle.substring(0, 50)}`);
      } else {
        console.log(`✅ 商品名は自動入力済みです: ${currentName}`);
      }
    }
    await takeScreenshot(page, 'step3_name_checked');

    // ── ステップ4: LLM高CTA紹介コメントの入力 ──
    const commentArea = page.locator(commentAreaSelector).first();
    if (!(await commentArea.isVisible())) {
      throw new Error('コメント入力欄が表示されませんでした。');
    }

    if (!customComment || customComment.trim() === '') {
      throw new Error('紹介コメントが空です。投稿を中止します。');
    }

    console.log('✍️ 独自のおすすめメッセージをReactセッター経由で確実に入力します...');
    await commentArea.focus();
    await commentArea.click({ force: true }).catch(() => {});
    await commentArea.evaluate((el, val) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(el, val);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, customComment);
    await page.waitForTimeout(1000);
    
    // 入力の検証とPlaywrightによる直接フォールバック
    let verifiedValue = await commentArea.inputValue();
    if (!verifiedValue || verifiedValue.trim() === '') {
      console.log('⚠️ 値が空のため、Playwright直接入力で再試行します。');
      await commentArea.focus();
      await commentArea.fill(customComment);
      await page.waitForTimeout(1000);
      verifiedValue = await commentArea.inputValue();
    }

    if (!verifiedValue || verifiedValue.trim() === '') {
      throw new Error('紹介コメントの入力検証に失敗しました。空のまま投稿されるのを防ぐため、中止します。');
    }

    console.log(`✅ コメント入力の検証に成功しました (文字数: ${verifiedValue.length})`);
    await commentArea.blur();
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'step4_message_typed');

    // ── ステップ5: 投稿確定ボタンを押す ──
    console.log('📜 投稿完了ボタンを表示させるため、画面の最下部へスクロールします...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'step5_scrolled_to_bottom');

    const submitBtn = page.locator('button:has-text("投稿"), button:has-text("完了"), button:has-text("コレ！"), button[class*="submit"], button[class*="post"]').first();
    if (!(await submitBtn.isVisible()) || !(await submitBtn.isEnabled())) {
      throw new Error('投稿確定ボタンが見つかりませんでした。');
    }

    await takeScreenshot(page, 'step6_before_click');
    await submitBtn.click({ force: true });
    console.log('🎉 コレ！の自動投稿ボタンをクリックしました！');

    await page.waitForTimeout(6000);
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
      console.log('⚠️ 投稿完了後の画面切り替え待ちタイムアウト。');
    });
    await page.waitForTimeout(5000);
    await takeScreenshot(page, 'step7_final_success');

    // キューと履歴を更新
    pendingProduct.status   = 'posted';
    pendingProduct.postedAt = new Date().toISOString();
    if (!data.history) data.history = [];
    data.history.push(targetUrl);
    saveQueue(data);
    console.log('💾 投稿キューと履歴を更新しました。正常終了！');
    return true; // 投稿成功

  } catch (error) {
    console.error('❌ 投稿実行中にエラーが発生しました:', error.message);
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.resolve('storage/steps/step_error_occurred.png') }).catch(() => {});
    pendingProduct.status = 'failed';
    saveQueue(data);
    return false; // 投稿失敗
  } finally {
    await browser.close().catch(() => {});
    console.log('\n🚪 ブラウザを閉じ、自動投稿処理を終了しました。');
  }
}

// =============================================================
// エントリーポイント（最大 MAX_POSTS_PER_RUN 件連続投稿）
// =============================================================
async function run() {
  console.log(`🚀 自動コレ！（投稿）スクリプトを開始します。最大 ${MAX_POSTS_PER_RUN} 件連続投稿モード。`);

  if (!fs.existsSync(STATE_PATH)) {
    console.error('❌ セッションファイルが存在しません。先に npm run auth を実行してください。');
    process.exit(1);
  }

  let postedCount = 0;

  for (let round = 0; round < MAX_POSTS_PER_RUN; round++) {
    const data = loadQueue();
    let pendingProduct = data.queue.find(p => p.status === 'pending');

    // pending がなければ、1回目のみ failed を復活させる
    if (!pendingProduct && round === 0) {
      console.log('💡 pending商品なし。failed商品を pending に復活させます...');
      const failed = data.queue.find(p => p.status === 'failed');
      if (failed) {
        failed.status = 'pending';
        saveQueue(data);
        pendingProduct = failed;
      }
    }

    if (!pendingProduct) {
      console.log(`💡 投稿待ちの商品がありません。今回は ${postedCount} 件投稿して終了します。`);
      break;
    }

    console.log(`\n━━━ ラウンド ${round + 1}/${MAX_POSTS_PER_RUN} ━━━`);
    const success = await postOneProduct(pendingProduct, data);
    if (success) {
      postedCount++;
    }

    // 次ラウンドまで30秒間隔
    if (round < MAX_POSTS_PER_RUN - 1) {
      console.log('⏱️ 次の投稿まで30秒待機します...');
      await sleep(30000);
    }
  }

  console.log(`\n🏁 今回の実行で合計 ${postedCount} 件のコレ！を自動投稿しました！`);
}

run();
