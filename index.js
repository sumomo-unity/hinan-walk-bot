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

// 熊谷市 避難所マスタデータ（JSON化）
const KUMAGAYA_SHELTERS = [
  {
    id: "kumagaya_1",
    name: "熊谷市役所（本庁舎）",
    type: "指定緊急避難場所",
    address: "埼玉県熊谷市宮町2丁目47-1",
    lat: 36.147285,
    lng: 139.388701,
    tagColor: "#27ae60"
  },
  {
    id: "kumagaya_2",
    name: "熊谷市立熊谷東小学校",
    type: "指定避難所（地震・水害）",
    address: "埼玉県熊谷市末広3丁目1-1",
    lat: 36.148150,
    lng: 139.397620,
    tagColor: "#2980b9"
  },
  {
    id: "kumagaya_3",
    name: "熊谷市立熊谷南小学校",
    type: "指定避難所（地震・水害）",
    address: "埼玉県熊谷市万平町2丁目1",
    lat: 36.136200,
    lng: 139.387800,
    tagColor: "#2980b9"
  },
  {
    id: "kumagaya_4",
    name: "熊谷市立熊谷西小学校",
    type: "指定避難所（地震）",
    address: "埼玉県熊谷市新島123",
    lat: 36.155800,
    lng: 139.369500,
    tagColor: "#2980b9"
  },
  {
    id: "kumagaya_5",
    name: "熊谷スポーツ文化公園",
    type: "広域避難場所",
    address: "埼玉県熊谷市上川上300",
    lat: 36.166800,
    lng: 139.412500,
    tagColor: "#e67e22"
  },
  {
    id: "kumagaya_6",
    name: "妻沼中央公民館",
    type: "指定避難所",
    address: "埼玉県熊谷市妻沼東1丁目1",
    lat: 36.231200,
    lng: 139.387500,
    tagColor: "#8e44ad"
  }
];

// ユーザーごとのセッション管理（メモリ保持）
// userId => { status, targetShelter, startLocation, startTime, initialDistance, goalLocation, goalTime }
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

/**
 * 熊谷市 避難所一覧 Flex Message（カルーセル形式）を作成
 */
function createKumagayaShelterFlex() {
  const bubbles = KUMAGAYA_SHELTERS.map((shelter) => {
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${shelter.lat},${shelter.lng}`;

    return {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: shelter.tagColor,
        paddingAll: "md",
        contents: [
          {
            type: "text",
            text: shelter.type,
            color: "#ffffff",
            size: "xs",
            weight: "bold"
          },
          {
            type: "text",
            text: shelter.name,
            color: "#ffffff",
            size: "md",
            weight: "bold",
            wrap: true,
            margin: "xs"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "box",
            layout: "vertical",
            spacing: "none",
            contents: [
              {
                type: "text",
                text: "📍 所在地",
                size: "xs",
                color: "#888888",
                weight: "bold"
              },
              {
                type: "text",
                text: shelter.address,
                size: "xs",
                color: "#333333",
                wrap: true,
                margin: "xs"
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "none",
            contents: [
              {
                type: "text",
                text: "🌐 座標",
                size: "xs",
                color: "#888888",
                weight: "bold"
              },
              {
                type: "text",
                text: `北緯 ${shelter.lat.toFixed(4)} / 東経 ${shelter.lng.toFixed(4)}`,
                size: "xs",
                color: "#666666",
                margin: "xs"
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "uri",
              label: "🗺️ 地図を見る",
              uri: mapUrl
            }
          },
          {
            type: "button",
            style: "primary",
            color: shelter.tagColor,
            height: "sm",
            action: {
              type: "postback",
              label: "🎯 ここへ避難する",
              data: JSON.stringify({
                action: "select_shelter",
                shelterId: shelter.id
              }),
              displayText: `「${shelter.name}」を目標避難所に設定しました`
            }
          }
        ]
      }
    };
  });

  return {
    type: "flex",
    altText: "熊谷市の避難所一覧",
    contents: {
      type: "carousel",
      contents: bubbles
    }
  };
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
 * イベント振り分け処理
 */
async function handleEvent(event) {
  const userId = event.source.userId || "anonymous";
  let session = userSessions.get(userId);

  // 1. Postback イベント処理（避難所選択時）
  if (event.type === "postback") {
    try {
      const data = JSON.parse(event.postback.data);

      if (data.action === "select_shelter") {
        const shelter = KUMAGAYA_SHELTERS.find((s) => s.id === data.shelterId);
        if (!shelter) return null;

        // セッション作成（目標避難所を設定）
        session = {
          status: "WAITING_START_LOCATION",
          targetShelter: shelter,
          startLocation: null,
          startTime: null,
          initialDistance: 0,
          goalLocation: null,
          goalTime: null
        };
        userSessions.set(userId, session);

        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                `🏢 目標避難所を「${shelter.name}」に設定しました！\n\n` +
                "避難を開始します。\n" +
                "LINE画面左下の「＋」ボタンからスタート地点の【位置情報】を送信してください。"
            }
          ]
        });
      }
    } catch (e) {
      console.error("Postback parse error:", e);
    }
    return null;
  }

  // 2. テキストメッセージ処理
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // A. 「スタート」入力時（お問い合わせを受け付けていない注意書きをここでのみ表示）
    if (text === "スタート" || text === "開始" || text === "避難訓練") {
      userSessions.delete(userId); // 前回の記録をクリア
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "🚨 避難ウォーク訓練を開始します！\n" +
              "※本Botは避難訓練専用です。個別のお問い合わせには対応しておりません。\n\n" +
              "まずは目指す【目標避難所】を以下の一覧から選択してください。"
          },
          createKumagayaShelterFlex()
        ]
      });
    }

    // B. 「リセット」「中止」「キャンセル」
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

    // C. 「ゴール」「到着」「終了」（途中でやめたくなった場合も対応）
    if (text === "ゴール" || text === "到着" || text === "避難完了" || text === "終了") {
      if (!session || !session.startLocation || !session.startTime) {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                "避難訓練がまだスタートしていません。\n" +
                "「スタート」と送信して避難所を選び、LINEの「＋」ボタンからスタート地点の【位置情報】を送信してください。"
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
              "避難時間と移動距離を計算しますので、LINE画面左下の「＋」ボタンから現在の【位置情報】を送信してください。"
          }
        ]
      });
    }

    // D. 避難中のその他メッセージ
    if (session && session.startTime) {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - session.startTime) / 1000));
      const mins = Math.floor(elapsedSeconds / 60);
      const secs = elapsedSeconds % 60;
      const timeStr = mins > 0 ? `${mins}分 ${secs}秒` : `${secs}秒`;
      const shelterName = session.targetShelter ? session.targetShelter.name : "避難所";

      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              `🏃‍♂️ 現在、避難訓練の計測中です！\n` +
              `🎯 目標避難所: ${shelterName}\n` +
              `⏱️ 現在の経過時間: 約 ${timeStr}\n\n` +
              `到着した際、または途中でやめたい場合も「ゴール」とメッセージを送るか、LINEの「＋」ボタンから【位置情報】を送信してください。\n` +
              `※最初からやり直す場合は「スタート」と送信してください。`
          }
        ]
      });
    }

    // E. 避難所選択待ちの場合
    if (session && session.status === "WAITING_START_LOCATION") {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              `🏢 目標避難所「${session.targetShelter.name}」が設定されています。\n\n` +
              "LINE画面左下の「＋」ボタンからスタート地点の【位置情報】を送信して訓練を開始してください。"
          }
        ]
      });
    }

    // F. 未開始時
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text:
            "「スタート」と送信すると、熊谷市の避難所一覧が表示されて避難訓練を始められます！"
        }
      ]
    });
  }

  // 3. 位置情報メッセージ処理（スタート登録 / ゴール登録＆計算）
  if (event.type === "message" && event.message.type === "location") {
    const lat = event.message.latitude;
    const lng = event.message.longitude;

    // ① スタート地点の登録（まだ開始していない、または目標避難所設定直後）
    if (!session || !session.startLocation || !session.startTime) {
      const targetShelter = (session && session.targetShelter) || KUMAGAYA_SHELTERS[0];

      // 避難所までの初期直線距離
      const initialDist = calculateHaversineDistance(
        lat,
        lng,
        targetShelter.lat,
        targetShelter.lng
      );

      session = {
        status: "WALKING",
        targetShelter: targetShelter,
        startLocation: { lat, lng },
        startTime: Date.now(),
        initialDistance: initialDist,
        goalLocation: null,
        goalTime: null
      };
      userSessions.set(userId, session);

      const startTimeStr = new Date(session.startTime).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

      const initialDistText =
        initialDist >= 1000
          ? `${(initialDist / 1000).toFixed(2)} km (${Math.round(initialDist)} m)`
          : `${Math.round(initialDist)} m`;

      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              `🚀 【避難開始】を記録しました！\n\n` +
              `🎯 目標避難所: ${targetShelter.name}\n` +
              `⏰ 開始時刻: ${startTimeStr}\n` +
              `📍 スタート座標: 北緯 ${lat.toFixed(5)}, 東経 ${lng.toFixed(5)}\n` +
              `📏 避難所までの直線距離: 約 ${initialDistText}\n\n` +
              `周囲の安全に注意して避難所へ向かってください。\n\n` +
              `到着時、または途中でやめたくなった場合も「ゴール」と送信するか、現在地（位置情報）を送信してください。`
          }
        ]
      });
    }

    // ② ゴール地点の登録 ＆ 時間・距離の計算
    const endTime = session.goalTime || Date.now();
    const goalLat = lat;
    const goalLng = lng;
    const targetShelter = session.targetShelter || KUMAGAYA_SHELTERS[0];

    // 時間計算（差分）
    const elapsedSeconds = Math.max(1, Math.floor((endTime - session.startTime) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const timeText = minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;

    // 距離計算（Haversine式: スタート地点〜ゴール地点の移動距離）
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

    // 目標避難所までの残りの距離を計算
    const distToShelter = calculateHaversineDistance(
      goalLat,
      goalLng,
      targetShelter.lat,
      targetShelter.lng
    );
    const isArrived = distToShelter <= 300; // 300m以内なら無事到着と判定

    // 初期距離（スタート地点〜目標避難所）
    const initialDist = session.initialDistance || calculateHaversineDistance(
      session.startLocation.lat,
      session.startLocation.lng,
      targetShelter.lat,
      targetShelter.lng
    );

    const startLatStr = session.startLocation.lat.toFixed(5);
    const startLngStr = session.startLocation.lng.toFixed(5);
    const goalLatStr = goalLat.toFixed(5);
    const goalLngStr = goalLng.toFixed(5);

    // 到着判定および進捗メッセージの生成
    let arrivalMessage = "";
    if (isArrived) {
      arrivalMessage = `🎉 おめでとうございます！目標避難所に無事到着しました！\n`;
    } else if (initialDist > 0 && distToShelter < initialDist * 0.2) {
      // 残り距離が5分の1を切っている場合
      arrivalMessage =
        `🏁 避難訓練を完了しました！（目標避難所まで残り 約 ${Math.round(distToShelter)} m）\n` +
        `よく頑張ったね、自分を褒めよう\n`;
    } else if (initialDist > 0 && distToShelter < initialDist * 0.5) {
      // 残り距離が半分より短い時
      arrivalMessage =
        `🏁 避難訓練を完了しました！（目標避難所まで残り 約 ${Math.round(distToShelter)} m）\n` +
        `もう少しで、目標達成だよ\n`;
    } else {
      arrivalMessage = `🏁 避難訓練を完了しました！（目標避難所まで残り 約 ${Math.round(distToShelter)} m）\n`;
    }

    const resultMessage =
      `${arrivalMessage}` +
      `━━━━━━━━━━━━━━\n` +
      `🏢 目標避難所: ${targetShelter.name}\n` +
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
