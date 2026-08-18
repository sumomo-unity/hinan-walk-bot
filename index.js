const express = require("express");
const line = require("@line/bot-sdk");

// ※ トークン漏洩防止のため環境変数の使用を推奨しますが、テスト用として直接記述する場合はここを書き換えてください
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};


const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

const app = express();

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// Quick Reply を返す関数
function sendStartLocationButton(replyToken) {
  return client.replyMessage({
    replyToken: replyToken,
    messages: [
      {
        type: "text",
        text: "避難開始地点を設定します。現在地を送ってください。",
        quickReply: {
          items: [
            {
              type: "action",
              action: {
                type: "location",
                label: "現在地を送る"
              }
            }
          ]
        }
      }
    ]
  });
}

// イベント処理関数
async function handleEvent(event) {
  // テキストメッセージ処理
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text;

    if (text === "スタート") {
      return sendStartLocationButton(event.replyToken);
    }

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: "受信しました！"
        }
      ]
    });
  }

  // 位置情報メッセージ処理
  if (event.type === "message" && event.message.type === "location") {
    const lat = event.message.latitude;
    const lng = event.message.longitude;

    console.log("スタート地点:", lat, lng);

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: `スタート地点を登録しました。\n緯度: ${lat}\n経度: ${lng}`
        }
      ]
    });
  }

  return Promise.resolve(null);
}

// サーバーの起動処理（これが抜けていたため起動しませんでした）
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
});
