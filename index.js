const express = require("express");
const line = require("@line/bot-sdk");

// LINE Bot & Google Maps 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET || "",
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || ""
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
 * Haversine（ハバーサイン）式による2地点間の直線距離計算（メートル単位）
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
 * Google Maps Routes API (徒歩ルート) で距離・所要時間を取得
 * ※ APIキー未設定時やエラー時は直線距離と推定歩行速度（分速80m）に自動フォールバック
 */
async function getWalkingRoute(originLat, originLng, destLat, destLng) {
  const apiKey = config.googleMapsApiKey;

  if (apiKey) {
    try {
      const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
          "X-Goog-Maps-Solution-ID": "gmp_git_agentskills_v1"
        },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: originLat,
                longitude: originLng
              }
            }
          },
          destination: {
            location: {
              latLng: {
                latitude: destLat,
                longitude: destLng
              }
            }
          },
          travelMode: "WALK"
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
          const route = data.routes[0];
          const distanceMeters = route.distanceMeters || 0;
          const durationSeconds = route.duration
            ? parseInt(route.duration.replace("s", ""), 10)
            : Math.round(distanceMeters / 1.33);

          return {
            distanceMeters,
            durationSeconds,
            isRouteApi: true
          };
        }
      } else {
        console.warn("Routes API error status:", response.status, await response.text());
      }
    } catch (err) {
      console.warn("Routes API fetch failed, falling back to Haversine:", err.message);
    }
  }

  // フォールバック: 直線距離 × 都市部平均迂回係数(1.25) & 一般的な歩行速度(分速80m)
  const straightDist = calculateHaversineDistance(originLat, originLng, destLat, destLng);
  const estimatedWalkingDist = Math.round(straightDist * 1.25);
  const estimatedSeconds = Math.round((estimatedWalkingDist / 80) * 60);

  return {
    distanceMeters: estimatedWalkingDist,
    durationSeconds: estimatedSeconds,
    straightDistance: straightDist,
    isRouteApi: false
  };
}

/**
 * メートル表記を km または m に整形
 */
function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km (${Math.round(meters)} m)`;
  }
  return `${Math.round(meters)} m`;
}

/**
 * 秒数を「〇分」または「〇時間〇分」に整形
 */
function formatDuration(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return remainMins > 0 ? `${hours}時間${remainMins}分` : `${hours}時間`;
  }
  return `${mins}分`;
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

    // ── A. 「スタート」（訓練中・終了後どちらでも受付可能） ──
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

    // ── B. スタート中（避難訓練中）の場合 ──
    if (session) {
      // ① 「リセット」
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

      // ② 「ゴール」
      if (text === "ゴール" || text === "到着" || text === "避難完了" || text === "終了") {
        if (!session.startLocation || !session.startTime) {
          return client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text:
                  "避難訓練がまだスタートしていません。\n" +
                  "LINEの「＋」ボタンからスタート地点の【位置情報】を送信してください。"
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

      // ③ スタート中は「スタート」「リセット」「ゴール」以外のテキストはすべて無視
      return Promise.resolve(null);
    }

    // ── C. ゴール後 / 未開始時の場合 ──
    // ① 「使い方」
    if (text === "使い方" || text === "つかいかた" || text === "ヘルプ" || text === "help") {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "📖 【避難ウォークBot の使い方】\n\n" +
              "各コマンドを入力した際の動作説明です：\n\n" +
              "🔹「スタート」\n" +
              "熊谷市の避難所一覧（地図リンク付き）が表示されます。目標避難所を選択後、LINEの「＋」メニューから【位置情報】を送信すると計測が開始されます。\n" +
              "※訓練中に送信すると、いつでも最初からやり直せます。\n\n" +
              "🔹「ゴール」\n" +
              "避難所到着時（または途中で終了したい時）に入力します。入力後に現在地の【位置情報】を送信すると、避難時間・移動距離・目標達成判定が表示されます。\n\n" +
              "🔹「リセット」\n" +
              "訓練を途中で中止し、記録を初期化します（訓練中のみ有効）。\n\n" +
              "🔹「使い方」\n" +
              "この説明テキストを表示します（ゴール後・未開始時のみ有効）。\n\n" +
              "──────────────────\n" +
              "※ 訓練中は「スタート」「リセット」「ゴール」以外のメッセージは無視されます。\n" +
              "※ 終了後は「スタート」「使い方」以外のメッセージは無視されます。"
          }
        ]
      });
    }

    // ② ゴール後は「スタート」「使い方」以外の入力はすべて無視
    return Promise.resolve(null);
  }

  // 3. 位置情報メッセージ処理（スタート登録 / ゴール登録＆計算）
  if (event.type === "message" && event.message.type === "location") {
    // 訓練未開始時は位置情報を無視
    if (!session) {
      return Promise.resolve(null);
    }

    const lat = event.message.latitude;
    const lng = event.message.longitude;

    // ① スタート地点の登録（まだ開始していない、または目標避難所設定直後）
    if (!session.startLocation || !session.startTime) {
      const targetShelter = session.targetShelter || KUMAGAYA_SHELTERS[0];

      // Google Maps Routes API で徒歩ルート距離・予想時間を取得
      const routeInfo = await getWalkingRoute(lat, lng, targetShelter.lat, targetShelter.lng);

      session.status = "WALKING";
      session.startLocation = { lat, lng };
      session.startTime = Date.now();
      session.initialDistance = routeInfo.distanceMeters;
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
              `🎯 目標避難所: ${targetShelter.name}\n` +
              `⏰ 開始時刻: ${startTimeStr}\n` +
              `📍 スタート座標: 北緯 ${lat.toFixed(5)}, 東経 ${lng.toFixed(5)}\n` +
              `🚶 徒歩ルート距離: 約 ${formatDistance(routeInfo.distanceMeters)}\n` +
              `⏱️ 徒歩予想時間: 約 ${formatDuration(routeInfo.durationSeconds)}\n\n` +
              `周囲の安全に注意して避難所へ向かってください。\n\n` +
              `到着時、または途中でやめたくなった場合も「ゴール」と送信するか、現在地（位置情報）を送信してください。`
          }
        ]
      });
    }

    // ② ゴール地点の登録 ＆ 時間・徒歩距離の計算
    const endTime = session.goalTime || Date.now();
    const goalLat = lat;
    const goalLng = lng;
    const targetShelter = session.targetShelter || KUMAGAYA_SHELTERS[0];

    // 時間計算（実際の経過時間）
    const elapsedSeconds = Math.max(1, Math.floor((endTime - session.startTime) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const timeText = minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;

    // 徒歩距離計算（スタート〜ゴール間の実際の移動ルート距離）
    const walkedRoute = await getWalkingRoute(
      session.startLocation.lat,
      session.startLocation.lng,
      goalLat,
      goalLng
    );

    // 目標避難所までの残りの徒歩距離を計算
    const remainRoute = await getWalkingRoute(
      goalLat,
      goalLng,
      targetShelter.lat,
      targetShelter.lng
    );
    const isArrived = remainRoute.distanceMeters <= 300; // 300m以内なら無事到着と判定

    const initialDist = session.initialDistance || 1000;
    const remainDist = remainRoute.distanceMeters;

    const startLatStr = session.startLocation.lat.toFixed(5);
    const startLngStr = session.startLocation.lng.toFixed(5);
    const goalLatStr = goalLat.toFixed(5);
    const goalLngStr = goalLng.toFixed(5);

    // 到着判定および進捗メッセージの生成
    let arrivalMessage = "";
    if (isArrived) {
      arrivalMessage = `🎉 おめでとうございます！目標避難所に無事到着しました！\n`;
    } else if (initialDist > 0 && remainDist < initialDist * 0.2) {
      // 残り距離が5分の1を切っている場合
      arrivalMessage =
        `🏁 避難訓練を完了しました！（目標避難所まで徒歩残り 約 ${formatDistance(remainDist)}）\n` +
        `よく頑張ったね、自分を褒めよう\n`;
    } else if (initialDist > 0 && remainDist < initialDist * 0.5) {
      // 残り距離が半分より短い時
      arrivalMessage =
        `🏁 避難訓練を完了しました！（目標避難所まで徒歩残り 約 ${formatDistance(remainDist)}）\n` +
        `もう少しで、目標達成だよ\n`;
    } else {
      arrivalMessage = `🏁 避難訓練を完了しました！（目標避難所まで徒歩残り 約 ${formatDistance(remainDist)}）\n`;
    }

    const resultMessage =
      `${arrivalMessage}` +
      `━━━━━━━━━━━━━━\n` +
      `🏢 目標避難所: ${targetShelter.name}\n` +
      `⏱️ 実際の避難時間: ${timeText}\n` +
      `🚶 実際の移動距離: ${formatDistance(walkedRoute.distanceMeters)}\n` +
      `━━━━━━━━━━━━━━\n` +
      `📍 スタート: 北緯 ${startLatStr}, 東経 ${startLngStr}\n` +
      `🏁 ゴール地点: 北緯 ${goalLatStr}, 東経 ${goalLngStr}\n\n` +
      `避難訓練お疲れ様でした！\n` +
      `もう一度行う場合は「スタート」と送信してください。`;

    // セッションリセット（ゴール後状態へ遷移）
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
