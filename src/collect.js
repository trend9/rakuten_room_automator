import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { extractProductKey } from './sync.js';
import { execSync } from 'child_process';

dotenv.config();

// 1回の実行で最大何件を連続投稿するか（投稿頻度・件数を増加！）
const MAX_POSTS_PER_RUN = 5;
function normalizeGenreName(rawGenre) {
  if (!rawGenre) return 'その他';
  return rawGenre.replace(/\s*\(p\.\d+\)/g, '').replace(/（[0-9,〜円]+）/g, '').split(':')[0].trim();
}


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
  if (totalChars > 20 && englishChars / totalChars > 0.6) {
    console.warn(`⚠️ LLM出力reject: 英語テキストが多すぎます（英語率: ${Math.round(englishChars/totalChars*100)}%）`);
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

  // 先頭が助詞や不自然な文字で始まっている場合はreject（文頭欠落バグ防止）
  if (/^[のにはをもへとで、。・]/.test(text)) {
    console.warn(`⚠️ LLM出力reject: 文頭が不自然です（先頭: ${text.substring(0, 20)}）`);
    return null;
  }

  // 「の機能や」「の使い心地」などの主語欠落パターンを厳密にreject
  if (/^(の機能|の特徴|の魅力|のセット内容|の使い心地|の詳細は)/.test(text)) {
    console.warn(`⚠️ LLM出力reject: 主語が欠落した不完全な文です（先頭: ${text.substring(0, 30)}）`);
    return null;
  }

  // 最低60文字未満は説明不足としてreject（短文・断片文の排除）
  if (text.length < 60) {
    console.warn(`⚠️ LLM出力reject: 文字数が短すぎます（${text.length}文字）`);
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

  if (lower.includes('スイーツ') || lower.includes('ケーキ') || lower.includes('チョコ') || lower.includes('和菓子') || lower.includes('洋菓子') || lower.includes('お菓子') || lower.includes('ゼリー') || lower.includes('ティラミス')) {
    intros = [
      'お取り寄せで話題になっているスイーツです。素材の良さや丁寧な仕事っぷりが口コミにも反映されていて、自分用にもギフトにも使いやすい一品だと思います。✨🍫',
      '楽天市場で繰り返し購入されているお菓子です。一口食べると素材の馥郁さが伝わってきて、プレゼントや贈答にも喜ばれそうです。🏆🍰',
      '見た目もきれいで、味の完成度も高いお取り寄せスイーツです。ギフトとして送っても恥ずかしくない、信頼できる品質のお菓子だと思います。🎁✨',
    ];
    tagSets = [
      '#楽天市場 #お取り寄せスイーツ #ギフト #食べ物 #楽天グルメ',
      '#楽天市場 #スイーツ #お取り寄せグルメ #贈り物 #おすすめ',
    ];
  } else if (lower.includes('美顔器') || lower.includes('ドライヤー') || lower.includes('かっさ') || lower.includes('脱毛') || lower.includes('アイロン') || lower.includes('美容') || lower.includes('シェーバー') || lower.includes('マッサージ')) {
    intros = [
      'サロン通いのコストを考えると、この性能のホームケア機器は長期的に見てコスパが良いのではないかと思います。✨📊',
      '機能が本格的で、家庭用とは思えない使い心地に仕上がっている美容家電です。毎日のルーティンに取り入れる価値はあると思います。🔬⚡',
      '千件以上の口コミが集まっている人気の美容家電です。使い続けることで効果を実感できると評判のようです。🎯',
    ];
    tagSets = [
      '#楽天市場 #美容家電 #ホームケア #スキンケア #おすすめ家電',
      '#楽天市場 #美容 #エイジングケア #ヘアケア #人気家電',
    ];
  } else if (lower.includes('ロボット') || lower.includes('掃除機') || lower.includes('食洗') || lower.includes('ノンフライ') || lower.includes('炊飯') || lower.includes('冷蔵') || lower.includes('電子レンジ') || lower.includes('オーブン')) {
    intros = [
      '家事の時間をかなり削ってくれる便利家電です。導入した方から「もっと早く買えばよかった」という声も多いようで、気になっていた方にはおすすめです。⏱️🏠',
      '機能と使いやすさのバランスが取れていて、忙しい生活に本当に役立つ実用的な家電だと思います。🔧✅',
      '同価格帯の他の商品と比べてもコスパが良いと感じます。スペックと使い勝手のバランスが取れていて、選びやすい一台です。📊',
    ];
    tagSets = [
      '#楽天市場 #便利家電 #時短家電 #買ってよかった #おすすめ家電',
      '#楽天市場 #家電 #暮らし #生活 #人気家電',
    ];
  } else if (lower.includes('アウトドア') || lower.includes('キャンプ') || lower.includes('テント') || lower.includes('バーベキュー') || lower.includes('登山') || lower.includes('釣り') || lower.includes('スポーツ') || lower.includes('フィットネス') || lower.includes('トレーニング')) {
    intros = [
      '耐久性と使いやすさのバランスが良いアウトドアアイテムです。フィールドでも安心して使えそうな設計になっているようです。⛺🔥',
      'アウトドアギアは信頼性が大切だと思いますが、その点で評価が高いアイテムです。実際に使うシーンを想定した設計になっています。🏕️✅',
      '同ジャンルの他製品と比べてコスパが良いと思うところで、本格的に使い込める道具だと思います。🎣',
    ];
    tagSets = [
      '#楽天市場 #アウトドア #キャンプ #買ってよかった #おすすめギア',
      '#楽天市場 #アウトドアギア #スポーツ #フィットネス #人気',
    ];
  } else { // 家電・雑貨・その他汎用
    intros = [
      '楽天市場で評価の高い商品を探して見つけた一品です。機能・デザイン・コスパのバランスが良くて、気になっている方にはおすすめできると思います。🔍✅',
      '使い勝手が良いと口コミで広がっている商品です。素材感や作りの良さも評判のようで、実際に手にしてみる価値はあるかもしれません。📦',
      'この価格帯でこの品質は、調べれば調べるほどコスパが良いと感じる商品です。詳細は楽天市場でご確認ください。💡',
    ];
    tagSets = [
      '#楽天市場 #買ってよかった #おすすめ #楽天 #人気商品',
      '#楽天市場 #雑貨 #便利グッズ #おすすめ商品 #生活',
    ];
  }

  const ctaList = [
    '\n\n詳しいスペックや最新価格は楽天市場の商品ページで確認できます。在庫の有無も一度チェックしてみてください。',
    '\n\n実際に購入した方のレビューや最新価格は楽天市場で公開されています。購入前にチェックしてみてください。',
    '\n\n期間限定のポイント還元やクーポン情報は楽天市場の商品ページで確認できます。',
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
  const models = ["gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-3.1-flash-lite","gemini-3.1-pro","gemini-3.0-flash","gemini-2.5-pro","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.0-flash","gemini-2.0-flash-lite"];

  for (const model of models) {
    for (let attempt = 1; attempt <= 1; attempt++) {
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
                text: "あなたは楽天ROOMで商品を紹介している人の立場で、自然な丸い口調で商品の良さを伝えてください。語尾は「〜です」「〜ます」「〜かもしれません」のような温かい丁寧語で。主語が抜け落ちた断片的な文や途中で途切れた文は絶対に出力せず、最初から最後まで1つの完全な紹介文として作成してください。ギャルっぽい口調・ハート系絵文字（♡・💕・💗など）・極端な断定口調は使わないこと。必ず日本語のみで回答してください。\n\n" + prompt
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
          console.warn(`⚠️ Gemini API (${model}) Rate limit (429)。次のモデルへ切り替えます...`);
        } else {
          const errBody = await response.text().catch(() => '');
          console.warn(`⚠️ Gemini API (${model}) エラー: ${response.status} | ${errBody.substring(0, 200)}`);
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
            { role: "system", content: "あなたは楽天ROOMで商品を紹介している人の立場で、自然な丸い口調で商品の良さを伝えてください。語尾は「〜です」「〜ます」「〜かもしれません」のような温かい丁寧語で。主語が抜け落ちた断片的な文や途中で途切れた文は絶対に出力せず、最初から最後まで1つの完全な紹介文として作成してください。ギャルっぽい口調・ハート系絵文字（♡・💕・💗など）・極端な断定口調は使わないこと。必ず日本語のみで回答してください。" },
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
  // GitHub ActionsのAzure IPからはvqdトークン取得がブロックされるためスキップ
  if (process.env.GITHUB_ACTIONS === 'true') return null;
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
        signal: AbortSignal.timeout(5000)  // 短縮: 5秒
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
        signal: AbortSignal.timeout(12000)  // 短縮: 12秒
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

/** Hugging Face Inference API による生成（HF_TOKENがある場合のみ有効） */
async function generateHuggingFaceMessage(prompt) {
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  // キーなしの場合、GitHub ActionsのサーバーIPでは利用不可なためスキップ
  if (!token) return null;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
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
            { role: 'system', content: 'あなたは楽天ROOMで商品を紹介している人の立場で、自然な丸い口調で商品の良さを伝えてください。語尾は「〜です」「〜ます」「〜かもしれません」のような温かい丁寧語で。主語が抜け落ちた断片的な文や途中で途切れた文は絶対に出力せず、最初から最後まで1つの完全な紹介文として作成してください。ギャルっぽい口調・ハート系絵文字（♡・💕・💗など）・極端な断定口調は使わないこと。必ず日本語のみで回答してください。' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 500,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(12000)  // 短縮: 12秒
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

  const models = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
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
            { role: "system", content: "あなたは楽天ROOMで商品を紹介している人の立場で、自然な丸い口調で商品の良さを伝えてください。語尾は「〜です」「〜ます」「〜かもしれません」のような温かい丁寧語で。主語が抜け落ちた断片的な文や途中で途切れた文は絶対に出力せず、最初から最後まで1つの完全な紹介文として作成してください。ギャルっぽい口調・ハート系絵文字（♡・💕・💗など）・極端な断定口調は使わないこと。必ず日本語のみで回答してください。" },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 2000
        }),
        signal: AbortSignal.timeout(20000)
      });

      if (response.ok) {
        const json = await response.json();
        const content = json?.choices?.[0]?.message?.content?.trim();
        if (!content) {
          // finish_reason を確認してなぜ空か調べる
          const reason = json?.choices?.[0]?.finish_reason || 'unknown';
          const usage = json?.usage ? JSON.stringify(json.usage) : '';
          console.warn(`⚠️ Groq API (${model}): 空レスポンス (finish_reason=${reason} ${usage})`);
        }
        const cleaned = validateAndCleanLLMOutput(content);
        if (cleaned) return cleaned;
        if (content) console.warn(`⚠️ Groq API (${model}): 出力が検証に失敗 (長さ: ${content?.length ?? 0}文字, 先頭: ${content?.substring(0,80)})`);
      } else {
        const errText = await response.text().catch(() => '');
        console.warn(`⚠️ Groq API (${model}) HTTPエラー: ${response.status} ${errText.substring(0, 150)}`);
      }
    } catch (err) {
      console.warn(`⚠️ Groq API (${model}) エラー: ${err.message}`);
    }
  }
  return null;
}

/** Pollinations AI によるPOST直接通信（エラー出力を強化） */
async function generatePollinationsMessage(prompt) {
  // GitHub Actions環境では402/404が続くためスキップ
  if (process.env.GITHUB_ACTIONS === 'true') return null;
  const models = ["openai", "qwen-coder", "llama"];
  for (const model of models) {
    try {
      console.log(`🤖 キー不要の Pollinations AI (model: ${model}) でコメントを生成中...`);
      const response = await fetch("https://text.pollinations.ai/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "あなたは楽天ROOMで商品を紹介している人の立場で、自然な丸い口調で商品の良さを伝えてください。語尾は「〜です」「〜ます」「〜かもしれません」のような温かい丁寧語で。主語が抜け落ちた断片的な文や途中で途切れた文は絶対に出力せず、最初から最後まで1つの完全な紹介文として作成してください。ギャルっぽい口調・ハート系絵文字（♡・💕・💗など）・極端な断定口調は使わないこと。必ず日本語のみで回答してください。" },
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
          { role: "system", content: "あなたは楽天ROOMで商品を紹介している人の立場で、自然な丸い口調で商品の良さを伝えてください。語尾は「〜です」「〜ます」「〜かもしれません」のような温かい丁寧語で。主語が抜け落ちた断片的な文や途中で途切れた文は絶対に出力せず、最初から最後まで1つの完全な紹介文として作成してください。ギャルっぽい口調・ハート系絵文字（♡・💕・💗など）・極端な断定口調は使わないこと。必ず日本語のみで回答してください。" },
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

  const prompt = `以下の商品について、楽天ROOMに投稿する紹介コメントを書いてください。

【書き手のペルソナ】
- 男性インフルエンサー（20〜40代）
- 商品を実際に調べて選んだ目線で、機能・スペック・コスパを自然に解説するスタイル
- 読者層：男女問わず、実用品やコスパ重視で商品を探している人たち

【厳守ルール】
- 文字数は400文字以内（超えると楽天ROOMの投稿エラーになる）
- 口調：「〜です。」「〜ます。」「〜かもしれません。」「〜だと思います。」など自然な丁寧語。断定口調は使わない
- 絵文字を3〜5個使う（✅📦🔍📊⚡🏆🎯💡のような実用的な絵文字を優先）
- ⚠️ 絶対禁止：♡💕💗などのハート系絵文字
- ⚠️ 絶対禁止：「〜だよ！」「〜なんです♪」などギャル・女性語調の語尾
- ⚠️ 絶対禁止：「〜だ。」「〜なのだ。」「〜はずだ。」などの強い断定語尾
- ⚠️ 絶対禁止：「PR」「広告」の記載
- ⚠️ 絶対禁止：「[在庫確認はこちら]」などのプレースホルダー・疑似リンク・URL文字列
- ⚠️ 絶対禁止：「さらに表示」「続きを読む」等の余分な文字
- ⚠️ 絶対禁止：「売切れ」「在庫なし」の表現
- ハッシュタグを3〜5個、文末に付ける（#楽天市場 は必須）
- 商品の機能・性能・コスパのポイントを具体的に記述する
- 「の機能や〜」のように主語が抜けた不完全な文、途中で切れたような断片文は絶対に出力しないこと
- 1つの完全な紹介文章として、最初から最後まで自然に読み通せる構成にすること
- 最後は「詳細は楽天市場で確認できます」など自然な丁寧語で締める

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
    const apiUrl = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601`;
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

  // 重複防止ガード（投稿前チェック: キー照合＆タイトル照合）
  const targetKey = extractProductKey(targetUrl);
  const alreadyInHistory = data.history && data.history.some(hUrl => {
    const hKey = extractProductKey(hUrl);
    return (hKey && hKey === targetKey) || hUrl === targetUrl;
  });

  if (alreadyInHistory) {
    console.log(`⚠️ 【事前重複防止ガード】「${targetTitle}」はすでに投稿履歴(history)に存在します。0秒スキップします。`);
    pendingProduct.status = 'duplicate';
    saveQueue(data);
    return 'duplicate';
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
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        loaded = true;
      } catch (err) {
        console.warn(`⚠️ アクセス一時エラー: ${err.message}。リトライします...`);
        await page.waitForTimeout(1500);
      }
    }

    if (loaded) {
      // 動的コンテンツ読み込み待機（1.5秒に短縮）
      await page.waitForTimeout(1500);
      await takeScreenshot(page, 'step1_rakuten_loaded');

      const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
      if (ogImage) {
        pendingProduct.imageUrl = ogImage;
        console.log(`📸 楽天市場の商品ページから og:image を検出しました: ${ogImage}`);
      }
    }

    // ── ステップ2: ROOMの投稿編集画面へ遷移 ──
    // 第一選択: 楽天市場の商品ページ上の全ROOMリンクを検索
    let warpUrl = null;
    if (loaded) {
      // 全ROOMリンクを取得して数値itemcodeを持つものを優先
      const allRoomLinks = await page.locator('a[href*="room.rakuten.co.jp"]').all();
      for (const el of allRoomLinks) {
        const href = await el.getAttribute('href').catch(() => '');
        if (href && href.includes('itemcode=')) {
          // itemcodeが数値ベース（例: shop:12345）かチェック
          const codeMatch = href.match(/itemcode=([^&]+)/);
          if (codeMatch) {
            const code = decodeURIComponent(codeMatch[1]);
            const parts = code.split(':');
            // 右辺が純粋な数値のものを優先
            if (parts.length === 2 && /^d+$/.test(parts[1])) {
              warpUrl = href;
              console.log(`🎯 楽天市場の商品ページから公式ROOM投稿URLを抽出しました: ${warpUrl}`);
              break;
            } else if (!warpUrl) {
              warpUrl = href; // 数値でなくても暫定的に保持
            }
          } else if (!warpUrl && (href.includes('/mix') || href.includes('/recommend'))) {
            warpUrl = href;
          }
        }
      }
      if (warpUrl && !/itemcode=.+:d+/.test(warpUrl)) {
        console.log(`🎯 楽天市場の商品ページからROOM投稿URLを抽出しました（スラグ形式）: ${warpUrl}`);
      }
    }

    // 第二選択: 商品ページ上の「コレ！」ボタンを探してクリック→URLをキャプチャ
    if (!warpUrl && loaded) {
      try {
        const koreBtn = page.locator('a:has-text("コレ！"), button:has-text("コレ！"), a[data-ratid*="room"], a[href*="room.rakuten"]').first();
        if (await koreBtn.count() > 0) {
          const btnHref = await koreBtn.getAttribute('href').catch(() => null);
          if (btnHref && btnHref.includes('room.rakuten')) {
            warpUrl = btnHref;
            console.log(`🎯 「コレ！」ボタンのhrefからURL取得: ${warpUrl}`);
          }
        }
      } catch(e) {}
    }

    // 第三選択: 商品URLから mix?itemcode= を組み立て（数値IDが必要だがなければ試行）
    // recommend.html はエディターが描画されないため使用しない
    if (!warpUrl) {
      // 楽天APIで正しいitemcodeを取得できるか試みる
      const appId = process.env.RAKUTEN_APP_ID || process.env.RAKUTEN_APPLICATION_ID;
      const shopSlug = extractItemCodeFromUrl(targetUrl); // shop:slug形式
      if (appId && shopSlug) {
        try {
          const accessKey = (process.env.RAKUTEN_ACCESS_KEY || '').trim();
          const apiUrl = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601?applicationId=${(appId||'').trim()}&accessKey=${accessKey}&itemCode=${encodeURIComponent(shopSlug)}&format=json`;
          const res = await fetch(apiUrl, {
            headers: { 'accessKey': accessKey, 'Referer': 'https://www.rakuten.co.jp/' },
            signal: AbortSignal.timeout(10000)
          });
          if (res.ok) {
            const json = await res.json();
            const item = json.Items?.[0]?.Item;
            if (item?.itemCode) {
              // 楽天APIから正規itemcode取得 (shop:12345 形式)
              warpUrl = `https://room.rakuten.co.jp/mix?itemcode=${encodeURIComponent(item.itemCode)}&scid=we_room_upc60`;
              console.log(`✅ 楽天APIから正規itemcode取得 → ROOMエディターURL: ${warpUrl}`);
            }
          }
        } catch(e) {}
      }
      // それでも取得できなければフォールバック（試行のみ・エラーは許容）
      if (!warpUrl && shopSlug) {
        warpUrl = `https://room.rakuten.co.jp/mix?itemcode=${encodeURIComponent(shopSlug)}&scid=we_room_upc60`;
        console.log(`💡 itemcode組み立てで試行します（失敗する可能性あり）: ${warpUrl}`);
      }
    }

    console.log(`🚀 ROOMの投稿編集画面（ワープURL）へ遷移します:\n👉 ${warpUrl}`);
    let isWarpLoaded = false;
    for (let r = 0; r < 3; r++) {
      try {
        await page.goto(warpUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
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
    console.log('⏳ エディタ読み込み待機中...');
    await page.waitForTimeout(2500);
    const afterWarpUrl = page.url();
    const afterWarpTitle = await page.title().catch(() => '');
    console.log(`📍 遷移後URL: ${afterWarpUrl} | タイトル: ${afterWarpTitle}`);

    // ── URL判定: /mix/items = ROOMブラウジング画面（エディター非対応商品）→即スキップ ──
    const checkUrl = page.url();
    if (checkUrl.includes('/mix/items')) {
      console.warn(`⚠️ この商品はROOMに対応していません（/mix/items → ROOM未登録商品）。永続スキップします。`);
      pendingProduct.status = 'room_incompatible'; // failed復活ロジックの対象外
      if (!data.history.includes(pendingProduct.url)) {
        data.history.push(pendingProduct.url);
      }
      saveQueue(data);
      return 'failed';
    }
    // /mix/collect = 正規エディター ✅
    if (checkUrl.includes('/mix/collect')) {
      console.log('✅ /mix/collect エディター確認。投稿処理を続行します。');
    }
    // ログインページに飛ばされた場合のみセッション切れと判定
    const isLoginPage = checkUrl.includes('/login') || checkUrl.includes('/mypage/login') || checkUrl.includes('login.rakuten') || await page.locator('input[type="password"]').count() > 0;
    if (isLoginPage) {
      throw new Error(`セッション切れ。ログインページ(${checkUrl})にリダイレクトされました。再度 npm run auth を実行してください。`);
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
        // タイトルやキーもhistoryに確実に残す
        saveQueue(data);
        console.log(`💾 重複商品を history に記録しました (総history: ${data.history.length}件)`);
        return true;
      }
      return false;
    };

    if (await checkDuplicateModal()) {
      return 'duplicate';
    }

    // ── ステップ3: 商品名入力欄の自動穴埋め ──
    const nameInputSelector = 'input[placeholder*="商品名"], input[placeholder*="タイトル"], input[name*="title"], input[name*="name"]';
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
    // textarea / contenteditable / div[role=textbox] 全対応
    const commentAreaSelectors = [
      'textarea[placeholder*="コメント"]',
      'textarea[placeholder*="オススメ"]',
      'textarea[placeholder*="オススメポイント"]',
      'textarea[placeholder*="魅力"]',
      'textarea[placeholder*="紹介"]',
      'textarea[placeholder*="ひとこと"]',
      'textarea[placeholder*="message"]',
      'textarea',
      'div[role="textbox"]',
      '[contenteditable="true"]',
      'div[contenteditable]',
    ];
    let commentArea = null;
    let commentIsContentEditable = false;
    console.log('⏳ コメント入力欄が表示されるのを待機しています...');

    for (let attempt = 1; attempt <= 6; attempt++) {
      // 重複チェック
      if (await checkDuplicateModal()) return 'duplicate';

      for (const sel of commentAreaSelectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
          commentArea = el;
          commentIsContentEditable = sel.includes('contenteditable') || sel.includes('role="textbox"');
          console.log(`✅ コメント欄検出: セレクター="${sel}"`);
          break;
        }
      }
      if (commentArea) break;

      console.log(`⏳ コメント欄が見つかりません。リトライ中... (${attempt}/6)`);
      await page.waitForTimeout(3000);

      // デバッグ: 5回目でページのinput/textarea要素を全部ログ出力
      if (attempt === 5) {
        const debugInfo = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]'));
          return inputs.slice(0, 10).map(el => ({
            tag: el.tagName,
            type: el.type || '',
            placeholder: el.placeholder || '',
            role: el.getAttribute('role') || '',
            contenteditable: el.getAttribute('contenteditable') || '',
            visible: el.offsetParent !== null,
            id: el.id || '',
            className: el.className?.substring(0, 60) || '',
          }));
        }).catch(() => []);
        console.log('🔍 [デバッグ] 画面上の入力要素:', JSON.stringify(debugInfo, null, 2));
      }
    }

    if (!commentArea || !(await commentArea.isVisible().catch(() => false))) {
      await takeScreenshot(page, 'step4_textarea_notfound');
      // ── リカバリー: recommend.html?url= で再試行 ──
      const recoverUrl = `https://room.rakuten.co.jp/recommend/recommend.html?url=${encodeURIComponent(targetUrl)}`;
      if (!warpUrl.includes('recommend.html')) {
        console.warn(`⚠️ エディター未検出。recommend.html 方式でリカバリーします: ${recoverUrl}`);
        try {
          await page.goto(recoverUrl, { waitUntil: 'load', timeout: 50000 });
          await page.waitForTimeout(4000);
          // 重複チェック再実行
          if (await checkDuplicateModal()) return 'duplicate';
          // 再度コメント欄を探す
          for (const sel of commentAreaSelectors) {
            const el = page.locator(sel).first();
            if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
              commentArea = el;
              commentIsContentEditable = sel.includes('contenteditable') || sel.includes('role="textbox"');
              console.log(`✅ [リカバリー] コメント欄検出: "${sel}"`);
              break;
            }
          }
        } catch(recErr) {
          console.warn(`⚠️ リカバリー遷移失敗: ${recErr.message}`);
        }
      }
      if (!commentArea || !(await commentArea.isVisible().catch(() => false))) {
        throw new Error('コメント入力欄が表示されませんでした。楽天ROOMのUI変更の可能性があります（デバッグ画像: step4_textarea_notfound.png）');
      }
    }

    if (!customComment || customComment.trim() === '') {
      throw new Error('紹介コメントが空です。投稿を中止します。');
    }

    console.log('✍️ 独自のおすすめメッセージをReactセッター経由で確実に入力します...');
    await commentArea.focus();
    await commentArea.click({ force: true }).catch(() => {});
    if (commentIsContentEditable) {
      // contenteditable の場合は execCommand or innerText で入力
      await commentArea.evaluate((el, val) => {
        el.focus();
        el.innerText = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, customComment);
    } else {
      // textarea の場合は React nativeSetter
      await commentArea.evaluate((el, val) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(el, val);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, customComment);
    }
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

    // 投稿完了ボタンの検出とクリック
    const submitSelectors = [
      'button:has-text("完了")',
      'a:has-text("完了")',
      'button:has-text("投稿")',
      'button:has-text("コレ！")',
      'button[type="submit"]',
      'button[class*="submit"]',
      'button[class*="post"]',
      '.submit-button',
      '.post-button'
    ];
    let posted = false;

    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        await takeScreenshot(page, 'step6_before_click');
        await btn.click({ force: true });
        console.log(`🎉 コレ！の自動投稿ボタンをクリックしました！ (selector: ${sel})`);
        posted = true;
        break;
      }
    }

    if (!posted) {
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
      console.warn('❌ 投稿完了の確認が取れませんでした（画面が遷移していません）。未投稿として処理します。');
      pendingProduct.status = 'failed';
      saveQueue(data);
      return 'failed';
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
  const postedGenres = new Set();
  const postedShops = new Set();
  const postedTitles = [];
  let duplicateSkipCount = 0;
  const MAX_DUPLICATE_SKIPS_PER_RUN = 5; // 1回の実行で重複スキップは最大5件までに抑えてタイムアウトを完全防止

  // 実行開始時に全failedを pending に復活させる（room_incompatible以外）
  {
    const data = loadQueue();
    let revived = 0;
    data.queue.forEach(p => {
      // 'failed' のみ復活。room_incompatibleは永続スキップ
      if (p.status === 'failed' && p.status !== 'room_incompatible') {
        p.status = 'pending';
        revived++;
      }
    });
    if (revived > 0) {
      saveQueue(data);
      console.log(`💡 ${revived} 件の failed 商品を pending に復活させました。`);
    }
  }

    const MIN_SUCCESS_REQUIRED = 2; // 最低2件成功するまで絶対に諦めずリサーチ＆コレ！をループ
  const TARGET_POSTS_PER_RUN = 5; // 最大5件コレ！
  const startTime = Date.now();
  const MAX_LOOP_TIME_MS = 15 * 60 * 1000; // 安全タイムリミット: 15分（いいね・コメント・保存の時間を確保）

  let consecutiveResearchFails = 0;

  while (postedCount < TARGET_POSTS_PER_RUN) {
    // タイムアウト防衛（15分経過＆最低2件達成していれば次へ進む）
    const elapsed = Date.now() - startTime;
    // 最低2件成功するまで粘る（ただし全体タイムアウト25分を防ぐため18分で安全脱出）
    if (postedCount >= 2 || (postedCount >= 1 && elapsed > 18 * 60 * 1000)) {
      if (postedCount >= 2) {
        // 2件以上成功していればそのまま5件目指すか安全に進む
      }
      if (elapsed > 18 * 60 * 1000) {
        console.log(`⏱️ コレ！実行時間が18分を経過し、${postedCount} 件コレ！に成功しているため、いいね・コメント巡回へ進みます。`);
        break;
      }
    }

    let data = loadQueue();
    const availablePending = data.queue.filter(p => p.status === 'pending' && !skippedUrls.has(p.url));

    // 🚨 1実行1ジャンル1個の厳格分散ルールで次の商品を選択
    let pendingProduct = availablePending.find(p => {
      const shop = p.url?.split('item.rakuten.co.jp/')?.[1]?.split('/')?.[0] || '';
      const genre = normalizeGenreName(p.genre);
      const titlePrefix = p.title?.substring(0, 12) || '';

      const isSameGenre = genre && postedGenres.has(genre);
      const isSameShop = shop && postedShops.has(shop);
      const words = (p.title || '').replace(/【[^】]+】/g, '').trim().split(/[\s・／/]+/);
      const isSimilarTitle = postedTitles.some(t => {
        if (!t) return false;
        if (titlePrefix && (t.includes(titlePrefix) || titlePrefix.includes(t))) return true;
        return words.some(w => w.length >= 4 && t.includes(w));
      });

      return !isSameGenre && !isSameShop && !isSimilarTitle;
    });

    // 候補がなければリサーチを実行して新商品を即座に補充
    if (!pendingProduct) {
      console.log(`🔄 投稿可能な新ジャンル商品が不足しています（現在成功: ${postedCount}/${TARGET_POSTS_PER_RUN}件）。即座にリサーチを実行して新商品を補充します...`);
      try {
        execSync('node src/research.js', { stdio: 'inherit' });
        data = loadQueue();
        const refreshedPending = data.queue.filter(p => p.status === 'pending' && !skippedUrls.has(p.url));
        pendingProduct = refreshedPending.find(p => {
          const shop = p.url?.split('item.rakuten.co.jp/')?.[1]?.split('/')?.[0] || '';
          const genre = normalizeGenreName(p.genre);
          const titlePrefix = p.title?.substring(0, 12) || '';
          return !postedGenres.has(genre) && !postedShops.has(shop) && !postedTitles.some(t => t && titlePrefix && (t.includes(titlePrefix) || titlePrefix.includes(t)));
        });

        // 厳格分散で見つからない場合でも、ショップ・類似タイトルが被らなければ許容
        if (!pendingProduct) {
          pendingProduct = refreshedPending.find(p => {
            const shop = p.url?.split('item.rakuten.co.jp/')?.[1]?.split('/')?.[0] || '';
            const titlePrefix = p.title?.substring(0, 12) || '';
            return !postedShops.has(shop) && !postedTitles.some(t => t && titlePrefix && (t.includes(titlePrefix) || titlePrefix.includes(t)));
          });
        }
      } catch (err) {
        console.warn('⚠️ 自動リサーチ実行エラー:', err.message);
        consecutiveResearchFails++;
        if (consecutiveResearchFails >= 5 && postedCount >= MIN_SUCCESS_REQUIRED) {
          console.log(`⚠️ リサーチが連続失敗しましたが、${postedCount} 件コレ！に成功しているため巡回へ進みます。`);
          break;
        }
      }
    }

    if (!pendingProduct) {
      console.log(`⏳ 候補が一時的に見つかりません。5秒待機して再探索します... (現在成功: ${postedCount}/${TARGET_POSTS_PER_RUN}件)`);
      await sleep(5000);
      continue;
    }

    console.log(`\n━━━ コレ！試行 (${postedCount + 1}/${TARGET_POSTS_PER_RUN}件目 挑戦中) ━━━`);
    const result = await postOneProduct(pendingProduct, data);

    if (result === 'posted') {
      postedCount++;
      consecutiveResearchFails = 0;
      const shop = pendingProduct.url?.split('item.rakuten.co.jp/')?.[1]?.split('/')?.[0] || '';
      if (pendingProduct.genre) postedGenres.add(normalizeGenreName(pendingProduct.genre));
      if (shop) postedShops.add(shop);
      if (pendingProduct.title) postedTitles.push(pendingProduct.title.substring(0, 15));

      postedProducts.push({
        url: pendingProduct.url,
        title: pendingProduct.title,
        comment: pendingProduct.customComment,
        imageUrl: pendingProduct.imageUrl,
        roomUrl: pendingProduct.roomUrl
      });

      console.log(`🎉 コレ！成功！現在 ${postedCount}/${TARGET_POSTS_PER_RUN} 件完了`);

      if (postedCount < TARGET_POSTS_PER_RUN) {
        console.log('⏱️ 次の投稿まで20秒待機します...');
        await sleep(20000);
      }
    } else if (result === 'duplicate') {
      console.log(`⏭️ 「${pendingProduct.title.substring(0, 30)}...」は重複のためスキップ。即座に別の商品を探します。`);
      skippedUrls.add(pendingProduct.url);
      if (pendingProduct.genre) postedGenres.add(normalizeGenreName(pendingProduct.genre));
      if (pendingProduct.title) postedTitles.push(pendingProduct.title.substring(0, 15));
      await sleep(2000);
    } else {
      console.log(`⚠️ 投稿失敗。即座に次の商品を試みます。`);
      skippedUrls.add(pendingProduct.url);
      await sleep(2000);
    }
  }

  console.log(`\n🏁 今回の実行で合計 ${postedCount} 件のコレ！を新規自動投稿しました！`);

  // SNS Webhookは廃止（楽天ROOMへのコレ！・いいね・コメントに専念）
}

run();
