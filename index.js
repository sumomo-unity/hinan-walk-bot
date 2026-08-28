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
  const d = new Date(timestamp);
  // 日本時間にオフセット (+9時間)
  const tzOffset = 9 * 60 * 60 * 1000;
  const jpDate = new Date(d.getTime() + tzOffset);
  
  const YYYY = jpDate.getUTCFullYear();
  const MM = String(jpDate.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(jpDate.getUTCDate()).padStart(2, '0');
  const hh = String(jpDate.getUTCHours()).padStart(2, '0');
  const mm = String(jpDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(jpDate.getUTCSeconds()).padStart(2, '0');

  return `${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}+09:00`;
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
    "避難所一覧（地図リンク付き）が表示されます。目標避難所を選択後、LINEの「＋」メニューから【位置情報】を送信すると計測が開始します。\n\n" +
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
    return [];
  } catch (e) {
    console.warn("Firestore shelters get failed:", e.message);
    return [];
  }
}

// ── 6.5. Google Maps Geocoding API ──
async function geocodeAddress(item) {
  const apiKey = config.googleMapsApiKey;
  if (!apiKey) {
    throw new Error("Google Maps API Key が設定されていません");
  }

  const fullAddress = `${item.prefecture || ""}${item.city || ""}${item.address || ""}`.trim();
  const fallbackQuery = `${item.prefecture || ""}${item.city || ""}${item.name || ""}`.trim();

  const fetchCoords = async (query) => {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Geocoding API HTTP Error: ${response.status}`);
    }
    const data = await response.json();
    if (data.status === "OK" && data.results && data.results.length > 0) {
      return data.results[0].geometry.location;
    }
    return null;
  };

  try {
    let location = await fetchCoords(fullAddress);

    if (!location && fallbackQuery !== fullAddress) {
      console.warn(`住所での検索結果が0件のため、施設名で再検索します: "${fallbackQuery}"`);
      location = await fetchCoords(fallbackQuery);
    }

    if (!location) {
      throw new Error(`位置情報を特定できませんでした（検索クエリ: "${fullAddress}" / "${fallbackQuery}"）`);
    }

    return {
      lat: location.lat,
      lng: location.lng
    };
  } catch (err) {
    console.error(`Geocoding error [${item.name}]:`, err.message);
    throw err;
  }
}

// ── 6.6. CSVインポート処理 ──
async function importSheltersFromCsv(csvText) {
  const cleanCsvText = csvText.replace(/^\uFEFF/, "");
  const lines = cleanCsvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error("CSVデータにヘッダーまたはデータが存在しません");
  }

  // ダブルクォーテーション対応のCSVパース
  const parseCsvLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.replace(/^"|"$/g, '').trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.replace(/^"|"$/g, '').trim());
    return result;
  };

  const rawHeader = parseCsvLine(lines[0]);
  const headerMap = {};
  
  rawHeader.forEach((h, index) => {
    headerMap[h.toLowerCase()] = index;
  });

  const requiredFields = ["id", "name", "address", "type", "city", "prefecture", "tagcolor"];
  const missingFields = requiredFields.filter(f => !(f in headerMap));

  if (missingFields.length > 0) {
    throw new Error(`CSVに必要なヘッダーが含まれていません。不足: ${missingFields.join(", ")}`);
  }

  const successShelters = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);

    if (cols.length < requiredFields.length) {
      errors.push(`行 ${i + 1}: 列数が足りません`);
      continue;
    }

    const item = {
      id: cols[headerMap["id"]],
      name: cols[headerMap["name"]],
      address: cols[headerMap["address"]],
      type: cols[headerMap["type"]],
      city: cols[headerMap["city"]],
      prefecture: cols[headerMap["prefecture"]],
      tagColor: cols[headerMap["tagcolor"]] || "#2980b9"
    };

    if (!item.id || !item.name) {
      errors.push(`行 ${i + 1}: id または name が空です`);
      continue;
    }

    try {
      const { lat, lng } = await geocodeAddress(item);

      const shelterData = {
        ...item,
        lat,
        lng
      };

      await db.collection("shelters").doc(shelterData.id).set(shelterData);
      successShelters.push(shelterData);
    } catch (err) {
      errors.push(`行 ${i + 1} (${item.name}): ${err.message}`);
    }
  }

  return {
    successCount: successShelters.length,
    totalLines: lines.length - 1,
    errors
  };
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

// ── 9. Flex Message カルーセル生成 ──
function createShelterFlex(shelters) {
  if (!shelters || shelters.length === 0) {
    return {
      type: "text",
      text: "現在登録されている避難所がありません。"
    };
  }

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

// ── 13. CSVインポートAPI ──
app.post("/import/shelters", express.text({ type: "*/*" }), async (req, res) => {
  try {
    const csvText = req.body;

    if (!csvText || csvText.length === 0) {
      return res.status(400).send("CSVデータが空です");
    }

    const result = await importSheltersFromCsv(csvText);

    let responseMsg = `【インポート結果】\n成功: ${result.successCount} / ${result.totalLines} 件\n`;
    if (result.errors.length > 0) {
      responseMsg += `\n⚠️ 以下のエラーが発生しました:\n` + result.errors.join("\n");
    }

    return res.status(200).send(responseMsg);
  } catch (err) {
    console.error("CSV Import error:", err);
    return res.status(500).send("CSVインポートに失敗しました: " + err.message);
  }
});

// ── 12. 危険箇所QR（hazard?id=xxx）エンドポイント ──
app.get("/hazard", async (req, res) => {
  try {
    const hazardId = req.query.id;

    if (!hazardId) {
      return res.status(400).send("hazard id is missing");
    }

    const doc = await db.collection("hazards").doc(hazardId).get();

    if (!doc.exists) {
      return res.status(404).send(`hazard '${hazardId}' not found`);
    }

    const hazard = doc.data();
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${hazard.lat},${hazard.lng}`;
    const targetUserId = hazard.notifyUserId || hazard.defaultUserId;

    if (!targetUserId) {
      console.warn("No target userId found for hazard:", hazardId);
      return res.status(400).send("Target userId for notification is not set");
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

          return await client.replyMessage({
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

    // 2. 位置情報（Location）メッセージ処理
    if (event.type === "message" && event.message.type === "location") {
      const lat = event.message.latitude;
      const lng = event.message.longitude;

      if (!isValidJapanCoordinate(lat, lng)) {
        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: "⚠️ 日本国内の有効な位置情報を送信してください。" }]
        });
      }

      if (!session) {
        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: "避難訓練が開始されていません。「スタート」と送信して目標避難所を選択してください。" }]
        });
      }

      // A. スタート位置の記録
      if (session.status === "WAITING_START_LOCATION") {
        const now = getJapanNowTimestamp();
        const shelter = session.targetShelter;

        const routeData = await getWalkingRoute(lat, lng, shelter.lat, shelter.lng);

        session.startLocation = { lat, lng };
        session.startTime = now;
        session.startTimeMs = now;
        session.initialDistance = routeData.distanceMeters;
        session.status = "IN_PROGRESS";
        await saveSession(userId, session);

        const startTimeStr = formatJapanTime(now);
        const distStr = formatDistance(routeData.distanceMeters);

        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                `🚀 避難計測を開始しました！（${startTimeStr}）\n\n` +
                `🎯 目標避難所: ${shelter.name}\n` +
                `📏 推定避難距離: ${distStr}\n\n` +
                `${routeData.notice}` +
                `安全に気を配りながら目標地点へ移動してください。\n` +
                `到着後、または終了時は「ゴール」と送信してください。`
            }
          ]
        });
      }

      // B. ゴール位置の記録と最終計算
      if (session.status === "WAITING_GOAL_LOCATION") {
        const goalTime = session.goalTime || getJapanNowTimestamp();
        const shelter = session.targetShelter;
        const startLoc = session.startLocation;

        const walkedRoute = await getWalkingRoute(startLoc.lat, startLoc.lng, lat, lng);
        const remRoute = await getWalkingRoute(lat, lng, shelter.lat, shelter.lng);

        const elapsedSeconds = Math.round((goalTime - session.startTimeMs) / 1000);
        const mins = Math.floor(elapsedSeconds / 60);
        const secs = elapsedSeconds % 60;
        const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;

        const isArrived = remRoute.distanceMeters <= 100;
        const drillId = `drill_${Date.now()}`;

        // ポイント計算
        let pointsEarned = 0;
        if (isArrived) {
          pointsEarned = 100;
        } else if (walkedRoute.distanceMeters > 0) {
          pointsEarned = 30;
        }

        // Firestoreのポイント更新
        if (pointsEarned > 0) {
          try {
            const userRef = db.collection("users").doc(userId);
            const userDoc = await userRef.get();
            const currentPoints = userDoc.exists ? (userDoc.data().points || 0) : 0;
            await userRef.set({ points: currentPoints + pointsEarned }, { merge: true });
          } catch (e) {
            console.error("Point update error:", e.message);
          }
        }

        const logData = {
          drillId,
          userId,
          shelterId: shelter.id,
          shelterName: shelter.name,
          shelterCity: shelter.city || "",
          startTime: toJapanISOString(session.startTimeMs),
          endTime: toJapanISOString(goalTime),
          elapsedSeconds,
          startLat: startLoc.lat,
          startLng: startLoc.lng,
          goalLat: lat,
          goalLng: lng,
          walkedDistanceMeters: walkedRoute.distanceMeters,
          initialDistanceMeters: session.initialDistance,
          remainingDistanceMeters: remRoute.distanceMeters,
          isArrived,
          achievementLevel: isArrived ? "GOAL" : "PARTIAL",
          routeSource: walkedRoute.isRouteApi ? "GoogleRoutesAPI" : "Haversine"
        };

        await saveEvacuationLog(logData);
        await deleteSession(userId);

        const statusMsg = isArrived
          ? `🎉 目標避難所「${shelter.name}」に無事到着しました！`
          : `🏁 避難計測を終了しました。（目標まであと ${formatDistance(remRoute.distanceMeters)}）`;

        const pointMsg = pointsEarned > 0
          ? `\n🎁 避難訓練の実施により ${pointsEarned} pt を獲得しました！`
          : "";

        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                `📊 【避難訓練 結果レポート】\n━━━━━━━━━━━━━━\n` +
                `${statusMsg}\n\n` +
                `⏱️ 避難時間: ${timeStr}\n` +
                `🚶 移動距離: ${formatDistance(walkedRoute.distanceMeters)}\n` +
                `${pointMsg}\n\n` +
                `おつかれさまでした！日頃からの備えと経路の確認を心がけましょう。`
            }
          ]
        });
      }
    }

    // 3. テキストメッセージ処理
    if (event.type === "message" && event.message.type === "text") {
      const text = event.message.text.trim();

      // ── A. 「スタート」 ──
      if (text === "スタート" || text === "開始" || text === "避難訓練") {
        await deleteSession(userId);
        const shelters = await getShelterList();

        return await client.replyMessage({
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
          return await client.replyMessage({
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
            return await client.replyMessage({
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

          return await client.replyMessage({
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

        // ③ 「使い方」
        if (text === "使い方" || text === "つかいかた" || text === "ヘルプ" || text === "help") {
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: getHelpMessage()
              }
            ]
          });
        }

        // ④ 訓練中の未定義メッセージに対する応答（フォールバック）
        let fallbackMsg = "現在避難訓練中です。\n";
        if (session.status === "WAITING_START_LOCATION") {
          fallbackMsg += "LINEの「＋」ボタンからスタート地点の【位置情報】を送信してください。";
        } else if (session.status === "IN_PROGRESS") {
          fallbackMsg += "目標避難所に到着したら「ゴール」と送信してください。";
        } else if (session.status === "WAITING_GOAL_LOCATION") {
          fallbackMsg += "LINEの「＋」ボタンから現在の【位置情報】を送信してください。";
        }

        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: fallbackMsg }]
        });
      }

      // ── C. 未開始時の場合 ──
      if (!session) {
        // ① 避難所一覧
        if (text === "避難所") {
          const shelters = await getShelterList();
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: "📍 登録されている避難所の一覧です。\n地図リンクから場所を確認できます。"
              },
              createShelterFlex(shelters)
            ]
          });
        }

        // ② 避難所詳細（避難所 ○○）
        if (text.startsWith("避難所 ")) {
          const name = text.replace("避難所 ", "").trim();
          const shelters = await getShelterList();
          const shelter = shelters.find(s => s.name === name);

          if (!shelter) {
            return await client.replyMessage({
              replyToken: event.replyToken,
              messages: [
                { type: "text", text: `「${name}」という避難所は見つかりませんでした。` }
              ]
            });
          }

          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text:
                  `🏢 ${shelter.name}\n` +
                  `📍 住所: ${shelter.address}\n` +
                  `🌐 座標: ${shelter.lat}, ${shelter.lng}\n\n` +
                  `地図: https://www.google.com/maps/search/${shelter.lat},${shelter.lng}`
              }
            ]
          });
        }

        // ③ 使い方
        if (text === "使い方" || text === "つかいかた" || text === "ヘルプ" || text === "help") {
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: getHelpMessage()
              }
            ]
          });
        }

        // ④ 履歴
        if (text === "履歴" || text === "りれき" || text === "記録" || text === "history") {
          const history = await getUserHistory(userId, 5);
          if (!history || history.length === 0) {
            return await client.replyMessage({
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

          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: historyMsg }]
          });
        }

        // ⑤ 通常会話へのデフォルト案内
        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "訓練を始めるには「スタート」、使い方を見るには「使い方」と送信してください。"
            }
          ]
        });
      }
    }

    return null;
  } catch (err) {
    console.error("handleEvent Error:", err);
    return null;
  }
}

// ── 14. サーバー起動 ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
