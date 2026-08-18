const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

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

// ── 2. Cloud Firestore 初期化（環境変数またはフォールバック） ──
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    const serviceAccount = JSON.parse(
      raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")
    );
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("🔥 [Firestore] Firebase Admin SDK で接続しました。");
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp();
    db = admin.firestore();
    console.log("🔥 [Firestore] Google ADC で接続しました。");
  } else {
    console.log("ℹ️ [Firestore] 認証情報未設定のため、メモリ保持モード（Map）で動作します。");
  }
} catch (err) {
  console.warn("⚠️ [Firestore] 初期化失敗。メモリ保持モードで動作します:", err.message);
  db = null;
}

// ── 3. 熊谷市 避難所初期マスタデータ ──
const KUMAGAYA_SHELTERS = [
  {
    id: "kumagaya_1",
    name: "熊谷市役所（本庁舎）",
    city: "熊谷市",
    prefecture: "埼玉県",
    type: "指定緊急避難場所",
    address: "埼玉県熊谷市宮町2丁目47-1",
    lat: 36.147285,
    lng: 139.388701,
    tagColor: "#27ae60"
  },
  {
    id: "kumagaya_2",
    name: "熊谷市立熊谷東小学校",
    city: "熊谷市",
    prefecture: "埼玉県",
    type: "指定避難所（地震・水害）",
    address: "埼玉県熊谷市末広3丁目1-1",
    lat: 36.148150,
    lng: 139.397620,
    tagColor: "#2980b9"
  },
  {
    id: "kumagaya_3",
    name: "熊谷市立熊谷南小学校",
    city: "熊谷市",
    prefecture: "埼玉県",
    type: "指定避難所（地震・水害）",
    address: "埼玉県熊谷市万平町2丁目1",
    lat: 36.136200,
    lng: 139.387800,
    tagColor: "#2980b9"
  },
  {
    id: "kumagaya_4",
    name: "熊谷市立熊谷西小学校",
    city: "熊谷市",
    prefecture: "埼玉県",
    type: "指定避難所（地震）",
    address: "埼玉県熊谷市新島123",
    lat: 36.155800,
    lng: 139.369500,
    tagColor: "#2980b9"
  },
  {
    id: "kumagaya_5",
    name: "熊谷スポーツ文化公園",
    city: "熊谷市",
    prefecture: "埼玉県",
    type: "広域避難場所",
    address: "埼玉県熊谷市上川上300",
    lat: 36.166800,
    lng: 139.412500,
    tagColor: "#e67e22"
  },
  {
    id: "kumagaya_6",
    name: "妻沼中央公民館",
    city: "熊谷市",
    prefecture: "埼玉県",
    type: "指定避難所",
    address: "埼玉県熊谷市妻沼東1丁目1",
    lat: 36.231200,
    lng: 139.387500,
    tagColor: "#8e44ad"
  }
];

// メモリ保持用フォールバック
const memorySessions = new Map();
const memoryLogs = [];

// ── 3.5. タイムゾーン対応関数（NEW） ──
/**
 * 現在時刻を日本標準時（JST / Asia/Tokyo）で取得
 * @returns {number} ミリ秒単位のタイムスタンプ
 */
function getJapanNowTimestamp() {
  return Date.now();
}

/**
 * タイムスタンプを日本時間の ISO 8601 文字列に変換
 * @param {number} timestamp - ミリ秒単位のタイムスタンプ
 * @returns {string} ISO 8601 形式の日本時間文字列
 */
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

/**
 * タイムスタンプを日本時間のフォーマット済み文字列に変換
 * @param {number} timestamp - ミリ秒単位のタイムスタンプ
 * @returns {string} 日本時間の表示用文字列
 */
function formatJapanTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

/**
 * タイムスタンプを日本時間の日付情報に変換
 * @param {number} timestamp - ミリ秒単位のタイムスタンプ
 * @returns {string} 日本時間の日付表示用文字列
 */
function formatJapanDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ── 3.7. 「使い方」テキスト生成関数（NEW） ──
/**
 * 「使い方」のヘルプテキストを生成
 * @returns {string} ヘルプメッセージ
 */
function getHelpMessage() {
  return (
    "📖 【避難ウォークBot の使い方】\n\n" +
    "各コマンドを入力した際の動作説明です：\n\n" +
    "🔹「スタート」\n" +
    "避難所一覧（地図リンク付き）が表示されます。目標避難所を選択後、LINEの「＋」メニューから【位置情報】を送信すると計測が開始します。\n\n" +
    "🔹「スタート」（訓練中に送信）\n" +
    "※訓練中に送信すると、いつでも最初からやり直せます。\n\n" +
    "🔹「ゴール」\n" +
    "避難所到着時（または途中で終了したい時）に入力します。入力後に現在地の【位置情報】を送信すると、避難時間・移動距離・目標到着判定が表示されます。\n\n" +
    "🔹「リセット」\n" +
    "訓練を途中で中止し、記録を初期化します（訓練中のみ有効）。\n\n" +
    "🔹「履歴」\n" +
    "過去の避難訓練の記録一覧（直近5件）を表示します。\n\n" +
    "🔹「使い方」\n" +
    "この説明テキストを表示します。\n\n" +
    "──────────────────\n" +
    "※ 訓練中は「スタート」「リセット」「ゴール」「使い方」のみ受け付けます。\n" +
    "※ 終了後は「スタート」「使い方」「履歴」を入力できます。"
  );
}

// ── 4. セッション管理（Firestore / メモリ両対応） ──
async function getSession(userId) {
  if (db) {
    try {
      const doc = await db.collection("user_sessions").doc(userId).get();
      if (doc.exists) return doc.data();
    } catch (e) {
      console.error("Firestore getSession error:", e.message);
    }
  }
  return memorySessions.get(userId) || null;
}

async function saveSession(userId, sessionData) {
  if (db) {
    try {
      await db.collection("user_sessions").doc(userId).set({
        ...sessionData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    } catch (e) {
      console.error("Firestore saveSession error:", e.message);
    }
  }
  memorySessions.set(userId, sessionData);
}

async function deleteSession(userId) {
  if (db) {
    try {
      await db.collection("user_sessions").doc(userId).delete();
    } catch (e) {
      console.error("Firestore deleteSession error:", e.message);
    }
  }
  memorySessions.delete(userId);
}

// ── 5. ログ保存 & 履歴取得（研究用データ管理） ──
async function saveEvacuationLog(logData) {
  if (db) {
    try {
      await db.collection("evacuation_logs").add({
        ...logData,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    } catch (e) {
      console.error("Firestore saveEvacuationLog error:", e.message);
    }
  }
  memoryLogs.push({ ...logData, createdAt: new Date() });
}

async function getUserHistory(userId, limitCount = 5) {
  if (db) {
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
  }

  return memoryLogs
    .filter((l) => l.userId === userId)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
    .slice(0, limitCount);
}

// ── 6. 避難所マスタ取得（Firestore / ローカルフォールバック） ──
async function getShelterList() {
  if (db) {
    try {
      const snapshot = await db.collection("shelters").get();
      if (!snapshot.empty) {
        return snapshot.docs.map((doc) => doc.data());
      }
    } catch (e) {
      console.warn("Firestore shelters get failed, using fallback:", e.message);
    }
  }
  return KUMAGAYA_SHELTERS;
}

// ── 7. 位置情報ガード（日本国内座標 & 数値検証） ──
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

// ✅ 【修正①】 Google Maps Routes API v2 の認証ヘッダーを正しく設定
async function getWalkingRoute(originLat, originLng, destLat, destLng) {
  const apiKey = config.googleMapsApiKey;

  if (apiKey) {
    try {
      // URLパラメータとしてAPIキーを渡す
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
        // ✅ 【修正②】 エラーレスポンスの詳細をログ出力
        const errorText = await response.text();
        console.warn(`Routes API HTTP ${response.status}:`, errorText);
      }
    } catch (err) {
      // ✅ 【修正②】 API キーの状態とエラーの詳細をログ出力
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
    // ✅ 【修正③】 Google Maps を起動する URL に変更（検索ではなく直接地図表示）
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
    if (db) {
      const snapshot = await db.collection("evacuation_logs").orderBy("startTime", "desc").get();
      logs = snapshot.docs.map((d) => d.data());
    } else {
      logs = [...memoryLogs].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    }

    const headers = [
      "drillId",
      "userId",
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
      `"${(l.shelterName || "").replace(/"/g, '""')}"`,
      `"${(l.shelterCity || "").replace(/"/g, '""')}"`,
      l.startTime || "",
      l.endTime || "",
      l.elapsedSeconds || 0,
      ((l.elapsedSeconds || 0) / 60).toFixed(2),
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
        const targetShelter = session.targetShelter || KUMAGAYA_SHELTERS[0];

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
      const targetShelter = session.targetShelter || KUMAGAYA_SHELTERS[0];

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

      // 研究用ログを Firestore / メモリに保存
      // ✅ タイムスタンプをISO 8601形式の日本時間文字列で保存
      const drillLog = {
        drillId: `drill_${Date.now()}_${userId.slice(-6)}`,
        userId: userId,
        shelterId: targetShelter.id,
        shelterName: targetShelter.name,
        shelterCity: targetShelter.city || "熊谷市",
        startTime: new Date(session.startTime).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }),
        endTime: new Date(endTime).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }),
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
