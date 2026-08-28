const express = require("express");
const line = require("@line/bot-sdk");
const { Firestore, FieldValue } = require("@google-cloud/firestore");

// Cloud Run が自動でサービスアカウント認証する（鍵不要）
const firestore = new Firestore();
const db = firestore;

// ── 1. 各種設定 & 認証情報 ──
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET || "",
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
  adminExportKey: process.env.ADMIN_EXPORT_KEY || "hinan_research_2026"
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});


// メモリ保持用フォールバック
const memorySessions = new Map();
const memoryLogs = [];

// ── 3.5. タイムゾーン対応関数 ──
function getJapanNowTimestamp() {
  return Date.now();
}

function toJapanISOString(timestamp) {
  return new Date(timestamp).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).replace(/(\d+)\/(\d+)\/(\d+)\s(\d+):(\d+):(\d+)/, "$3-$1-$2T$4:$5:$6+09:00");
}

function formatJapanTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatJapanDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ── 3.7. 「使い方」テキスト生成関数 ──
function getHelpMessage() {
  return (
    "📖 【避難ウォークBot の使い方】\n\n" +
    "各コマンドを入力した際の動作説明です：\n\n" +
    "🔹「スタート」\n" +
    "避難所一覧（地図リンク付き）が表示されます。目標避難所を選択後、LINEの「＋」メニューから【位置情報】を送信すると計測が開始します[...][...]\n" +
    "🔹「スタート」（訓練中に送信）\n" +
    "※訓練中に送信すると、いつでも最初からやり直せます。\n\n" +
    "🔹「ゴール」\n" +
    "避難所到着時（または途中で終了したい時）に入力します。入力後に現在地の【位置情報】を送信すると、避難時間・移動距離・目標到着判定が表示されます。\n"
  );
}

// ── 4. セッション管理（Firestore / メモリ両対応） ──
async function getSession(userId) {
  try {
    const doc = await db.collection("user_sessions").doc(userId).get();
    if (doc.exists) return doc.data();
  } catch (e) {
    console.error("Firestore getSession error:", e.message);
  }
  return memorySessions.get(userId) || null;
}

async function saveSession(userId, sessionData) {
  try {
    await db.collection("user_sessions").doc(userId).set({
      ...sessionData,
      updatedAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error("Firestore saveSession error:", e.message);
    memorySessions.set(userId, sessionData);
  }
}

async function deleteSession(userId) {
  try {
    await db.collection("user_sessions").doc(userId).delete();
  } catch (e) {
    console.error("Firestore deleteSession error:", e.message);
  }
  memorySessions.delete(userId);
}

// ── 5. ログ保存 & 履歴取得 ──
async function saveEvacuationLog(logData) {
  try {
    await db.collection("evacuation_logs").add({
      ...logData,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error("Firestore saveEvacuationLog error:", e.message);
    memoryLogs.push({ ...logData, createdAt: new Date() });
  }
}

async function getUserHistory(userId, limitCount = 5) {
  try {
    const snapshot = await db
      .collection("evacuation_logs")
      .where("userId", "==", userId)
      .orderBy("startTime", "desc")
      .limit(limitCount)
      .get();

    if (!snapshot.empty) {
      return snapshot.docs.map((d) => d.data());
    }
  } catch (e) {
    console.error("Firestore getUserHistory error:", e.message);
  }

  return memoryLogs
    .filter((l) => l.userId === userId)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
    .slice(0, limitCount);
}

// ── 6. 避難所マスタ取得 ──
async function getShelterList() {
  try {
    const snapshot = await db.collection("shelters").get();
    if (!snapshot.empty) {
      return snapshot.docs.map((doc) => doc.data());
    }
    // shelters コレクションが空の場合は、空配列を返す
    return [];
  } catch (e) {
    console.warn("Firestore shelters get failed:", e.message);
    return [];
  }
}

// ── 6.5. Google Maps Geocoding API（住所 → 緯度経度） ──
async function geocodeAddress(address) {
  const apiKey = config.googleMapsApiKey;
  if (!apiKey) {
    throw new Error("Google Maps API Key が設定されていません");
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      throw new Error(`住所のジオコーディングに失敗しました: ${address}`);
    }

    const location = data.results[0].geometry.location;
    return {
      lat: location.lat,
      lng: location.lng
    };
  } catch (err) {
    console.error("Geocoding error:", err);
    throw err;
  }
}

// ── 6.6. CSVインポート処理（住所 → 緯度経度自動取得） ──
async function importSheltersFromCsv(csvText) {
  const lines = csvText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // 1行目はヘッダー
  const header = lines[0].split(",");
  const expectedHeader = ["id", "name", "address", "type", "city", "prefecture", "tagColor"];

  // ヘッダー一致チェック
  if (header.length !== expectedHeader.length ||
      !header.every((h, i) => h === expectedHeader[i])) {
    throw new Error("CSVヘッダーが正しくありません。正しい形式: id,name,address,type,city,prefecture,tagColor");
  }

  // 2行目以降がデータ
  const shelters = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");

    if (cols.length !== expectedHeader.length) {
      console.warn(`列数が一致しません（行 ${i + 1}）:`, lines[i]);
      continue;
    }

    const [id, name, address, type, city, prefecture, tagColor] = cols;

    // 住所 → 緯度経度
    const { lat, lng } = await geocodeAddress(address);

    shelters.push({
      id,
      name,
      address,
      type,
      city,
      prefecture,
      tagColor,
      lat,
      lng
    });
  }

  // Firestoreへ登録
  for (const shelter of shelters) {
    await db.collection("shelters").doc(shelter.id).set(shelter);
  }

  return shelters.length;
}


// ── 7. 位置情報ガード ──
function isValidJapanCoordinate(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
    return false;
  }
  return lat >= 20.0 && lat <= 46.0 && lng >= 122.0 && lng <= 154.0;
}

// ── 8. 距離・時間計算 & Google Maps Routes API ──
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
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
  return R * c;
}

// Google Maps Routes API v2
async function getWalkingRoute(originLat, originLng, destLat, destLng) {
  const apiKey = config.googleMapsApiKey;

  if (apiKey) {
    try {
      const url = new URL("https://routes.googleapis.com/directions/v2:computeRoutes");
      url.searchParams.append("key", apiKey);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters"
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
            isRouteApi: true,
            notice: ""
          };
        }
      } else {
        const errorText = await response.text();
        console.warn(`Routes API HTTP ${response.status}:`, errorText);
      }
    } catch (err) {
      console.warn("Routes API fetch failed:", {
        message: err.message,
        apiKey: config.googleMapsApiKey ? "✓ set" : "✗ not set",
        hasApiKey: !!config.googleMapsApiKey
      });
    }
  } else {
    console.warn("⚠️ Google Maps API Key が設定されていません。直線距離で計算します。");
  }

  const straightDist = calculateHaversineDistance(originLat, originLng, destLat, destLng);
  const estimatedWalkingDist = Math.round(straightDist * 1.25);
  const estimatedSeconds = Math.round((estimatedWalkingDist / 80) * 60);

  return {
    distanceMeters: estimatedWalkingDist,
    durationSeconds: estimatedSeconds,
    straightDistance: straightDist,
    isRouteApi: false,
    notice: "※ルート取得に失敗したため直線距離（推定値）で計算します\n"
  };
}

function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km (${Math.round(meters)} m)`;
  }
  return `${Math.round(meters)} m`;
}

function formatDuration(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return remainMins > 0 ? `${hours}時間${remainMins}分` : `${hours}時間`;
  }
  return `${mins}分`;
}

// ── 9. Flex Message カルーセル生成 ──
function createShelterFlex(shelters) {
  const bubbles = shelters.map((shelter) => {
    const mapUrl = `https://www.google.com/maps/search/${shelter.lat},${shelter.lng}`;
    const tagColor = shelter.tagColor || "#2980b9";

    return {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: tagColor,
        paddingAll: "md",
        contents: [
          {
            type: "text",
            text: shelter.type || "指定避難所",
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
                text: shelter.address || "住所情報なし",
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
            color: tagColor,
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
    altText: "避難所一覧",
    contents: {
      type: "carousel",
      contents: bubbles
    }
  };
}

// ── 10. Express アプリケーション設定 ──
const app = express();

// A. LINE Webhook
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error("Webhook processing error:", err);
      res.status(500).end();
    });
});

// B. 研究用 CSV エクスポートエンドポイント
app.get("/export/csv", async (req, res) => {
  const reqKey = req.query.key;
  if (reqKey !== config.adminExportKey) {
    return res.status(403).send("Unauthorized: Invalid export key.");
  }

  try {
    let logs = [];
    const snapshot = await db.collection("evacuation_logs").orderBy("startTime", "desc").get();
    logs = snapshot.docs.map((d) => d.data());

    const headers = [
      "drillId",
      "user",
      "shelterId",
      "shelterName",
      "shelterCity",
      "startTime",
      "endTime",
      "elapsedSeconds",
      "elapsedMinutes",
      "startLat",
      "startLng",
      "goalLat",
      "goalLng",
      "walkedDistanceMeters",
      "initialDistanceMeters",
      "remainingDistanceMeters",
      "isArrived",
      "achievementLevel",
      "routeSource"
    ];

    const rows = logs.map((l) => [
      l.drillId || "",
      l.userId || "",
      l.shelterId || "",
      `"${(l.shelterName || "").replace(/"/g, '""') }"`,
      `"${(l.shelterCity || "").replace(/"/g, '""') }"`,
      l.startTime || "",
      l.endTime || "",
      l.elapsedSeconds || 0,
      ((l.elapsedSeconds || 0) / 60).toFixed(02),
      l.startLat || "",
      l.startLng || "",
      l.goalLat || "",
      l.goalLng || "",
      l.walkedDistanceMeters || 0,
      l.initialDistanceMeters || 0,
      l.remainingDistanceMeters || 0,
      l.isArrived ? "TRUE" : "FALSE",
      l.achievementLevel || "",
      l.routeSource || ""
    ]);

    const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="evacuation_drill_logs.csv"');
    return res.status(200).send(csvContent);
  } catch (err) {
    console.error("CSV Export error:", err);
    return res.status(500).send("Failed to export CSV: " + err.message);
  }
});

// ── 12. 危険箇所QR（hazard?id=xxx）エンドポイント ──
app.get("/hazard", async (req, res) => {
  try {
    const hazardId = req.query.id;

    if (!hazardId) {
      return res.status(400).send("hazard id is missing");
    }

    // Firestore が使えるか確認
    if (!db) {
      return res.status(500).send("Firestore is not initialized");
    }

    // Firestore から hazardId の危険情報を取得
    const doc = await db.collection("hazards").doc(hazardId).get();

    if (!doc.exists) {
      return res.status(404).send(`hazard '${hazardId}' not found`);
    }

    const hazard = doc.data();
    
     // GoogleマップのURLを生成（市民投稿の緯度・経度を利用）
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${hazard.lat},${hazard.lng}`;
    
    // LINE に危険情報を送る（push）
    // ※ hazard.notifyUserId が無い場合は、固定の管理者IDを使うか、後で改善する
    const targetUserId = hazard.notifyUserId || hazard.defaultUserId;

    if (!targetUserId) {
      console.warn("No target userId found for hazard:", hazardId);
    }

    await client.pushMessage({
      to: targetUserId,
      messages: [
        {
          type: "text",
          text:
            `⚠️【危険箇所情報】\n\n` +
            `📌 種別: ${hazard.type || "危険箇所"}\n` +
            `📍 場所: ${hazard.title}\n\n` +
            `${hazard.description}\n\n` +
            `🗺️ Googleマップで場所を見る:\n${mapUrl}\n\n` +
            `🌐 ARで確認する:\n${hazard.arUrl || "ARページ未設定"}`
        }
      ]
    });

    return res.status(200).send("hazard info sent");
  } catch (err) {
    console.error("Hazard endpoint error:", err);
    return res.status(500).send("hazard endpoint failed: " + err.message);
  }
});

// ── 11. メインイベント振り分けハンドラ ──
async function handleEvent(event) {
  const userId = event.source.userId || "anonymous";

  try {
    let session = await getSession(userId);

    // 1. Postback イベント処理（避難所選択時）
    if (event.type === "postback") {
      try {
        const data = JSON.parse(event.postback.data);
        if (data.action === "select_shelter") {
          const shelters = await getShelterList();
          const shelter = shelters.find((s) => s.id === data.shelterId);
          if (!shelter) return null;

          session = {
            userId: userId,
            status: "WAITING_START_LOCATION",
            targetShelter: shelter,
            startLocation: null,
            startTime: null,
            initialDistance: 0,
            goalLocation: null,
            goalTime: null
          };
          await saveSession(userId, session);

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
        await deleteSession(userId);
        const shelters = await getShelterList();

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
            createShelterFlex(shelters)
          ]
        });
      }

      // ── B. スタート中（避難訓練中）の場合 ──
      if (session) {
        // ① 「リセット」
        if (text === "リセット" || text === "中止" || text === "キャンセル") {
          await deleteSession(userId);
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

          session.goalTime = getJapanNowTimestamp();
          session.status = "WAITING_GOAL_LOCATION";
          await saveSession(userId, session);

          const goalTimeStr = formatJapanTime(session.goalTime);

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

        // ③ 「使い方」（訓練中に追加）
        if (text === "使い方" || text === "つかいかた" || text === "ヘルプ" || text === "help") {
          return client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: getHelpMessage()
              }
            ]
          });
        }

        // ④ スタート中は「スタート」「リセット」「ゴール」「使い方」以外のテキストはすべて無視
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
              text: getHelpMessage()
            }
          ]
        });
      }

      // ② 「履歴」
      if (text === "履歴" || text === "りれき" || text === "記録" || text === "history") {
        const history = await getUserHistory(userId, 5);
        if (!history || history.length === 0) {
          return client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: "📋 過去の避難訓練記録はまだありません。\n「スタート」と送信して避難訓練を開始しましょう！"
              }
            ]
          });
        }

        let historyMsg = "📋 【過去の避難訓練履歴（直近5件）】\n━━━━━━━━━━━━━━\n";
        history.forEach((h, idx) => {
          // startTime がタイムスタンプ（数値）の場合と ISO 文字列の場合の両方に対応
          const startTimestamp = typeof h.startTime === "number" ? h.startTime : new Date(h.startTime).getTime();
          const dateStr = formatJapanDate(startTimestamp);

          const mins = Math.floor((h.elapsedSeconds || 0) / 60);
          const secs = (h.elapsedSeconds || 0) % 60;
          const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
          const distStr = formatDistance(h.walkedDistanceMeters || 0);
          const statusIcon = h.isArrived ? "🎉 到着" : "🏁 途中終了";

          historyMsg +=
            `[第${idx + 1}回] ${dateStr}\n` +
            `🏢 ${h.shelterName || "避難所"}\n` +
            `⏱️ 避難時間: ${timeStr} / 🚶 移動距離: ${distStr}\n` +
            `結果: ${statusIcon}\n` +
            `──────────────────\n`;
        });
        historyMsg += "訓練を新しく始めるには「スタート」と送信してください。";

        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: historyMsg }]
        });
      }

      // ③ ゴール後は「スタート」「使い方」「履歴」以外の入力はすべて無視
      return Promise.resolve(null);
    }

    // 3. 位置情報メッセージ処理（スタート登録 / ゴール登録＆計算）
    if (event.type === "message" && event.message.type === "location") {
      if (!session) {
        return Promise.resolve(null);
      }

      const lat = event.message.latitude;
      const lng = event.message.longitude;

      // 位置情報の妥当性チェック
      if (!isValidJapanCoordinate(lat, lng)) {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                "⚠️ 位置情報が正しく取得できませんでした。\n" +
                "電波状況の良い場所で、もう一度LINEの「＋」メニューから【位置情報】を送信してください。"
            }
          ]
        });
      }

    // ① スタート地点の登録
    if (!session.startLocation || !session.startTime) {
      // セッションに避難所が入っていない場合は、Firestoreから一覧を取得して先頭を使う
      let targetShelter = session.targetShelter;
      if (!targetShelter) {
        const shelters = await getShelterList();
        targetShelter = shelters[0]; // 少なくとも1件はある前提
      }

      const routeInfo = await getWalkingRoute(lat, lng, targetShelter.lat, targetShelter.lng);

      session.status = "WALKING";
      session.startLocation = { lat, lng };
      session.startTime = getJapanNowTimestamp();
      session.initialDistance = routeInfo.distanceMeters;
      session.isRouteApi = routeInfo.isRouteApi;
      await saveSession(userId, session);

      const startTimeStr = formatJapanTime(session.startTime);
      const fallbackNotice = routeInfo.notice || "";
    
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
              `⏱️ 徒歩予想時間: 約 ${formatDuration(routeInfo.durationSeconds)}\n` +
              `${fallbackNotice}\n` +
              `周囲の安全に注意して避難所へ向かってください。\n\n` +
              `到着時、または途中でやめたくなった場合も「ゴール」と送信するか、現在地（位置情報）を送信してください。`
          }
        ]
      });
    }


      // ② ゴール地点の登録 ＆ 時間・徒歩距離の計算
      const endTime = session.goalTime || getJapanNowTimestamp();
      const goalLat = lat;
      const goalLng = lng;
      
      // セッションに避難所が入っていない場合は、Firestoreから取得して先頭を使う
      let targetShelter = session.targetShelter;
      if (!targetShelter) {
        const shelters = await getShelterList();
        targetShelter = shelters[0];
      }
      // 時間計算
      const elapsedSeconds = Math.max(1, Math.floor((endTime - session.startTime) / 1000));
      const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = elapsedSeconds % 60;
      const timeText = minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;

      // スタート〜ゴール間の実際の徒歩移動距離
      const walkedRoute = await getWalkingRoute(
        session.startLocation.lat,
        session.startLocation.lng,
        goalLat,
        goalLng
      );

      // 目標避難所までの残りの徒歩距離
      const remainRoute = await getWalkingRoute(
        goalLat,
        goalLng,
        targetShelter.lat,
        targetShelter.lng
      );
      const isArrived = remainRoute.distanceMeters <= 300;
      const initialDist = session.initialDistance || 1000;
      const remainDist = remainRoute.distanceMeters;

      let achievementLevel = "INCOMPLETE";
      let arrivalMessage = "";

      if (isArrived) {
        achievementLevel = "ARRIVED";
        arrivalMessage = `🎉 おめでとうございます！目標避難所に無事到着しました！\n`;
      } else if (initialDist > 0 && remainDist < initialDist * 0.2) {
        achievementLevel = "NEAR_GOAL_20";
        arrivalMessage =
          `🏁 避難訓練を完了しました！（目標避難所まで徒歩残り 約 ${formatDistance(remainDist)}）\n` +
          `よく頑張ったね、自分を褒めよう\n`;
      } else if (initialDist > 0 && remainDist < initialDist * 0.5) {
        achievementLevel = "HALFWAY_50";
        arrivalMessage =
          `🏁 避難訓練を完了しました！（目標避難所まで徒歩残り 約 ${formatDistance(remainDist)}）\n` +
          `もう少しで、目標達成だよ\n`;
      } else {
        arrivalMessage = `🏁 避難訓練を完了しました！（目標避難所まで徒歩残り 約 ${formatDistance(remainDist)}）\n`;
      }

      const startLatStr = session.startLocation.lat.toFixed(5);
      const startLngStr = session.startLocation.lng.toFixed(5);
      const goalLatStr = goalLat.toFixed(5);
      const goalLngStr = goalLng.toFixed(5);

      const fallbackNotice = walkedRoute.notice || remainRoute.notice || "";

      // まず結果メッセージを作る
      const resultMessage =
        `${arrivalMessage}` +
        `━━━━━━━━━━━━━━\n` +
        `🏢 目標避難所: ${targetShelter.name}\n` +
        `⏱️ 実際の避難時間: ${timeText}\n` +
        `🚶 実際の移動距離: ${formatDistance(walkedRoute.distanceMeters)}\n` +
        `${fallbackNotice}` +
        `━━━━━━━━━━━━━━\n` +
        `📍 スタート: 北緯 ${startLatStr}, 東経 ${startLngStr}\n` +
        `🏁 ゴール地点: 北緯 ${goalLatStr}, 東経 ${goalLngStr}\n\n` +
        `避難訓練お疲れ様でした！\n` +
        `もう一度行う場合は「スタート」、過去の記録を見るには「履歴」と送信してください。`;

        // ── 追加：ポイント付与ロジック ──
try {
  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();

  let currentPoints = 0;
  if (userDoc.exists) {
    currentPoints = userDoc.data().points || 0;
  }

  let addPoint = 0;

  // ① 避難所到達（300m以内）
  if (isArrived) {
    addPoint += 2;
  }

  // ② 初期距離の50%以内まで到達
  if (initialDist > 0 && remainDist < initialDist * 0.5) {
    addPoint += 1;
  }

  // ③ 初期距離の20%以内まで到達
  if (initialDist > 0 && remainDist < initialDist * 0.2) {
    addPoint += 1;
  }

  // ④ 徒歩時間の推定より早く到着した場合のポイント
  const estimatedSeconds = walkedRoute.durationSeconds;

  // 1分早ければ +1pt
  if (elapsedSeconds < estimatedSeconds - 60) {
    addPoint += 1;
  }

  // 3分早ければさらに +1pt
  if (elapsedSeconds < estimatedSeconds - 180) {
    addPoint += 1;
  }

  // Firestore に保存
  await userRef.update({
    points: currentPoints + addPoint
  });

  // LINE にポイント通知
  await client.pushMessage({
    to: userId,
    messages: [
      {
        type: "text",
        text:
          `🎁【ポイント獲得】\n` +
          `今回の避難訓練で *${addPoint} pt* を獲得しました！\n\n` +
          `現在の合計ポイント：${currentPoints + addPoint} pt`
      }
    ]
  });

} catch (e) {
  console.error("ポイント付与エラー:", e.message);
}
      // 研究用ログを Firestore / メモリに保存
      // ✅ タイムスタンプをISO 8601形式の日本時間文字列で保存し、ミリ秒も併記する
      const drillLog = {
        drillId: `drill_${Date.now()}_${userId.slice(-6)}`,
        userId: userId,
        shelterId: targetShelter.id,
        shelterName: targetShelter.name,
        shelterCity: targetShelter.city || "熊谷市",
        startTime: toJapanISOString(session.startTime),
        startTimeMs: session.startTime,
        endTime: toJapanISOString(endTime),
        endTimeMs: endTime,
        elapsedSeconds: elapsedSeconds,
        startLat: session.startLocation.lat,
        startLng: session.startLocation.lng,
        goalLat: goalLat,
        goalLng: goalLng,
        walkedDistanceMeters: walkedRoute.distanceMeters,
        initialDistanceMeters: initialDist,
        remainingDistanceMeters: remainDist,
        isArrived: isArrived,
        achievementLevel: achievementLevel,
        routeSource: walkedRoute.isRouteApi ? "GOOGLE_ROUTES_API" : "HAVERSINE_ESTIMATED"
      };
      await saveEvacuationLog(drillLog);

      // セッション削除
      await deleteSession(userId);

      // ✅ ゴール後のメッセージに「使い方」テキストを自動追加
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: resultMessage
          },
          {
            type: "text",
            text: getHelpMessage()
          }
        ]
      });
    }

    return Promise.resolve(null);
  } catch (globalErr) {
    console.error("Global handleEvent error:", globalErr);
    if (event.replyToken) {
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "⚠️ 一時的なエラーが発生しました。もう一度「スタート」と送信してお試しください。"
            }
          ]
        });
      } catch (replyErr) {
        console.error("Failed to send error reply:", replyErr);
      }
    }
    return Promise.resolve(null);
  }
}

// ── 12. サーバー起動処理 ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Hinan Walk Bot server is running on port ${PORT}`);
  console.log("📅 Timezone: Asia/Tokyo (JST / UTC+9)");
});
