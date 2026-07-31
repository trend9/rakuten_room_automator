import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { extractProductKey } from './sync.js';

dotenv.config();

// 1回の実行で最大何件を連続投稿するか（投稿頻度・件数を増加！）
const MAX_POSTS_PER_RUN = 5;

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
// 💡 LLM高CTA文章生成エンジン
// =============================================================

/**
 * LLM出力のバリデーション＆クリーニング
 * 英語テキスト、reasoning、プレースホルダー、マークダウンなどを検出して除去・reject
 */
function validateAndCleanLLMOutput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();

  // マークダウンのコードブロックを除去
  text = text.replace(/```[\s\S]*?```/g, '').trim();
  // 先頭の「コメント本文：」のようなラベル行を除去
  text = text.replace(/^(コメント本文[：:]?\s*)/i, '').trim();
  // 先頭・末尾の引用符やバッククォートを除去
  text = text.replace(/^["`']+|["`']+$/g, '').trim();

  // []付きプレースホルダーを除去
  text = text.replace(/\[[^\]]*(?:リンク|こちら|レビュー|口コミ|確認|クリック)[^\]]*\]/g, '').trim();
  // URL文字列を除去
  text = text.replace(/https?:\/\/\S+/g, '').trim();
  // 「さらに表示」「続きを読む」を除去
  text = text.replace(/さらに表示|続きを読む/g, '').trim();
  // 連続改行を整理
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // ── reject条件 ──
  // 英語が50%以上 → LLMのreasoning漏れ
  const ascii = text.replace(/[\s\d#@!？！♪♡✨🌟💕🥰😍🎉💖🌸🛁🍃⚠️\p{Emoji}]/gu, '');
  const englishChars = (ascii.match(/[a-zA-Z]/g) || []).length;
  const totalChars = ascii.length;
  if (totalChars > 20 && englishChars / totalChars > 0.4) {
    console.warn('⚠️ LLM出力reject: 英語テキストが多すぎます（reasoning漏れの可能性）');
    return null;
  }

  // 明らかなreasoning/内部思考の検出
  const reasoningPatterns = [
    /^(We need to|Let me|I need to|I'll|I will|First,|Here's|Here is|The product|This is a)/i,
    /^(Okay|Sure|Alright|Now|So,|Well)/i,
    /\b(reasoning|thinking|analysis|approach|strategy|consider)\b/i,
    /role.*assistant/i,
    /\{"role"/,
  ];
  for (const pat of reasoningPatterns) {
    if (pat.test(text)) {
      console.warn(`⚠️ LLM出力reject: reasoning漏れを検出 (pattern: ${pat})`);
      return null;
    }
  }

  // 「売切れ」「在庫なし」を除去
  text = text.replace(/売切れ|在庫なし|品切れ中/g, '').trim();

  // 400文字制限
  if (text.length > 400) {
    // ハッシュタグの前で切る
    const hashIdx = text.lastIndexOf('#', 400);
    if (hashIdx > 200) {
      text = text.substring(0, hashIdx).trim() + '\n\n' + text.substring(hashIdx).split('\n')[0];
    }
    text = text.substring(0, 400);
  }

  // 最低30文字なければreject
  if (text.length < 30) {
    console.warn('⚠️ LLM出力reject: 文字数が短すぎます');
    return null;
  }

  // #楽天市場 が含まれていなければ追加
  if (!text.includes('#楽天市場')) {
    text = text.trimEnd() + '\n\n#楽天市場';
  }

  return text.substring(0, 400);
}

/** フォールバック用スマート文章生成（タイトルからジャンルを自動判別し、適切な高品質文を作成） */
function generateFallbackMessage(title) {
  const cleanTitle = title
    .replace(/【[^】]+】/g, '')
    .replace(/＼[^／]+／/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const lower = cleanTitle.toLowerCase();
  
  let intros = [];
  let tagSets = [];

  if (lower.includes('スイーツ') || lower.includes('ケーキ') || lower.includes('チョコ') || lower.includes('和菓子') || lower.includes('洋菓子') || lower.includes('ギフト') || lower.includes('お菓子') || lower.includes('ゼリー') || lower.includes('ティラミス')) {
    intros = [
      'SNSで話題のお取り寄せ絶品スイーツを発見！一口食べるだけで至福のご褒美タイムになっちゃいますカフェ気分をおうちで味わえる贅沢な逸品✨',
      '見た目も華やかでギフトや手土産に大人気！食べるのがもったいないくらい素敵なおすすめスイーツですお茶うけやプレゼントにもぴったり♪',
      '自分へのご褒美に絶対食べたい贅沢スイーツ✨濃厚な味わいと上品な甘さがたまらなくて、一度食べたら病みつきになります！',
    ];
    tagSets = [
      '#楽天市場 #お取り寄せスイーツ #ご褒美スイーツ #ギフトにおすすめ #スイーツ部',
      '#楽天市場 #自分へのご褒美 #絶品スイーツ #洋菓子 #おうちカフェ',
    ];
  } else if (lower.includes('美顔器') || lower.includes('ドライヤー') || lower.includes('かっさ') || lower.includes('脱毛') || lower.includes('アイロン') || lower.includes('美容') || lower.includes('シェーバー') || lower.includes('マッサージ')) {
    intros = [
      'おうちで本格サロン級ケアができる大注目美容家電✨毎日のセルフケアが楽しみになる、手放せない本命アイテムです！',
      'SNSや美容雑誌で話題沸騰中！使うたびに気分が上がって、日々のエイジングケア・美髪ケアに本気でおすすめしたい逸品です💇‍♀️',
      '忙しい毎日でも手軽にキレイを目指せる高機能美容アイテム✨自分への投資や大切な方へのプレゼントにも大人気です！',
    ];
    tagSets = [
      '#楽天市場 #美容家電 #セルフケア #自分へのご褒美 #美容好きと繋がりたい',
      '#楽天市場 #おうちサロン #美髪ケア #エイジングケア #人気家電',
    ];
  } else { // 家電・便利グッズ・汎用
    intros = [
      '毎日の暮らしがもっと快適＆便利になる大人気アイテム✨使い勝手バツグンで、生活の質がグッと上がるおすすめ家電・名品です！',
      'SNSでも高評価続出！デザインも機能性も兼ね備えた、買って大正解な便利アイテムです時短にもなって本当に大助かり😊',
      'おうち時間を最高に快適にしてくれる便利グッズ✨一度使ったら手放せなくなる、満足度バツグンの注目の商品です！',
    ];
    tagSets = [
      '#楽天市場 #便利家電 #暮らしを整える #買ってよかった #便利グッズ',
      '#楽天市場 #おうち時間 #買ってよかったもの #おすすめ家電 #生活を豊かに',
    ];
  }

  const ctaList = [
    '\n\n⚠️ 大人気のため売り切れ注意。リアルタイムな在庫状況やお得な限定クーポンは今すぐ楽天市場公式ページで確認してね👇',
    '\n\n🎁 最新の割引クーポンやお得なポイント還元情報は楽天市場公式ページで公開中！損する前にチェックして👇✨',
    '\n\n💬 実際の愛用者レビューや最新価格は楽天市場公式ページで今すぐチェックできます！👇🔗',
  ];

  const intro = intros[Math.floor(Math.random() * intros.length)];
  const cta   = ctaList[Math.floor(Math.random() * ctaList.length)];
  const tags  = tagSets[Math.floor(Math.random() * tagSets.length)];

  return `${intro}\n\n${cleanTitle.substring(0, 65)}...${cta}\n\n${tags}`.substring(0, 395);
}

/** Gemini API による生成 (複数モデル自動フォールバック & レート制限429リトライ機能付き) */
async function generateGeminiMessage(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // 利用可能なモデル一覧（404エラーを防止し最新モデルを最優先）
  const models = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash-8b"];

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`🤖 GEMINI_API_KEY検出。Gemini API (${model}) でコメントを生成中... (試行 ${attempt}/2)`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: "あなたは楽天ROOMでフォロワー急増中の大人気インフルエンサーです。思わず食べたくなる絶品スイーツや、暮らしを劇的に変える便利家電、憧れの美容家電の魅力を、上品でワクワクする日本語のみで執筆してください。売り切れ間近の限定感や最新人気ポイントをアピールしてください。\n\n" + prompt
              }]
            }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 500
            }
          }),
          signal: AbortSignal.timeout(20000)
        });

        if (response.ok) {
          const json = await response.json();
          const content = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          const cleaned = validateAndCleanLLMOutput(content);
          if (cleaned) return cleaned;
          console.warn(`⚠️ Gemini API (${model}): 出力がバリデーションに失敗しました`);
        } else if (response.status === 429) {
          console.warn(`⚠️ Gemini API (${model}) Rate limit (429)。5秒待機してリトライします...`);
          await sleep(5000);
        } else {
          console.warn(`⚠️ Gemini API (${model}) エラー: ${response.status}`);
          break; // 429以外のエラーはモデル変更
        }
      } catch (err) {
        console.warn(`⚠️ Gemini API (${model}) 呼び出し中にエラーが発生しました: ${err.message}`);
      }
    }
  }
  return null;
}

/** OpenRouter Free API による生成 (OPENROUTER_API_KEY が必要) */
async function generateOpenRouterMessage(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null; // キーなしでは動作しないためスキップ

  const models = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-2-9b-it:free",
    "deepseek/deepseek-r1:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "mistralai/mistral-7b-instruct:free"
  ];

  for (const model of models) {
    try {
      console.log(`🤖 OPENROUTER_API_KEY検出。OpenRouter Free API (model: ${model}) でコメントを生成中...`);
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/rakuten-room-automator",
          "X-Title": "Rakuten Room Automator"
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: "あなたは楽天ROOMでフォロワー急増中の大人気インフルエンサーです。思わず買いたくなる魅力を上品でワクワクする日本語のみで執筆してください。" },
            { role: "user", content: prompt }
          ],
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(20000)
      });

      if (response.ok) {
        const json = await response.json();
        const content = json?.choices?.[0]?.message?.content?.trim();
        const cleaned = validateAndCleanLLMOutput(content);
        if (cleaned) {
          console.log(`✅ OpenRouter (${model}) 成功`);
          return cleaned;
        }
      } else {
        const errBody = await response.text().catch(() => '');
        console.warn(`⚠️ OpenRouter API (${model}) エラー: ${response.status} ${errBody.substring(0, 100)}`);
      }
    } catch (err) {
      console.warn(`⚠️ OpenRouter API (${model}) エラー: ${err.message}`);
    }
  }
  return null;
}

/** DuckDuckGo AI Chat による生成（キー不要・完全無料） */
async function generateDuckDuckGoMessage(prompt) {
  // DuckDuckGo AI Chat公式API（キー不要）
  const models = ['gpt-4o-mini', 'claude-3-haiku-20240307', 'meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1'];
  for (const model of models) {
    try {
      console.log(`🤖 DuckDuckGo AI Chat (${model}) でコメントを生成中...`);
      // まずvqdトークンを取得
      const statusRes = await fetch('https://duckduckgo.com/duckchat/v1/status', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'x-vqd-accept': '1'
        },
        signal: AbortSignal.timeout(10000)
      });
      const vqd = statusRes.headers.get('x-vqd-4');
      if (!vqd) { console.warn('⚠️ DuckDuckGo: vqdトークン取得失敗'); continue; }

      const chatRes = await fetch('https://duckduckgo.com/duckchat/v1/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'x-vqd-4': vqd,
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!chatRes.ok) { console.warn(`⚠️ DuckDuckGo (${model}): ${chatRes.status}`); continue; }

      const text = await chatRes.text();
      // SSEストリームからメッセージを組み立て
      let fullMsg = '';
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const obj = JSON.parse(data);
          fullMsg += obj?.message || '';
        } catch {}
      }
      const cleaned = validateAndCleanLLMOutput(fullMsg);
      if (cleaned) {
        console.log(`✅ DuckDuckGo AI (${model}) 成功`);
        return cleaned;
      }
    } catch (err) {
      console.warn(`⚠️ DuckDuckGo AI (${model}) エラー: ${err.message}`);
    }
  }
  return null;
}

/** Hugging Face Inference API による生成（無料・HF_TOKENが有れば高速） */
async function generateHuggingFaceMessage(prompt) {
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // キー無しでもレート制限付きで動作するモデルを使用
  const models = [
    'mistralai/Mistral-7B-Instruct-v0.3',
    'HuggingFaceH4/zephyr-7b-beta',
    'meta-llama/Llama-3.2-3B-Instruct',
  ];
  const label = token ? 'HF_TOKEN検出' : 'キー不要';
  for (const model of models) {
    try {
      console.log(`🤖 ${label}。Hugging Face Inference (${model}) でコメントを生成中...`);
      const res = await fetch(`https://api-inference.huggingface.co/models/${model}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: 'あなたは楽天ROOMのインフルエンサーです。商品の魅力を上品でワクワクする日本語のみで書いてください。' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 500,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (res.ok) {
        const json = await res.json();
        const content = json?.choices?.[0]?.message?.content?.trim();
        const cleaned = validateAndCleanLLMOutput(content);
        if (cleaned) {
          console.log(`✅ Hugging Face (${model}) 成功`);
          return cleaned;
        }
      } else if (res.status === 503) {
        console.warn(`⚠️ Hugging Face (${model}): モデルロード中 (503)、スキップ`);
      } else {
        console.warn(`⚠️ Hugging Face (${model}): ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Hugging Face (${model}) エラー: ${err.message}`);
    }
  }
  return null;
}

/** Groq API による生成 (GROQ_API_KEYを使用、超高速＆完全無料枠大) */
async function generateGroqMessage(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const models = ["llama-3.3-70b-versatile", "mixtral-8x7b-32768", "gemma2-9b-it"];
  for (const model of models) {
    try {
      console.log(`🤖 GROQ_API_KEY検出。Groq API (${model}) でコメントを生成中...`);
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: "あなたは楽天ROOMでフォロワー急増中の大人気インフルエンサーです。思わず買いたくなる魅力を上品でワクワクする日本語のみで執筆してください。" },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 500
        }),
        signal: AbortSignal.timeout(20000)
      });

      if (response.ok) {
        const json = await response.json();
        const content = json?.choices?.[0]?.message?.content?.trim();
        const cleaned = validateAndCleanLLMOutput(content);
        if (cleaned) return cleaned;
      }
    } catch (err) {
      console.warn(`⚠️ Groq API (${model}) エラー: ${err.message}`);
    }
  }
  return null;
}

/** Pollinations AI によるPOST直接通信（エラー出力を強化） */
async function generatePollinationsMessage(prompt) {
  const models = ["openai", "qwen-coder", "llama"];
  for (const model of models) {
    try {
      console.log(`🤖 キー不要の Pollinations AI (model: ${model}) でコメントを生成中...`);
      const response = await fetch("https://text.pollinations.ai/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "あなたは楽天ROOMのインフルエンサーです。商品の魅力を親しみやすい日本語のみで書いてください。" },
            { role: "user", content: prompt }
          ],
          model: model,
          private: true
        }),
        signal: AbortSignal.timeout(30000)
      }).catch(() => null);

      if (response && response.ok) {
        const text = await response.text().catch(() => null);
        const cleaned = validateAndCleanLLMOutput(text);
        if (cleaned) {
          console.log(`✅ Pollinations AI (${model}) 成功`);
          return cleaned;
        }
      } else if (response) {
        console.warn(`⚠️ Pollinations AI (${model}) エラー: ${response.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Pollinations AI (${model}) エラー: ${err.message}`);
    }
  }
  return null;
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
          { role: "system", content: "あなたは楽天ROOMでフォロワー急増中の大人気インフルエンサーです。思わず買いたくなる魅力を上品でワクワクする日本語のみで執筆してください。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (response.ok) {
      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content?.trim();
      const cleaned = validateAndCleanLLMOutput(content);
      if (cleaned) return cleaned;
      console.warn('⚠️ GitHub Models: 出力がバリデーションに失敗しました');
    } else {
      console.warn(`⚠️ GitHub Models APIエラー: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`⚠️ GitHub Models API呼び出し中にエラーが発生しました: ${err.message}`);
  }
  return null;
}

/**
 * 多層LLMプロバイダ自動フォールバックチェーン
 * 1つが失敗・未定義・例外を起こしても絶対に全体クラッシュさせず、確実に最後までバトンを繋ぐ
 */
async function generateLLMMessage(title) {
  const cleanTitle = title
    .replace(/【[^】]+】/g, '')
    .replace(/＼[^／]+／/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const prompt = `あなたは楽天ROOMでフォロワー急増中の大人気インフルエンサーです。
以下の商品を、18〜40代の女性・主婦に向けて、思わずクリックしたくなる日本語紹介コメントを書いてください。

【厳守ルール】
- 文字数は400文字以内（楽天ROOMの文字数制限。超えると投稿エラーになる）
- 語尾は話し言葉で親しみやすく（「〜だよ！」「〜なんです♪」など）
- 宣伝と分からないよう自然に書く（「PR」「広告」禁止）
- 絵文字を5〜8個使う
- ハッシュタグを3〜5個、文末に付ける（#楽天市場 は必須。商品の種類に合ったもの）
- 商品の魅力・驚き・使い勝手・満足感を具体的に書く
- 「人気沸騰中」「在庫わずか」など購買意欲を上げる一文で締める
- ⚠️ 絶対禁止：「[楽天ROOM商品ページへのリンク]」「[在庫確認はこちら]」などのプレースホルダーや疑似リンクを書かない
- ⚠️ 絶対禁止：URL文字列を本文中に書かない
- ⚠️ 絶対禁止：「さらに表示」「続きを読む」等の余分な文字
- ⚠️ 絶対禁止：「売切れ」「在庫なし」の表現

【商品名】
${cleanTitle.substring(0, 100)}

【コメント本文のみを出力。前置き・タイトル行・\`\`\`マークダウン装飾は絶対に不要】`;

  // ─────────────────────────────────────────────
  // 1. Groq API（完全無料・超高速・30req/min制限）
  // ─────────────────────────────────────────────
  try {
    const groqResult = await generateGroqMessage(prompt);
    if (groqResult) {
      console.log(`🎉 LLM (Groq API) 生成成功！(${groqResult.length}文字)`);
      return groqResult.substring(0, 400);
    }
  } catch (e) {
    console.warn(`⚠️ Groq API 処理エラー: ${e.message}`);
  }

  // ─────────────────────────────────────────────
  // 2. OpenRouter Free API（OPENROUTER_API_KEY要）
  // ─────────────────────────────────────────────
  try {
    const openRouterResult = await generateOpenRouterMessage(prompt);
    if (openRouterResult) {
      console.log(`🎉 LLM (OpenRouter Free API) 生成成功！(${openRouterResult.length}文字)`);
      return openRouterResult.substring(0, 400);
    }
  } catch (e) {
    console.warn(`⚠️ OpenRouter Free API 処理エラー: ${e.message}`);
  }

  // ─────────────────────────────────────────────
  // 3. Gemini API（429頻発のため後回し）
  // ─────────────────────────────────────────────
  try {
    const geminiResult = await generateGeminiMessage(prompt);
    if (geminiResult) {
      console.log(`🎉 LLM (Gemini API) 生成成功！(${geminiResult.length}文字)`);
      return geminiResult.substring(0, 400);
    }
  } catch (e) {
    console.warn(`⚠️ Gemini API 処理エラー: ${e.message}`);
  }

  // ─────────────────────────────────────────────
  // 4. GitHub Models API（GITHUB_TOKEN要）
  // ─────────────────────────────────────────────
  try {
    const ghResult = await generateGitHubModelsMessage(prompt);
    if (ghResult) {
      console.log(`🎉 LLM (GitHub Models) 生成成功！(${ghResult.length}文字)`);
      return ghResult.substring(0, 400);
    }
  } catch (e) {
    console.warn(`⚠️ GitHub Models 処理エラー: ${e.message}`);
  }

  // ─────────────────────────────────────────────
  // 5. DuckDuckGo AI Chat（キー不要・SSEストリーム）
  // ─────────────────────────────────────────────
  try {
    const ddgResult = await generateDuckDuckGoMessage(prompt);
    if (ddgResult) {
      console.log(`🎉 LLM (DuckDuckGo AI) 生成成功！(${ddgResult.length}文字)`);
      return ddgResult.substring(0, 400);
    }
  } catch (e) {
    console.warn(`⚠️ DuckDuckGo AI 処理エラー: ${e.message}`);
  }

  // ─────────────────────────────────────────────
  // 6. Hugging Face Inference API（キー不要でも動作）
  // ─────────────────────────────────────────────
  try {
    const hfResult = await generateHuggingFaceMessage(prompt);
    if (hfResult) {
      console.log(`🎉 LLM (Hugging Face) 生成成功！(${hfResult.length}文字)`);
      return hfResult.substring(0, 400);
    }
  } catch (e) {
    console.warn(`⚠️ Hugging Face 処理エラー: ${e.message}`);
  }

  // ─────────────────────────────────────────────
  // 7. Pollinations AI（キー不要・最終手段）
  // ─────────────────────────────────────────────
  try {
    const polResult = await generatePollinationsMessage(prompt);
    if (polResult) {
      console.log(`🎉 LLM (Pollinations AI) 生成成功！(${polResult.length}文字)`);
      return polResult.substring(0, 400);
    }
  } catch (e) {
    console.warn(`⚠️ Pollinations AI 処理エラー: ${e.message}`);
  }

  // 6. 最終防衛線: カテゴリ別スマートフォールバック
  console.warn('⚠️ すべてのLLM生成が一時的に使用不能のため、安全なカテゴリ別スマート文章を使用します。');
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

async function scrapeRakutenProductImage(productUrl) {
  // 楽天商品ページから直接OGP/商品画像をスクレイピングする
  try {
    console.log(`🖼️ 楽天商品ページから画像を直接スクレイピング中... (${productUrl})`);
    const res = await fetch(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // OGPイメージを最優先で取得
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]) {
      const imgUrl = ogMatch[1].split('?')[0];
      console.log(`🎯 OGP画像を取得しました: ${imgUrl}`);
      return imgUrl;
    }

    // tshop.r10s.jp の商品画像URL
    const r10Match = html.match(/https:\/\/(?:tshop|shop)\.r10s\.jp\/[^"'\s,>]+\.(?:jpg|jpeg|png|webp)/i);
    if (r10Match?.[0]) {
      const imgUrl = r10Match[0].split('?')[0];
      console.log(`🎯 楽天商品画像を取得しました: ${imgUrl}`);
      return imgUrl;
    }
  } catch (err) {
    console.warn(`⚠️ 楽天ページ画像スクレイピングエラー: ${err.message}`);
  }
  return null;
}

async function resolveProductImage(product) {
  // 1. queue.jsonに保存済みの楽天商品画像を最優先で使用（unsplashかどうか確認）
  if (product.imageUrl && !product.imageUrl.includes('unsplash')) {
    console.log(`🎯 queue.jsonの保存済み画像を使用します: ${product.imageUrl}`);
    return product.imageUrl;
  }

  // 2. 楽天API経由（appIdがある場合のみ）
  const apiImage = await getRakutenImage(product.url);
  if (apiImage) {
    console.log(`🎯 楽天APIから画像を取得しました: ${apiImage}`);
    return apiImage;
  }

  // 3. 楽天商品ページから直接スクレイピング（APIキー不要）
  const scraped = await scrapeRakutenProductImage(product.url);
  if (scraped) {
    console.log(`🎯 OGPスクレイピングで画像を取得しました: ${scraped}`);
    return scraped;
  }

  // 4. 画像が一切取得できない場合はnullを返す（Unsplashは使わない）
  console.warn(`⚠️ 商品画像の取得に失敗しました。SNSの画像はスキップします。`);
  return null;
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
    return 'duplicate'; // 重複スキップ
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
    // navigator.webdriver 等のボット防止用偽装を注入
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['ja', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });
    const page = await context.newPage();

    // ── ステップ1: 楽天市場へ事前アクセス（クッキー活性化 ＆ 動的URL抽出のため） ──
    console.log('🌐 楽天市場の商品ページにアクセスしています（クッキー活性化＆動的URL抽出のため）...');
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

    if (loaded) {
      await page.waitForTimeout(2000);
      await takeScreenshot(page, 'step1_rakuten_loaded');

      const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
      if (ogImage) {
        pendingProduct.imageUrl = ogImage;
        console.log(`📸 楽天市場の商品ページから og:image を検出しました: ${ogImage}`);
      }
    }

    // ── ステップ2: ROOMの投稿編集画面へ遷移 ──
    // 第一選択: 楽天市場の商品ページから「ROOMに投稿」リンク（/mix?itemcode=...）を抽出する
    let warpUrl = null;
    if (loaded) {
      const roomLinkEl = page.locator('a[href*="room.rakuten.co.jp"]').first();
      if (await roomLinkEl.count() > 0) {
        const href = await roomLinkEl.getAttribute('href') || '';
        if (href.includes('/mix') || href.includes('/recommend') || href.includes('itemcode=')) {
          warpUrl = href;
          console.log(`🎯 楽天市場の商品ページから公式ROOM投稿URLを抽出しました: ${warpUrl}`);
        }
      }
    }

    // 第二選択: 抽出できなかった場合の自動組み立てフォールバック（新形式URL）
    if (!warpUrl) {
      const itemCode = extractItemCodeFromUrl(targetUrl);
      if (itemCode) {
        warpUrl = `https://room.rakuten.co.jp/mix?itemcode=${encodeURIComponent(itemCode)}&scid=we_room_upc60`;
        console.log(`💡 商品URLから公式ROOM投稿URL（新形式）を組み立てました: ${warpUrl}`);
      } else {
        // 第三選択: 従来のrecommend.html遷移
        warpUrl = `https://room.rakuten.co.jp/recommend/recommend.html?url=${encodeURIComponent(targetUrl)}`;
        console.log(`⚠️ itemcodeの抽出に失敗したため、旧ワープURLを使用します: ${warpUrl}`);
      }
    }

    console.log(`🚀 ROOMの投稿編集画面（ワープURL）へ遷移します:\n👉 ${warpUrl}`);
    let isWarpLoaded = false;
    for (let r = 0; r < 3; r++) {
      try {
        await page.goto(warpUrl, { waitUntil: 'load', timeout: 50000 });
        isWarpLoaded = true;
        break;
      } catch (err) {
        console.warn(`⚠️ 投稿編集画面への遷移失敗 (リトライ ${r + 1}/3): ${err.message}`);
        await page.waitForTimeout(3000);
      }
    }

    if (!isWarpLoaded) {
      throw new Error('投稿編集画面のロードに失敗しました。');
    }

    // ダイアログやコンテンツの非同期表示を待つため少し待機
    console.log('⏳ エディタ読み込み後の初期待機中 (3秒)...');
    await page.waitForTimeout(3000);

    // ログインチェック（投稿エディタからトップ等の他URLへリダイレクトされていないかも含めて判定）
    const checkUrl = page.url();
    const isWarpRedirected = !checkUrl.includes('/mix') && !checkUrl.includes('/recommend') && !checkUrl.includes('/items/create');
    const isLoginNeeded = isWarpRedirected || await page.locator('text=ログイン, input[placeholder*="メール"]').count() > 0;
    if (isLoginNeeded) {
      throw new Error('セッション切れ。再度 npm run auth を実行してください。');
    }

    await takeScreenshot(page, 'step2_editor_loaded');

    // ブラウザ上の重複ダイアログチェック
    const checkDuplicateModal = async () => {
      const hasDuplicate = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3, h4'));
        return allElements.some(el => {
          const text = el.innerText || '';
          return text.includes('すでにコレしている商品です') || 
                 text.includes('すでにコレしている') ||
                 text.includes('すでに登録されています') ||
                 text.includes('すでにコレ') ||
                 text.includes('すでにコレ！');
        });
      }).catch(() => false);

      if (hasDuplicate) {
        console.log('⚠️ 【重複投稿防止】楽天ROOM側の重複ダイアログ（すでにコレ！）を検知。安全にスキップします。');
        
        // ダイアログの「OK」ボタンを確実にブラウザ側でクリックする
        const clicked = await page.evaluate(() => {
          const okBtn = Array.from(document.querySelectorAll('a, button, span')).find(el => {
            const text = el.innerText || '';
            return text.trim() === 'OK';
          });
          if (okBtn) {
            okBtn.click();
            return true;
          }
          return false;
        }).catch(() => false);

        if (clicked) {
          console.log('🆗 重複ダイアログのOKボタンをクリックしました。');
        } else {
          // Playwrightによる予備のクリック
          const fallbackOk = page.locator('a.button:has-text("OK"), button:has-text("OK"), a:has-text("OK")').first();
          if (await fallbackOk.count() > 0) {
            await fallbackOk.click({ force: true }).catch(() => {});
            console.log('🆗 (予備) 重複ダイアログのOKボタンをクリックしました。');
          }
        }
        await page.waitForTimeout(2000);
        
        pendingProduct.status = 'duplicate';
        if (!data.history.includes(pendingProduct.url)) {
          data.history.push(pendingProduct.url);
        }
        saveQueue(data);
        return true;
      }
      return false;
    };

    if (await checkDuplicateModal()) {
      return 'duplicate';
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

    // ── ステップ4: コメント入力欄が表示されるまでリトライ付きで待機 ──
    const commentAreaSelector = 'textarea[placeholder*="コメント"], textarea[placeholder*="オススメ"], textarea[placeholder*="オススメポイント"], textarea[placeholder*="魅力"], textarea[placeholder*="紹介"], textarea';
    let commentArea = null;
    console.log('⏳ コメント入力欄が表示されるのを待機しています...');
    
    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.waitForSelector(commentAreaSelector, { timeout: 10000 }).catch(() => {});
      const area = page.locator(commentAreaSelector).first();
      if (await area.count() > 0 && await area.isVisible()) {
        commentArea = area;
        break;
      }
      console.log(`⏳ コメント欄が見つかりません。リトライ中... (${attempt}/5)`);
      await page.waitForTimeout(2000);
      
      // もし重複モーダルが割り込んで出現していれば、ここで再度閉じる処理を走らせる
      if (await checkDuplicateModal()) {
        return 'duplicate';
      }
    }

    if (!commentArea) {
      // 最終手段: 画面上の全 textarea 要素から取得
      const fallbackTextareas = page.locator('textarea');
      if (await fallbackTextareas.count() > 0) {
        commentArea = fallbackTextareas.first();
        console.log('💡 汎用 textarea セレクターでコメント欄を検出しました。');
      }
    }

    if (!commentArea || !(await commentArea.isVisible())) {
      throw new Error('コメント入力欄 (textarea) が表示されませんでした。タイムアウトまたはページ構成の変更エラー。');
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

    if (await checkDuplicateModal()) {
      return 'duplicate';
    }

    // 通常の投稿ボタンクリックを試みる
    const submitBtn = page.locator('button:has-text("投稿"), button:has-text("完了"), button:has-text("コレ！"), button[class*="submit"], button[class*="post"], button[type="submit"], a:has-text("完了"), a:has-text("投稿"), a:has-text("コレ！")').first();
    let posted = false;

    if (await submitBtn.count() > 0 && await submitBtn.isVisible() && await submitBtn.isEnabled()) {
      await takeScreenshot(page, 'step6_before_click');
      await submitBtn.click({ force: true });
      console.log('🎉 コレ！の自動投稿ボタンをクリックしました！');
      posted = true;
    } else {
      // ── 🚨 核オプション: キーボード操作で「完了」を強制送信 ──
      // Playwrightのビジュアル操作の代わりに、Tabキーでフォーカスを移動してEnterキーで送信する
      console.log('⚠️ 投稿ボタンが検出できませんでした。キーボード操作（核オプション）で強制送信を試みます...');
      await commentArea.blur().catch(() => {});
      await page.waitForTimeout(500);

      // クライアント側で完了ボタンを見つけてクリック
      const nukeClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
        const btn = buttons.find(el => {
          const t = (el.innerText || el.value || '').trim();
          return t === '完了' || t === 'コレ！' || t === '投稿';
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }).catch(() => false);

      if (nukeClicked) {
        console.log('🚨 核オプション: クライアント側で「完了」ボタンをクリックしました！');
        posted = true;
      } else {
        // 最終手段: Tab連打でボタンにフォーカスを当てて Enter
        console.log('🚨 核オプション: Tabキー + Enterによる強制送信を試みます...');
        for (let tab = 0; tab < 10; tab++) {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(200);
          const focused = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el) return '';
            const t = (el.innerText || el.value || '').trim();
            return t;
          });
          if (focused === '完了' || focused === 'コレ！' || focused === '投稿') {
            await page.keyboard.press('Enter');
            console.log('🚨 核オプション: Tabで「完了」ボタンにフォーカスしてEnterを押しました！');
            posted = true;
            break;
          }
        }
      }

      if (!posted) {
        throw new Error('投稿確定ボタンが見つからず、核オプションでも失敗しました。');
      }
    }

    await page.waitForTimeout(3000);
    if (await checkDuplicateModal()) {
      return 'duplicate';
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
      console.log('⚠️ 投稿完了後の画面切り替え待ちタイムアウト。');
    });
    await page.waitForTimeout(5000);
    await takeScreenshot(page, 'step7_final_success');

    // ── ステップ6: コレ！完了確認プロセス ──
    console.log('🔍 コレ！完了確認を開妖します...');
    let isConfirmed = false;

    // 確認方法1: 現在のURLが商品詳細ページ（/room/xxx/items/ID 形式）にあるか
    const currentUrl = page.url();
    if (currentUrl.includes('/room/') && currentUrl.includes('/items/') && !currentUrl.endsWith('/items/')) {
      console.log(`✅ 確認1: 投稿後のURLが商品詳細ページに遷移しています: ${currentUrl}`);
      isConfirmed = true;
    }

    // 確認方法2: 画面に「コレ！」投稿完了のメッセージが表示されているか
    if (!isConfirmed) {
      const pageText = await page.innerText('body').catch(() => '');
      if (
        pageText.includes('コレ！しました') ||
        pageText.includes('投稿されました') ||
        pageText.includes('登録されました') ||
        pageText.includes('Roomに追加') ||
        currentUrl.includes('/room/') && currentUrl.includes('/items/')
      ) {
        console.log(`✅ 確認2: 投稿完了メッセージを検出しました。`);
        isConfirmed = true;
      }
    }

    // 確認方法3: 重複モーダルが出たら「已コレ！済み」と判定
    if (!isConfirmed) {
      if (await checkDuplicateModal()) {
        return 'duplicate';
      }
    }

    if (isConfirmed) {
      console.log('🎉 コレ！投稿完了を正式に確認しました！');
    } else {
      console.log('⚠️ 投稿完了の確認が取れませんでしたが、ボタンクリックは完了しているため成功とみなします。');
    }

    // ── 楽天ROOMの自分の商品ページURL（アフィリエイトリンク）を取得 ──
    // コレ！完了後に遷移する /room/jack555/items/XXXXXX がアフィリエイトリンク
    let roomUrl = null;
    const postUrl = page.url();
    if (postUrl.includes('room.rakuten.co.jp') && postUrl.includes('/items/') && !postUrl.endsWith('/items/') && !postUrl.endsWith('/items')) {
      roomUrl = postUrl.split('?')[0];
      console.log(`🔗 楽天ROOM商品URL（自分のアフィリエイトリンク）を取得しました: ${roomUrl}`);
    } else {
      // ページ内のリンクからROOM URLを探す
      roomUrl = await page.evaluate(() => {
        const url = window.location.href;
        if (url.includes('room.rakuten.co.jp') && url.includes('/items/')) return url.split('?')[0];
        return null;
      }).catch(() => null);
      if (roomUrl) {
        console.log(`🔗 ページ内から楽天ROOM URLを取得しました: ${roomUrl}`);
      } else {
        console.warn('⚠️ 楽天ROOM URLの取得に失敗しました。SNS投稿にはROOM URLなしで送信します。');
      }
    }

    // キューと履歴を更新
    pendingProduct.status   = 'posted';
    pendingProduct.postedAt = new Date().toISOString();
    pendingProduct.roomUrl  = roomUrl;  // ← 自分のROOM URLを保存
    // 画像がまだ保存されていない場合、ここで取得する
    if (!pendingProduct.imageUrl || pendingProduct.imageUrl.includes('unsplash')) {
      const resolvedImg = await getRakutenImage(targetUrl).catch(() => null)
        || await scrapeRakutenProductImage(targetUrl).catch(() => null);
      if (resolvedImg) {
        pendingProduct.imageUrl = resolvedImg;
        console.log(`🖼️ 商品画像を保存しました: ${resolvedImg}`);
      }
    }
    if (!data.history) data.history = [];
    data.history.push(targetUrl);
    saveQueue(data);
    console.log('💾 投稿キューと履歴を更新しました。正常終了！');
    return 'posted'; // 投稿成功

  } catch (error) {
    console.error('❌ 投稿実行中にエラーが発生しました:', error.message);
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.resolve('storage/steps/step_error_occurred.png') }).catch(() => {});
    pendingProduct.status = 'failed';
    saveQueue(data);
    return 'failed'; // 投稿失敗
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
  // 重複スキップした商品URLのセット（同ラン内での無限ループ防止）
  const skippedUrls = new Set();

  // 実行開始時に全failedを pending に復活させる（スキップ後も新しい候補が見つかるように）
  {
    const data = loadQueue();
    let revived = 0;
    data.queue.forEach(p => {
      if (p.status === 'failed') {
        p.status = 'pending';
        revived++;
      }
    });
    if (revived > 0) {
      saveQueue(data);
      console.log(`💡 ${revived} 件の failed 商品を pending に復活させました。`);
    }
  }

  for (let round = 0; round < MAX_POSTS_PER_RUN; round++) {
    const data = loadQueue();
    // スキップ済みを除いた次の pending 商品を選択
    let pendingProduct = data.queue.find(p => p.status === 'pending' && !skippedUrls.has(p.url));

    if (!pendingProduct) {
      console.log(`💡 投稿待ちの商品がありません。今回は ${postedCount} 件投稿して終了します。`);
      break;
    }

    console.log(`\n━━━ ラウンド ${round + 1}/${MAX_POSTS_PER_RUN} ━━━`);
    const result = await postOneProduct(pendingProduct, data);

    if (result === 'posted') {
      postedCount++;
      postedProducts.push({
        url: pendingProduct.url,
        title: pendingProduct.title,
        comment: pendingProduct.customComment,
        imageUrl: pendingProduct.imageUrl,
        roomUrl: pendingProduct.roomUrl  // ← 自分のROOM URL
      });
    } else if (result === 'duplicate') {
      // 重複はスキップリストに追加して次の商品へ（ラウンドを消費せずループ継続）
      console.log(`⏭️ 「${pendingProduct.title.substring(0, 30)}...」は重複のためスキップ。次の商品を探します。`);
      skippedUrls.add(pendingProduct.url);
      round--; // ラウンドを消費しない
      continue;
    }

    // 次ラウンドまで待機（投稿成功・失敗時のみ）
    if (round < MAX_POSTS_PER_RUN - 1) {
      console.log('⏱️ 次の投稿まで30秒待機します...');
      await sleep(30000);
    }
  }

  console.log(`\n🏁 今回の実行で合計 ${postedCount} 件のコレ！を新規自動投稿しました！`);

  // 実際に新規投稿に成功した商品のみを対象にする (postedProductsは success=true すなわち新規投稿成功時のみ格納される)
  if (postedProducts.length > 0) {
    const targetProduct = postedProducts[0];
    console.log(`\n📤 Webhook経由でSNSへの自動投稿を実行します (対象: ${targetProduct.title})`);
    
    try {
      const resolvedImage = await resolveProductImage(targetProduct);
      // LLMが生成したコメントをバリデーション＆クリーニング
      let cleanComment = validateAndCleanLLMOutput(targetProduct.comment);
      if (!cleanComment) {
        // バリデーション失敗時はテンプレートフォールバック
        console.warn('⚠️ SNS用コメントのバリデーション失敗。テンプレートを使用します。');
        cleanComment = generateFallbackMessage(targetProduct.title);
      }
      // ★ 重要: SNSに投稿するリンクは自分の楽天ROOM URL（アフィリエイトリンク）
      // item.rakuten.co.jp（他人の店のURL）を絶対に使ってはいけない
      let snsUrl = targetProduct.roomUrl || '';
      if (!snsUrl) {
        console.warn('⚠️ 楽天ROOM URLが取得できませんでした。固定マイページURLを使用します。');
        snsUrl = 'https://room.rakuten.co.jp/jack555/items';
      } else {
        console.log(`🔗 SNS投稿に使用するROOM URL: ${snsUrl}`);
      }
      const postText = `${cleanComment}\n\n${snsUrl}`.trim();
      
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
