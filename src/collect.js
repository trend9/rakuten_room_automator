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

/** GitHub Models API による生成 (GITHUB_TOKENを使用) */
async function generateGitHubModelsMessage(prompt) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return null;

  try {
    console.log('🤖 GITHUB_TOKEN検出。GitHub Models API (gpt-4o-mini) でコメントを生成中...');
    const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "あなたは楽天ROOMでフォロワー急増中の可愛いインテリア・雑貨専門インフルエンサーです。上品で高級感があり、かつワクワクする魅力を日本語のみで執筆してください。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (response.ok) {
      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content?.trim();
      if (content && content.length >= 30) {
        return content;
      }
    } else {
      console.warn(`⚠️ GitHub Models APIエラー: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`⚠️ GitHub Models API呼び出し中にエラーが発生しました: ${err.message}`);
  }
  return null;
}

/** Pollinations AI による生成 (キー不要) */
async function generatePollinationsMessage(prompt) {
  const models = ["openai", "mistral"];
  for (const model of models) {
    try {
      console.log(`🤖 キー不要の Pollinations AI (model: ${model}) でコメントを生成中...`);
      const response = await fetch("https://text.pollinations.ai/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "あなたは楽天ROOMでフォロワー急増中の可愛いインテリア・雑貨専門インフルエンサーです。上品で高級感があり、かつワクワクする魅力を日本語のみで執筆してください。" },
            { role: "user", content: prompt }
          ],
          model: model
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (response.ok) {
        const text = await response.text();
        const cleaned = text.trim();
        if (cleaned && cleaned.length >= 30) {
          return cleaned;
        }
      } else {
        console.warn(`⚠️ Pollinations AI (${model}) エラー: ${response.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Pollinations AI (${model}) 呼び出し中にエラーが発生しました: ${err.message}`);
    }
  }
  return null;
}

/**
 * Colab API または各種LLM API 経由でLLMに高CTA日本語文章を生成させる。
 * 失敗した場合は順次フォールバックチェーンを実行する。
 */
async function generateLLMMessage(title) {
  const cleanTitle = title
    .replace(/【[^】]+】/g, '')
    .replace(/＼[^／]+／/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const prompt = `あなたは楽天ROOMでフォロワー急増中の大人気インフルエンサーです。
以下の「大人可愛いインテリア・スクイーズ・おしゃれ小物雑貨」を主婦や可愛いもの好きに向けて、思わずクリックしたくなる高CTA（クリック誘発）の日本語紹介コメントを書いてください。

【ルール】
- 文字数は400文字以内（絶対に厳守、楽天ROOMの文字数制限のため）
- 語尾は話し言葉で親しみやすく（「〜だよ！」「〜なんです♪」など）
- 宣伝と分からないよう自然に書く（「PR」「広告」禁止）
- 絵文字を効果的に使う（5〜8個程度）
- 最後にハッシュタグを3〜5個つける（#楽天市場 は必須。その他 #インテリア #スクイーズ #かわいい雑貨 など）
- 商品の可愛さ、お部屋に置いたときの雰囲気、癒やし効果、売り切れやすいレア感をアピールする
- 「レビュー」「口コミ」「在庫確認はこちら」などで締める

【商品名】
${cleanTitle.substring(0, 100)}

【コメント本文のみ出力。前置きや説明文、\`\`\` などのマークダウン装飾は一切不要】`;

  // 1. 最優先: Colab API (COLAB_API_URLを使用) を試行
  const colabUrl = COLAB_API_URL;
  if (colabUrl) {
    try {
      console.log('🤖 Colab APIでコメントを生成中...');
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

      if (response.ok) {
        const json = await response.json();
        const generated = json?.result?.trim();
        if (generated && generated.length >= 30) {
          const finalText = generated.substring(0, 490);
          console.log(`🤖 LLM (Colab) 生成成功！(${finalText.length}文字)`);
          return finalText;
        }
      } else {
        console.warn(`⚠️ Colab API エラー (${response.status})。フォールバックを試みます。`);
      }
    } catch (err) {
      console.warn(`⚠️ Colab APIでの生成中にエラーが発生しました: ${err.message}。フォールバックを試みます。`);
    }
  } else {
    console.log('💡 COLAB_API_URLが設定されていないため、次のフォールバックを試みます。');
  }

  // 2. フォールバック1: HuggingFace Inference API (HF_API_TOKENを使用) を試行
  const hfToken = process.env.HF_API_TOKEN;
  if (hfToken) {
    try {
      console.log('🤖 HuggingFace Inference API でコメントを生成中...');
      const response = await fetch(
        'https://router.huggingface.co/novita/v3/openai/chat/completions',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'qwen/qwen2.5-72b-instruct',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 400,
            temperature: 0.85,
          }),
          signal: AbortSignal.timeout(20000),
        }
      );

      if (response.ok) {
        const json = await response.json();
        const generated = json?.choices?.[0]?.message?.content?.trim();
        if (generated && generated.length >= 30) {
          const finalText = generated.substring(0, 490);
          console.log(`🤖 LLM (HuggingFace) 生成成功！(${finalText.length}文字)`);
          return finalText;
        }
      } else {
        console.warn(`⚠️ HF API エラー (${response.status})。フォールバックを試みます。`);
      }
    } catch (err) {
      console.warn(`⚠️ HF APIでの生成中にエラーが発生しました: ${err.message}。フォールバックを試みます。`);
    }
  } else {
    console.log('💡 HF_API_TOKENが設定されていないため、次のフォールバックを試みます。');
  }

  // 3. フォールバック2: GitHub Models API
  const ghResult = await generateGitHubModelsMessage(prompt);
  if (ghResult) {
    const finalText = ghResult.substring(0, 490);
    console.log(`🤖 LLM (GitHub Models) 生成成功！(${finalText.length}文字)`);
    return finalText;
  }

  // 4. フォールバック3: Pollinations AI (キー不要で安定稼働)
  const polResult = await generatePollinationsMessage(prompt);
  if (polResult) {
    const finalText = polResult.substring(0, 490);
    console.log(`🤖 LLM (Pollinations AI) 生成成功！(${finalText.length}文字)`);
    return finalText;
  }

  // 5. 最終フォールバック: テンプレートベースのメッセージ
  console.warn('⚠️ すべてのLLM生成試行が失敗しました。テンプレートフォールバックを使用します。');
  return generateFallbackMessage(title);
}

// =============================================================
// 📸 商品画像URL解決エンジン (楽天API & Unsplash)
// =============================================================

function extractItemCodeFromUrl(url) {
  try {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const match = cleanUrl.match(/item\.rakuten\.co\.jp\/([^\/]+)\/([^\/]+)/);
    if (match) {
      return `${match[1]}:${match[2]}`;
    }
  } catch (e) {}
  return null;
}

async function getRakutenImage(url) {
  const appId = process.env.RAKUTEN_APP_ID || process.env.RAKUTEN_APPLICATION_ID;
  if (!appId) return null;
  const itemCode = extractItemCodeFromUrl(url);
  if (!itemCode) return null;
  
  try {
    console.log(`📡 楽天APIから画像URLを取得中... (itemCode: ${itemCode})`);
    const apiUrl = `https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706`;
    const params = new URLSearchParams({
      applicationId: appId,
      itemCode: itemCode,
      format: 'json'
    });
    const res = await fetch(`${apiUrl}?${params.toString()}`);
    if (res.ok) {
      const result = await res.json();
      const item = result.Items?.[0]?.Item;
      if (item) {
        const imgUrl = item.mediumImageUrls?.[0]?.imageUrl || item.smallImageUrls?.[0]?.imageUrl;
        if (imgUrl) {
          // 画像サイズ制限クエリ(?_ex=...)を除去して本来の高画質URLを取得
          return imgUrl.split('?')[0];
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ 楽天API画像取得エラー: ${err.message}`);
  }
  return null;
}

async function getUnsplashImage(keyword) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (accessKey) {
    try {
      console.log(`📡 Unsplash APIから類似画像を検索中... (キーワード: ${keyword})`);
      const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(keyword)}&client_id=${accessKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const imgUrl = data.urls?.regular || data.urls?.small;
        if (imgUrl) return imgUrl;
      }
    } catch (err) {
      console.warn(`⚠️ Unsplash APIエラー: ${err.message}`);
    }
  }
  // 高品質なインテリア関連のフォールバック画像
  const fallbacks = [
    "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=1000",
    "https://images.unsplash.com/photo-1513694203232-719a280e022f?w=1000",
    "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=1000",
    "https://images.unsplash.com/photo-1505691938895-1758d7feb511?w=1000",
    "https://images.unsplash.com/photo-1507089947368-19c1da9775ae?w=1000"
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

async function resolveProductImage(product) {
  if (product.imageUrl) {
    console.log(`🎯 既に取得済みの画像URLを使用します: ${product.imageUrl}`);
    return product.imageUrl;
  }
  
  // 1. 楽天API経由
  const apiImage = await getRakutenImage(product.url);
  if (apiImage) {
    console.log(`🎯 楽天APIから画像を取得しました: ${apiImage}`);
    return apiImage;
  }
  
  // 2. Unsplash経由
  const keyword = product.genre || product.title || "interior";
  const unsplashImage = await getUnsplashImage(keyword);
  console.log(`🎯 Unsplashから画像を取得しました: ${unsplashImage}`);
  return unsplashImage;
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
  pendingProduct.customComment = customComment;

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

      const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
      if (ogImage) {
        pendingProduct.imageUrl = ogImage;
        console.log(`📸 楽天市場の商品ページから og:image を検出しました: ${ogImage}`);
      }

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
  const postedProducts = [];

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
      postedProducts.push({
        url: pendingProduct.url,
        title: pendingProduct.title,
        comment: pendingProduct.customComment,
        imageUrl: pendingProduct.imageUrl
      });
    }

    // 次ラウンドまで30秒間隔
    if (round < MAX_POSTS_PER_RUN - 1) {
      console.log('⏱️ 次の投稿まで30秒待機します...');
      await sleep(30000);
    }
  }

  console.log(`\n🏁 今回の実行で合計 ${postedCount} 件のコレ！を自動投稿しました！`);

  if (postedProducts.length > 0) {
    const targetProduct = postedProducts[0];
    console.log(`\n📤 Webhook経由でSNSへの自動投稿を実行します (対象: ${targetProduct.title})`);
    
    try {
      const resolvedImage = await resolveProductImage(targetProduct);
      const postText = `${targetProduct.comment || ''}\n\nhttps://room.rakuten.co.jp/jack555/items/`;
      
      console.log(`📡 Make.com Webhookへリクエストを送信中...`);
      console.log(`🖼️ 画像URL: ${resolvedImage}`);
      console.log(`📝 送信テキスト:\n${postText}`);
      
      const response = await fetch("https://hook.us1.make.com/vrank20zgvnokm5ad539yimyktnhmtqb", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          image_url: resolvedImage,
          text: postText
        })
      });
      
      if (response.ok) {
        console.log(`🎉 Webhook自動投稿の送信が完了しました！ (ステータス: ${response.status})`);
      } else {
        console.warn(`⚠️ Webhook自動投稿の送信に失敗しました (ステータス: ${response.status})`);
      }
    } catch (webhookError) {
      console.error(`❌ Webhook送信中にエラーが発生しました:`, webhookError.message);
    }
  }
}

run();
