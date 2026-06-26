// node-fetch がないかもしれないので、global.fetch (Node.js 18+) を使用します。
async function test() {
  console.log("📡 Make.com Webhookのテスト送信を開始します...");
  try {
    const response = await fetch("https://hook.us1.make.com/vrank20zgvnokm5ad539yimyktnhmtqb", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        image_url: "https://shop.r10s.jp/urbene/cabinet/chums/chums-ch62-1244_1.jpg",
        text: "テスト投稿メッセージです！ #楽天市場"
      })
    });
    console.log(`ステータス: ${response.status}`);
    const text = await response.text();
    console.log(`レスポンス: ${text}`);
  } catch (err) {
    console.error("エラー:", err);
  }
}

test();
