#!/usr/bin/env node

/**
 * Firestore に避難所マスタデータを投入するスクリプト
 * 実行方法: node scripts/upload-shelters.js
 */

const admin = require("firebase-admin");
require("dotenv").config();

// ── Firebase Admin SDK 初期化 ──
const initializeFirebase = () => {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      const serviceAccount = JSON.parse(
        raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")
      );
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("✅ Firebase Admin SDK initialized with service account.");
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp();
      console.log("✅ Firebase Admin SDK initialized with ADC.");
    } else {
      throw new Error("Firebase credentials not found in environment variables.");
    }
  } catch (err) {
    console.error("❌ Firebase initialization failed:", err.message);
    process.exit(1);
  }
};

// ── 熊谷市 避難所初期マスタデータ ──
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

// ── Firestore へのアップロード処理 ──
const uploadShelters = async () => {
  const db = admin.firestore();

  try {
    console.log(`📤 ${KUMAGAYA_SHELTERS.length} 件の避難所データを Firestore にアップロード中...`);

    const batch = db.batch();

    KUMAGAYA_SHELTERS.forEach((shelter) => {
      const docRef = db.collection("shelters").doc(shelter.id);
      batch.set(docRef, {
        ...shelter,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await batch.commit();

    console.log(`✅ ${KUMAGAYA_SHELTERS.length} 件の避難所データを Firestore にアップロードしました！`);
    console.log("\n📋 アップロードされたデータ:");
    KUMAGAYA_SHELTERS.forEach((shelter, idx) => {
      console.log(`  [${idx + 1}] ${shelter.name} (${shelter.type})`);
    });

    process.exit(0);
  } catch (err) {
    console.error("❌ Firestore upload failed:", err.message);
    process.exit(1);
  }
};

// ── メイン処理 ──
(async () => {
  initializeFirebase();
  await uploadShelters();
})();
