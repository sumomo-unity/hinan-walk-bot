const express = require("express");
const line = require("@line/bot-sdk");

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET || ""
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

// ユーザーごとのセッション管理（メモリ保持）
// userId => { status, startLocation, startTime, goalLocation, goalTime }
const userSessions = new Map();

/**
 * Haversine（ハバーサイン）式による2地点間の距離計算（メートル単位）
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球の半径 (メートル)
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // メートル
}

// Express アプリケーション設定
const app = express();

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error("Error in webhook handler:", err);
      res.status(500).end();
    });
});

/**
 * イベント振り分け処理（テキスト・位置情報のみのシンプル構成）
 */
async function handleEvent(event) {
  const userId = event.source.userId || "anonymous";
  let session = userSessions.get(userId);

  // 1. テキストメッセージ処理
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // A. 「スタート」または「開始」
    if (text === "スタート" || text === "開始" || text === "避難訓練") {
      userSessions.delete(userId); // 前回の記録をクリアして再設定可能にする
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "🚨 避難ウォーク訓練を開始します！\n\n" +
              "まずはスタート地点を設定します。\n" +
              "LINE画面左下の「＋」ボタンをタップし、【位置情報】を送信してください。"
          }
        ]
      });
    }

    // B. 「リセット」または「中止」
    if (text === "リセット" || text === "中止" || text === "キャンセル") {
      userSessions.delete(userId);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: "避難訓練の記録をリセットしました。\n新しく訓練を始めるには「スタート」と送信してください。"
          }
        ]
      });
    }

    // C. 「ゴール」または「到着」
    if (text === "ゴール" || text === "到着" || text === "避難完了") {
      if (!session || !session.startLocation || !session.startTime) {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                "避難訓練がまだスタートしていません。\n" +
                "「スタート」と送信した後に、LINEの「＋」ボタンからスタート地点の【位置情報】を送信してください。"
            }
          ]
        });
      }

      // ゴール時刻を記録
      session.goalTime = Date.now();
      session.status = "WAITING_GOAL_LOCATION";
      userSessions.set(userId, session);

      const goalTimeStr = new Date(session.goalTime).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              `🏁 ゴール時刻（${goalTimeStr}）を記録しました！\n\n` +
              "避難時間と移動距離を計算しますので、LINE画面左下の「＋」ボタンからゴール地点の【位置情報】を送信してください。"
          }
        ]
      });
    }

    // D. 避難中の状況確認やその他のテキスト
    if (session && session.startTime) {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - session.startTime) / 1000));
      const mins = Math.floor(elapsedSeconds / 60);
      const secs = elapsedSeconds % 60;
      const timeStr = mins > 0 ? `${mins}分 ${secs}秒` : `${secs}秒`;

      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              `🏃‍♂️ 現在、避難訓練の計測中です！\n\n` +
              `⏱️ 現在の経過時間: 約 ${timeStr}\n\n` +
              `避難所に到着したら「ゴール」とメッセージを送るか、LINEの「＋」ボタンから【位置情報】を送信してください。\n` +
              `※ やり直したい場合は「リセット」または「スタート」と送信してください。`
          }
        ]
      });
    }

    // E. 未開始時の通常テキスト
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text:
            "「スタート」と送信すると、避難訓練が始まります！\n" +
            "スタート後に現在地（位置情報）を送り、到着したら「ゴール」と送信してください。"
        }
      ]
    });
  }

  // 2. 位置情報メッセージ処理（スタート地点登録 or ゴール地点登録＆計算）
  if (event.type === "message" && event.message.type === "location") {
    const lat = event.message.latitude;
    const lng = event.message.longitude;

    // ① スタート地点の登録（まだ開始していない、またはスタート直後）
    if (!session || !session.startLocation || !session.startTime) {
      session = {
        status: "WALKING",
        startLocation: { lat, lng },
        startTime: Date.now(),
        goalLocation: null,
        goalTime: null
      };
      userSessions.set(userId, session);

      const startTimeStr = new Date(session.startTime).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              `🚀 【避難開始】を記録しました！\n\n` +
              `⏰ 開始時刻: ${startTimeStr}\n` +
              `📍 スタート座標: 北緯 ${lat.toFixed(5)}, 東経 ${lng.toFixed(5)}\n\n` +
              `周囲の安全に注意して避難所へ向かってください。\n\n` +
              `避難所に到着したら「ゴール」と送信するか、LINEの「＋」ボタンから現在地（位置情報）を送信してください。`
          }
        ]
      });
    }

    // ② ゴール地点の登録 ＆ 時間・距離の計算
    const endTime = session.goalTime || Date.now();
    const goalLat = lat;
    const goalLng = lng;

    // 時間計算（差分）
    const elapsedSeconds = Math.max(1, Math.floor((endTime - session.startTime) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const timeText = minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;

    // 距離計算（Haversine式）
    const walkedDistance = calculateHaversineDistance(
      session.startLocation.lat,
      session.startLocation.lng,
      goalLat,
      goalLng
    );
    const distanceText =
      walkedDistance >= 1000
        ? `${(walkedDistance / 1000).toFixed(2)} km (${Math.round(walkedDistance)} m)`
        : `${Math.round(walkedDistance)} m`;

    const startLatStr = session.startLocation.lat.toFixed(5);
    const startLngStr = session.startLocation.lng.toFixed(5);
    const goalLatStr = goalLat.toFixed(5);
    const goalLngStr = goalLng.toFixed(5);

    // 完了メッセージ（テキスト）
    const resultMessage =
      `🎉 避難訓練が完了しました！\n` +
      `━━━━━━━━━━━━━━\n` +
      `⏱️ 避難時間: ${timeText}\n` +
      `📏 移動距離: ${distanceText}\n` +
      `━━━━━━━━━━━━━━\n` +
      `📍 スタート: 北緯 ${startLatStr}, 東経 ${startLngStr}\n` +
      `🏁 ゴール地点: 北緯 ${goalLatStr}, 東経 ${goalLngStr}\n\n` +
      `避難訓練お疲れ様でした！\n` +
      `もう一度行う場合は「スタート」と送信してください。`;

    // セッションリセット
    userSessions.delete(userId);

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: resultMessage
        }
      ]
    });
  }

  return Promise.resolve(null);
}

// サーバー起動処理
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Hinan Walk Bot server is running on port ${PORT}`);
});
