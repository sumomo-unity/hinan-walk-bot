# Node.js の公式イメージを使用
FROM node:18

# 作業ディレクトリを作成
WORKDIR /usr/src/app

# package.json と package-lock.json をコピー
COPY package*.json ./

# 依存関係をインストール
RUN npm install

# アプリケーションのソースコードをコピー
COPY . .

# Cloud Run が使うポート番号を環境変数で受け取る
ENV PORT=8080

# コンテナ起動時に実行するコマンド
CMD ["node", "index.js"]
