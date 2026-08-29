const express = require("express");
const line = require("@line/bot-sdk");
const { Firestore, FieldValue } = require("@google-cloud/firestore");

// Cloud Run 実行環境のデフォルトサービスアカウントで Firestore (default) に自動接続
const db = new Firestore();

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
const memoryUserPoints = new Map(); // 累計ポイント用メモリマップ

// ── 2. タイムゾーン対応関数 ──
function getJapanNowTimestamp() {
  return Date.now();
}

function toJapanISOString(timestamp) {
  const d = new Date(timestamp);
  const tzOffset = 9 * 60 * 60 * 1000;
  const jpDate = new Date(d.getTime() + tzOffset);

  const YYYY = jpDate.getUTCFullYear();
  const MM = String(jpDate.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(jpDate.getUTCDate()).padStart(2, "0");
  const hh = String(jpDate.getUTCHours()).padStart(2, "0");
  const mm = String(jpDate.getUTCMinutes()).padStart(2, "0");
  const ss = String(jpDate.getUTCSeconds()).padStart(2, "0");

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

// ── 3. 「使い方」テキスト生成関数 ──
function getHelpMessage() {
  return (
    "📖 【避難ウォークBot の使い方】\n\n" +
    "各コマンドを入力した際の動作説明です：\n\n" +
    "🔹「スタート」\n" +
    "避難所一覧が表示されます。目標避難所を選択後、【位置情報】を送信して避難訓練を開始します。\n\n" +
    "🔹「ゴール」\n" +
    "避難所到着時に送信します。現在地の【位置情報】を送ると、避難時間・移動距離・獲得ポイントが表示されます。\n\n" +
    "🔹「リセット」\n" +
    "現在の訓練記録を破棄して中止します。\n\n" +
    "🔹「ポイント」／「残高」\n" +
    "現在の保有ポイント残高を確認できます。\n\n" +
    "🔹「ポイント使用」／「ポイント利用 [pt]」\n" +
    "商店街の加盟店でポイントを利用します（例：「ポイント使用 100」）。\n\n" +
    "🔹「避難所」\n" +
    "登録避難所一覧を表示します。\n\n" +
    "🔹「履歴」\n" +
    "過去の訓練記録（直近5件）を表示します。\n\n" +
    "🔹「使い方」／「ヘルプ」\n" +
    "この操作説明を表示します。\n\n" +
    "🏆 【ポイント獲得ルール】\n" +
    "・目標まで残り 500m 以内: +1 pt\n" +
    "・目標まで残り 300m 以内: さらに +1 pt (計 2 pt)\n" +
    "・ゴール到達（50m 以内）: さらに +3 pt (計 5 pt)\n" +
    "・急勾配／坂道ルート踏破: +1 pt\n" +
    "※獲得したポイントは商店街の加盟店で 1pt=1円 としてご利用いただけます。\n"
  );
}

// ── 4. セッション管理（Firestore user_sessions） ──
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

// ── 5. ポイント管理関数（users/{userId}/point） ──

// ユーザーの保有ポイント残高を取得
async function getUserPoints(userId) {
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      return data.point !== undefined ? data.point : data.points || data.totalPoints || 0;
    }
  } catch (e) {
    console.error("Firestore getUserPoints error:", e.message);
  }
  return memoryUserPoints.get(userId) || 0;
}

// ユーザーのポイントを加算（訓練ゴール時）
async function addUserPoints(userId, addAmount) {
  let newTotal = 0;
  try {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const current = userDoc.exists
      ? userDoc.data().point !== undefined
        ? userDoc.data().point
        : userDoc.data().points || userDoc.data().totalPoints || 0
      : 0;

    newTotal = current + addAmount;

    await userRef.set(
      {
        point: newTotal,
        points: newTotal, // 互換性保持
        totalPoints: newTotal, // 互換性保持
        lastEarnedPoints: addAmount,
        lastDrillAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  } catch (e) {
    console.error("Firestore addUserPoints error:", e.message);
    const current = memoryUserPoints.get(userId) || 0;
    newTotal = current + addAmount;
    memoryUserPoints.set(userId, newTotal);
  }
  return newTotal;
}

// ユーザーのポイントを減算（商店街での利用時）
async function consumeUserPoints(userId, useAmount, shopId = "general_shop") {
  try {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return { success: false, message: "ユーザー情報が見つかりません。", remaining: 0 };
    }

    const data = userDoc.data();
    const current = data.point !== undefined ? data.point : data.points || data.totalPoints || 0;

    if (current < useAmount) {
      return {
        success: false,
        message: `ポイントが不足しています。（必要: ${useAmount} pt / 現在: ${current} pt）`,
        remaining: current
      };
    }

    const remaining = current - useAmount;

    // ポイント残高を更新
    await userRef.set(
      {
        point: remaining,
        points: remaining,
        totalPoints: remaining,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    // 取引履歴（レシート）を保存
    await db.collection("point_transactions").add({
      userId,
      shopId,
      usedPoints: useAmount,
      remainingPoints: remaining,
      type: "USE",
      createdAt: FieldValue.serverTimestamp(),
      createdAtIso: toJapanISOString(Date.now())
    });

    return { success: true, remaining, used: useAmount, shopId };
  } catch (e) {
    console.error("consumeUserPoints error:", e.message);
    const current = memoryUserPoints.get(userId) || 0;
    if (current < useAmount) {
      return { success: false, message: "ポイントが不足しています。", remaining: current };
    }
    const remaining = current - useAmount;
    memoryUserPoints.set(userId, remaining);
    return { success: true, remaining, used: useAmount, shopId };
  }
}

// ── 6. ログ保存 & 履歴取得（Firestore evacuation_logs） ──
async function saveEvacuationLog(logData) {
  try {
    await db.collection("evacuation_logs").doc(logData.drillId).set({
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
      .get();

    if (!snapshot.empty) {
      const logs = snapshot.docs.map((d) => d.data());
      return logs
        .sort((a, b) => {
          const timeA = typeof a.startTime === "number" ? a.startTime : new Date(a.startTime).getTime();
          const timeB = typeof b.startTime === "number" ? b.startTime : new Date(b.startTime).getTime();
          return timeB - timeA;
        })
        .slice(0, limitCount);
    }
  } catch (e) {
    console.error("Firestore getUserHistory error:", e.message);
  }

  return memoryLogs
    .filter((l) => l.userId === userId)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
    .slice(0, limitCount);
}

// ── 7. 避難所マスタ取得（Firestore shelters コレクション） ──
async function getShelterList() {
  try {
    const snapshot = await db.collection("shelters").get();
    if (!snapshot.empty) {
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      }));
    }
    console.warn("⚠️ Firestore の 'shelters' コレクションにデータが存在しません。");
    return [];
  } catch (e) {
    console.error("❌ Firestore shelters 取得エラー:", e.message);
    return [];
  }
}

// ── 7.5. Google Maps Geocoding API ──
async function geocodeAddress(item) {
  const apiKey = config.googleMapsApiKey;
  if (!apiKey) {
    throw new Error("Google Maps API Key が設定されていません");
  }

  const fullAddress = `${item.prefecture || ""}${item.city || ""}${item.address || ""}`.trim();
  const fallbackQuery = `${item.prefecture || ""}${item.city || ""}${item.name || ""}`.trim();

  const fetchCoords = async (query) => {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      query
    )}&key=${apiKey}`;
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
      throw new Error(
        `位置情報を特定できませんでした（検索クエリ: "${fullAddress}" / "${fallbackQuery}"）`
      );
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

// ── 7.6. CSVインポート処理 ──
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function importSheltersFromCsv(csvText) {
  const cleanCsvText = csvText.replace(/^\uFEFF/, "");
  const lines = cleanCsvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error("CSVデータにヘッダーまたはデータが存在しません");
  }

  const parseCsvLine = (line) => {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current.replace(/^"|"$/g, "").trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.replace(/^"|"$/g, "").trim());
    return result;
  };

  const rawHeader = parseCsvLine(lines[0]);
  const headerMap = {};

  rawHeader.forEach((h, index) => {
    headerMap[h.toLowerCase()] = index;
  });

  const requiredFields = ["id", "name", "address", "type", "city", "prefecture", "tagcolor"];
  const missingFields = requiredFields.filter((f) => !(f in headerMap));

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
      await sleep(200);
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

// ── 8. 位置情報ガード ──
function isValidJapanCoordinate(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
    return false;
  }
  return lat >= 20.0 && lat <= 46.0 && lng >= 122.0 && lng <= 154.0;
}

// ── 9. 距離・時間計算（Routes API ＆ Directions API） ──
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * ルート上の標高データ（高低差・急勾配・坂道）を取得・判定
 */
async function checkElevationAndSteepSlope(originLat, originLng, destLat, destLng) {
  const apiKey = config.googleMapsApiKey;
  if (!apiKey) return { hasSteepSlope: false, elevationGain: 0 };

  try {
    const url = `https://maps.googleapis.com/maps/api/elevation/json?path=${originLat},${originLng}|${destLat},${destLng}&samples=5&key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return { hasSteepSlope: false, elevationGain: 0 };

    const data = await response.json();
    if (data.status === "OK" && data.results && data.results.length >= 2) {
      let maxElevationDiff = 0;
      let prev = data.results[0].elevation;

      for (let i = 1; i < data.results.length; i++) {
        const curr = data.results[i].elevation;
        const diff = curr - prev;
        if (diff > maxElevationDiff) {
          maxElevationDiff = diff;
        }
        prev = curr;
      }

      const totalDist = calculateHaversineDistance(originLat, originLng, destLat, destLng);
      const slopePercentage = totalDist > 0 ? (maxElevationDiff / totalDist) * 100 : 0;
      const isSteep = slopePercentage >= 8.0 || maxElevationDiff >= 15.0;

      return {
        hasSteepSlope: isSteep,
        elevationGain: Math.round(maxElevationDiff)
      };
    }
  } catch (err) {
    console.warn("Elevation API check failed:", err.message);
  }
  return { hasSteepSlope: false, elevationGain: 0 };
}

async function getWalkingRoute(originLat, originLng, destLat, destLng) {
  const apiKey = config.googleMapsApiKey;

  if (apiKey) {
    // 1. Google Maps Routes API を試行
    try {
      const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
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
      }
    } catch (err) {
      console.warn("Routes API 接続エラー:", err.message);
    }

    // 2. Directions API でリトライ
    try {
      const dirUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${originLat},${originLng}&destination=${destLat},${destLng}&mode=walking&key=${apiKey}`;
      const dirResponse = await fetch(dirUrl);
      if (dirResponse.ok) {
        const dirData = await dirResponse.json();
        if (dirData.status === "OK" && dirData.routes && dirData.routes.length > 0) {
          const leg = dirData.routes[0].legs[0];
          const distanceMeters = leg.distance ? leg.distance.value : 0;
          const durationSeconds = leg.duration ? leg.duration.value : Math.round(distanceMeters / 1.33);

          return {
            distanceMeters,
            durationSeconds,
            isRouteApi: true,
            notice: ""
          };
        }
      }
    } catch (dirErr) {
      console.warn("Directions API 接続エラー:", dirErr.message);
    }
  }

  // 3. フォールバック
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

// ── 10. Flex Message カルーセル生成 ──
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
                text: `北緯 ${Number(shelter.lat).toFixed(4)} / 東経 ${Number(shelter.lng).toFixed(4)}`,
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

// ── 11. Express アプリケーション設定 ──
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

// B. 商店街 店舗QR用 ポイント使用エンドポイント (/usePoint)
app.get("/usePoint", async (req, res) => {
  const shopId = req.query.shopId || "001";
  const userId = req.query.userId;
  const usePoint = parseInt(req.query.points || "100", 10);

  if (!userId) {
    return res.status(400).send("<html><body><h2>⚠️ ユーザーIDが指定されていません。</h2></body></html>");
  }

  const result = await consumeUserPoints(userId, usePoint, shopId);

  if (!result.success) {
    return res.status(400).send(`<html><body><h2>⚠️ ${result.message}</h2><p>現在の残高: ${result.remaining} pt</p></body></html>`);
  }

  // LINE にプッシュ通知でレシートを送る
  try {
    await client.pushMessage({
      to: userId,
      messages: [
        {
          type: "text",
          text:
            `🛍️ 【商店街ポイント利用完了】\n━━━━━━━━━━━━━━\n` +
            `🏪 店舗ID: ${shopId}\n` +
            `💸 ご利用ポイント: ${usePoint} pt\n` +
            `🪙 残りポイント残高: ${result.remaining} pt\n` +
            `━━━━━━━━━━━━━━\nご利用ありがとうございました！`
        }
      ]
    });
  } catch (pushErr) {
    console.warn("LINE push message error:", pushErr.message);
  }

  return res.status(200).send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family: sans-serif; text-align: center; padding: 40px 20px;">
        <h1 style="color: #27ae60;">🎉 ポイント利用完了</h1>
        <p style="font-size: 18px;">店舗: <strong>${shopId}</strong></p>
        <p style="font-size: 24px; color: #e74c3c; font-weight: bold;">-${usePoint} pt</p>
        <p style="font-size: 16px; color: #555;">残りポイント残高: <strong>${result.remaining} pt</strong></p>
        <p style="margin-top: 30px; font-size: 14px; color: #888;">LINEに利用通知を送信しました。この画面を閉じてください。</p>
      </body>
    </html>
  `);
});

// C. 研究用 CSV エクスポートエンドポイント
app.get("/export/csv", async (req, res) => {
  const reqKey = req.query.key;
  if (reqKey !== config.adminExportKey) {
    return res.status(403).send("Unauthorized: Invalid export key.");
  }

  try {
    const snapshot = await db.collection("evacuation_logs").orderBy("startTime", "desc").get();
    const logs = snapshot.docs.map((d) => d.data());

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
      "pointsEarned",
      "totalPointsAfterDrill",
      "hasSteepSlope",
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
      l.pointsEarned || 0,
      l.totalPointsAfterDrill || 0,
      l.hasSteepSlope ? "TRUE" : "FALSE",
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

// D. CSVインポートAPI
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

// E. 危険箇所QRエンドポイント
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

// ── 12. メインイベント振り分けハンドラ ──
async function handleEvent(event) {
  const userId = event.source.userId || "anonymous";

  try {
    let session = await getSession(userId);

    // 1. Postback イベント処理
    if (event.type === "postback") {
      try {
        const data = JSON.parse(event.postback.data);

        // 避難所選択
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
            startTimeMs: null,
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

        // ポイント利用確認（Postback）
        if (data.action === "confirm_use_point") {
          const useAmount = data.points || 100;
          const shopId = data.shopId || "001";
          const result = await consumeUserPoints(userId, useAmount, shopId);

          if (!result.success) {
            return await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: "text", text: `⚠️ ${result.message}` }]
            });
          }

          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text:
                  `🛍️ 【ポイント利用完了】\n━━━━━━━━━━━━━━\n` +
                  `🏪 店舗: ${shopId}\n` +
                  `💸 ${useAmount} pt を使用しました。\n` +
                  `🪙 残りポイント残高: ${result.remaining} pt\n` +
                  `━━━━━━━━━━━━━━\nご利用ありがとうございました！`
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

      // ── A. 「ポイント確認」コマンド ──
      if (
        text === "ポイント" ||
        text === "ポイント確認" ||
        text === "残高" ||
        text === "point" ||
        text === "points"
      ) {
        const currentPoints = await getUserPoints(userId);
        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                `🪙 【ポイント残高確認】\n━━━━━━━━━━━━━━\n` +
                `現在の保有ポイント: ${currentPoints} pt\n` +
                `━━━━━━━━━━━━━━\n\n` +
                `🏪 商店街の加盟店で 1pt = 1円 としてご利用いただけます！\n` +
                `・「ポイント使用 100」のように送信するか、店頭のQRコードを読み取ってご利用ください。`
            }
          ]
        });
      }

      // ── B. 「ポイント使用」コマンド（商店街での減算処理） ──
      if (text.startsWith("ポイント使用") || text.startsWith("ポイント利用") || text.startsWith("ポイントを使う")) {
        // 例: 「ポイント使用 100」や「ポイント使用 50 001」など
        const parts = text.split(/\s+/);
        let useAmount = 100; // デフォルト100pt
        let shopId = "商店街加盟店";

        if (parts.length >= 2 && !isNaN(parseInt(parts[1], 10))) {
          useAmount = parseInt(parts[1], 10);
        }
        if (parts.length >= 3) {
          shopId = parts[2];
        }

        const result = await consumeUserPoints(userId, useAmount, shopId);

        if (!result.success) {
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: `⚠️ ${result.message}` }]
          });
        }

        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                `🛍️ 【ポイント利用完了】\n━━━━━━━━━━━━━━\n` +
                `🏪 ご利用店舗: ${shopId}\n` +
                `💸 ${useAmount} pt を使用しました。\n` +
                `🪙 残りポイント残高: ${result.remaining} pt\n` +
                `━━━━━━━━━━━━━━\nまたのご利用をお待ちしております！`
            }
          ]
        });
      }

      // ── C. 「スタート」コマンド ──
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

      // ── D. 訓練中のテキストコマンド処理 ──
      if (session) {
        // リセット
        if (text === "リセット" || text === "中止" || text === "キャンセル") {
          await deleteSession(userId);
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text:
                  "避難訓練の記録をリセットしました。\n新しく訓練を始めるには「スタート」と送信してください。"
              }
            ]
          });
        }

        // ゴール
        if (text === "ゴール" || text === "到着" || text === "避難完了" || text === "終了") {
          if (!session.startLocation || !session.startTimeMs) {
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

        // 使い方・ヘルプ
        if (text === "使い方" || text === "つかいかた" || text === "ヘルプ" || text === "help") {
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: getHelpMessage() }]
          });
        }

        // 訓練中のフォールバック案内
        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                "現在、避難訓練の計測中です。\n\n" +
                "・ゴールする場合は「ゴール」と送信\n" +
                "・やり直す場合は「リセット」と送信してください。"
            }
          ]
        });
      }

      // ── E. 訓練前の避難所・履歴・案内 ──

      // 避難所一覧
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

      // 避難所詳細
      if (text.startsWith("避難所 ")) {
        const name = text.replace("避難所 ", "").trim();
        const shelters = await getShelterList();
        const shelter = shelters.find((s) => s.name && s.name.includes(name));

        if (!shelter) {
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: `「${name}」に一致する避難所は見つかりませんでした。` }]
          });
        }

        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                `🏢 ${shelter.name}\n` +
                `📍 住所: ${shelter.address || "住所情報なし"}\n` +
                `🌐 座標: ${shelter.lat}, ${shelter.lng}\n\n` +
                `地図: https://www.google.com/maps/search/${shelter.lat},${shelter.lng}`
            }
          ]
        });
      }

      // 使い方・ヘルプ
      if (text === "使い方" || text === "つかいかた" || text === "ヘルプ" || text === "help") {
        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: getHelpMessage() }]
        });
      }

      // 履歴表示
      if (text === "履歴" || text === "りれき" || text === "記録" || text === "history") {
        const [history, currentTotalPoints] = await Promise.all([
          getUserHistory(userId, 5),
          getUserPoints(userId)
        ]);

        if (!history || history.length === 0) {
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text:
                  `🪙 現在の保有ポイント: ${currentTotalPoints} pt\n\n` +
                  "📋 過去の避難訓練記録はまだありません。\n「スタート」と送信して避難訓練を開始しましょう！"
              }
            ]
          });
        }

        let historyMsg =
          `🪙 現在の保有ポイント: ${currentTotalPoints} pt\n\n` +
          `📋 【過去の避難訓練履歴（直近5件）】\n━━━━━━━━━━━━━━\n`;

        history.forEach((h, idx) => {
          const startTimestamp =
            typeof h.startTime === "number" ? h.startTime : new Date(h.startTime).getTime();
          const dateStr = formatJapanDate(startTimestamp);

          const mins = Math.floor((h.elapsedSeconds || 0) / 60);
          const secs = (h.elapsedSeconds || 0) % 60;
          const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
          const distStr = formatDistance(h.walkedDistanceMeters || 0);
          const statusIcon = h.isArrived ? "🎉 到着" : "🏁 途中終了";
          const ptStr = h.pointsEarned !== undefined ? ` (+${h.pointsEarned}pt)` : "";

          historyMsg +=
            `[第${idx + 1}回] ${dateStr}\n` +
            `🏢 ${h.shelterName || "避難所"}\n` +
            `⏱️ 避難時間: ${timeStr} / 🚶 移動距離: ${distStr}\n` +
            `結果: ${statusIcon}${ptStr}\n` +
            `──────────────────\n`;
        });
        historyMsg += "訓練を新しく始めるには「スタート」と送信してください。";

        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: historyMsg }]
        });
      }

      // デフォルト案内
      return await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "メッセージありがとうございます。\n\n" +
              "【ご利用方法】\n" +
              "・「スタート」: 避難訓練を開始します\n" +
              "・「ポイント」: 保有ポイント残高を確認します\n" +
              "・「ポイント使用」: 商店街でポイントを利用します\n" +
              "・「避難所」: 登録されている避難所一覧を表示します\n" +
              "・「履歴」: 過去の訓練結果を表示します\n" +
              "・「使い方」: 操作説明を表示します"
          }
        ]
      });
    }

    // 3. 位置情報メッセージ処理
    if (event.type === "message" && event.message.type === "location") {
      const lat = event.message.latitude;
      const lng = event.message.longitude;

      if (!isValidJapanCoordinate(lat, lng)) {
        return await client.replyMessage({
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

      // 訓練前：最寄り避難所検索
      if (!session) {
        const shelters = await getShelterList();
        let nearest = null;
        let minDist = Infinity;

        shelters.forEach((s) => {
          const d = calculateHaversineDistance(lat, lng, s.lat, s.lng);
          if (d < minDist) {
            minDist = d;
            nearest = s;
          }
        });

        if (!nearest) {
          return await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: "近くの避難所情報を取得できませんでした。" }]
          });
        }

        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                `📍 最寄りの避難所は「${nearest.name}」です。\n` +
                `距離: ${Math.round(minDist)}m\n` +
                `住所: ${nearest.address || "住所情報なし"}\n\n` +
                `地図: https://www.google.com/maps/search/${nearest.lat},${nearest.lng}`
            }
          ]
        });
      }

      // 訓練中：スタート位置処理
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
                `${routeData.notice || ""}` +
                `安全に気を配りながら目標地点へ移動してください。\n` +
                `到着後、または終了時は「ゴール」と送信してください。`
            }
          ]
        });
      }

      // 訓練中：ゴール位置処理
      if (session.status === "WAITING_GOAL_LOCATION") {
        const goalTime = session.goalTime || getJapanNowTimestamp();
        const shelter = session.targetShelter;
        const startLoc = session.startLocation;

        const [walkedRoute, remRoute, elevationInfo] = await Promise.all([
          getWalkingRoute(startLoc.lat, startLoc.lng, lat, lng),
          getWalkingRoute(lat, lng, shelter.lat, shelter.lng),
          checkElevationAndSteepSlope(startLoc.lat, startLoc.lng, lat, lng)
        ]);

        const elapsedSeconds = Math.max(0, Math.round((goalTime - session.startTimeMs) / 1000));
        const mins = Math.floor(elapsedSeconds / 60);
        const secs = elapsedSeconds % 60;
        const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;

        const directDistToShelter = calculateHaversineDistance(lat, lng, shelter.lat, shelter.lng);
        const remainingMeters = Math.min(directDistToShelter, remRoute.distanceMeters);

        // ── 1. 今回の獲得ポイント計算 ──
        let pointsEarned = 0;
        const pointDetails = [];

        // ① 500m以内圏内 (+1 pt)
        if (remainingMeters <= 500) {
          pointsEarned += 1;
          pointDetails.push("500m圏内接近 (+1pt)");
        }

        // ② 300m以内圏内 (さらに +1 pt)
        if (remainingMeters <= 300) {
          pointsEarned += 1;
          pointDetails.push("300m圏内接近 (+1pt)");
        }

        // ③ ゴール（50m以内到達） (さらに +3 pt)
        const isArrived = remainingMeters <= 50;
        if (isArrived) {
          pointsEarned += 3;
          pointDetails.push("避難所ゴール到達 (+3pt)");
        }

        // ④ 急勾配・坂道ルート踏破ボーナス (+1 pt)
        if (elevationInfo.hasSteepSlope) {
          pointsEarned += 1;
          pointDetails.push(`急勾配・難所ルート踏破 (+1pt / 標高差約${elevationInfo.elevationGain}m)`);
        }

        // ── 2. Firestore の users/{userId}/point に累計加算 ──
        const totalPoints = await addUserPoints(userId, pointsEarned);

        // ── 3. ログ保存 & セッション削除 ──
        const drillId = `${userId}_${Date.now()}`;
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
          remainingDistanceMeters: Math.round(remainingMeters),
          isArrived,
          pointsEarned,
          totalPointsAfterDrill: totalPoints,
          hasSteepSlope: elevationInfo.hasSteepSlope,
          elevationGain: elevationInfo.elevationGain,
          achievementLevel: isArrived ? "GOAL" : remainingMeters <= 300 ? "NEAR_300M" : remainingMeters <= 500 ? "NEAR_500M" : "PARTIAL",
          routeSource: walkedRoute.isRouteApi ? "ROUTE_API" : "FALLBACK"
        };

        await saveEvacuationLog(logData);
        await deleteSession(userId); // 次回訓練時は0から加算開始

        const statusMsg = isArrived
          ? `🎉 目標避難所「${shelter.name}」に無事到着しました！（残距離 ${Math.round(remainingMeters)}m）`
          : `🏁 避難計測を終了しました。（目標まであと ${formatDistance(remainingMeters)}）`;

        let pointMsg = `🏆 今回の獲得ポイント: +${pointsEarned} pt\n`;
        if (pointDetails.length > 0) {
          pointMsg += `\n【ポイント内訳】\n` + pointDetails.map((d) => `・${d}`).join("\n") + "\n";
        }

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
                `${pointMsg}` +
                `━━━━━━━━━━━━━━\n` +
                `🪙 現在の保有ポイント: ${totalPoints} pt\n` +
                `（※今回の獲得分が加算されました。商店街加盟店で利用できます！）\n\n` +
                `おつかれさまでした！日頃からの備えと経路の確認を心がけましょう。`
            }
          ]
        });
      }

      // 訓練進行中
      if (session.status === "IN_PROGRESS") {
        return await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "現在避難訓練の計測中です。\n目標地点に到着したら「ゴール」とメッセージを送信してください。"
            }
          ]
        });
      }
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

// ── 13. サーバー起動処理 ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Hinan Walk Bot server is running on port ${PORT}`);
  console.log("📅 Timezone: Asia/Tokyo (JST / UTC+9)");
});
