# LINE 群組訊息歸檔與公開儀表板

這是一個單一 Cloud Run 服務：同時接收 LINE Messaging API Webhook、把訊息寫入 Google Sheets、把圖片/檔案存到 Google Drive、用 Gemini 產生文字分類與摘要，並提供一個「公開摘要 + 密碼後完整紀錄」的入口頁。

## 可以怎麼用

- 群組知識歸檔：把 LINE 群組裡的重要討論、圖片、檔案整理到 Sheets/Drive。
- 公開進度頁：公開頁只顯示摘要、統計、近期項目，適合給不在群組內的人看概況。
- 管理查詢頁：輸入管理密碼後，可搜尋完整原文、分類、摘要，並透過後端代理預覽私有 Drive 媒體。

沒有 Google、LINE、Gemini 憑證時，專案會使用本機記憶體 demo 資料，方便先看畫面與 API。

## 本機啟動

```bash
cp .env.example .env
npm install
npm run dev
```

開啟 `http://localhost:8080`。預設 `.env.example` 的 `DASHBOARD_PASSWORD=change-me`，本機測試登入時請改成自己的密碼。

送一筆本機 sample webhook：

```bash
npm run sample:webhook
```

## 需要申請與設定的資料

### 1. LINE Messaging API

1. 到 LINE Developers 建立 Provider。
2. 建立 Messaging API channel，並綁定或建立 LINE Official Account。
3. 在 channel 取得：
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
4. 部署後把 Webhook URL 設為：
   - `https://你的-cloud-run-url/webhook/line`
5. Cloud Run 上務必設定 `ALLOW_UNSIGNED_WEBHOOKS=false`。

### 2. Google Cloud / Cloud Run

1. 建立 Google Cloud Project。
2. 啟用 Cloud Run、Secret Manager、Google Drive API、Google Sheets API。
3. Cloud Run 使用 request-based billing 並把 min instances 設為 `0`，通常可落在免費額度內；但 Cloud Run 免費層仍可能需要綁定 Billing，超過免費額度會收費。

### 3. Google Sheets / Drive

1. 建立一份 Google Sheets，工作表名稱建議 `Records`。
2. 建立一個 Google Drive 資料夾存放媒體。
3. 建立 Service Account，取得 JSON key。
4. 把 Sheets 與 Drive 資料夾分享給 service account email。
5. 設定環境變數：
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_SHEET_NAME=Records`
   - `GOOGLE_DRIVE_FOLDER_ID`
   - `GOOGLE_SERVICE_ACCOUNT_JSON`，可放原始 JSON 或 base64 後的 JSON。

### 4. Gemini API

1. 到 Google AI Studio 建立 API key。
2. 設定：
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL=gemini-2.5-flash`
   - `GEMINI_DAILY_LIMIT=50`
3. 若想先省額度，可設定 `GEMINI_TEXT_ANALYSIS_ENABLED=false`，系統會使用本機規則分類。

## 主要環境變數

| 變數 | 說明 |
| --- | --- |
| `DASHBOARD_PASSWORD` | 管理頁登入密碼 |
| `SESSION_SECRET` | 簽署登入 cookie 的長隨機字串 |
| `LINE_CHANNEL_SECRET` | LINE Webhook 簽章驗證 |
| `LINE_CHANNEL_ACCESS_TOKEN` | 下載 LINE 圖片/檔案內容 |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | 寫入與讀取紀錄的 spreadsheet id |
| `GOOGLE_DRIVE_FOLDER_ID` | 儲存媒體的 Drive folder id |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | service account JSON 或 base64 JSON |
| `GEMINI_API_KEY` | Gemini API key |
| `GEMINI_DAILY_LIMIT` | 每個服務實例每日 Gemini 文字分析上限 |

## GitHub 自動部署到 Cloud Run

本專案已內建 Git-backed deployment workflow：`.github/workflows/deploy-cloud-run.yml`。推送到 `main` 或 `master` 時，GitHub Actions 會先跑測試與 build，再用 Google 官方 Cloud Run Action 從 GitHub 原始碼部署。

### GitHub repo variables

到 GitHub repo 的 `Settings > Secrets and variables > Actions > Variables` 新增：

| 名稱 | 範例 | 說明 |
| --- | --- | --- |
| `GCP_PROJECT_ID` | `my-line-bot-project` | Google Cloud project id |
| `CLOUD_RUN_SERVICE` | `line-bot` | Cloud Run service 名稱 |
| `CLOUD_RUN_REGION` | `asia-east1` | Cloud Run region，台灣附近建議 `asia-east1` |
| `APP_BASE_URL` | `https://...run.app` | 第一次部署後再填 Cloud Run URL；LINE Webhook 會用這個 URL 加 `/webhook/line` |

### GitHub repo secrets

到 `Settings > Secrets and variables > Actions > Secrets` 新增：

| 名稱 | 說明 |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Provider 完整 resource name |
| `GCP_SERVICE_ACCOUNT` | GitHub Actions 用的 deploy service account email |

應用程式密碼不要放 GitHub repo；請放 Google Secret Manager，再在 Cloud Run 服務上掛成環境變數：

| Secret Manager 名稱 | 對應環境變數 |
| --- | --- |
| `line-bot-dashboard-password` | `DASHBOARD_PASSWORD` |
| `line-bot-session-secret` | `SESSION_SECRET` |
| `line-channel-secret` | `LINE_CHANNEL_SECRET` |
| `line-channel-access-token` | `LINE_CHANNEL_ACCESS_TOKEN` |
| `line-bot-user-hash-salt` | `USER_HASH_SALT` |
| `line-bot-google-service-account-json` | `GOOGLE_SERVICE_ACCOUNT_JSON` |
| `gemini-api-key` | `GEMINI_API_KEY` |

第一次部署完成後，把 Cloud Run URL 填回 GitHub variable `APP_BASE_URL`，並到 LINE Developers 設定 Webhook URL：

```text
https://你的-cloud-run-url/webhook/line
```

## 手動部署到 Cloud Run

先確認已安裝並登入 `gcloud`，且已選好 project。

```bash
npm run build
gcloud run deploy line-group-archive-dashboard \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --set-env-vars NODE_ENV=production,ALLOW_UNSIGNED_WEBHOOKS=false
```

敏感資料建議放 Secret Manager，再用 Cloud Run 的 secret env var 掛入，不要把 `.env` 或 service account JSON commit 到 git。

## API

- `POST /webhook/line`：LINE Webhook 入口，會驗證 `x-line-signature`。
- `GET /api/public/summary`：公開摘要、統計、近期項目。
- `POST /api/admin/login`：用 `DASHBOARD_PASSWORD` 登入。
- `GET /api/admin/records`：登入後查完整紀錄，支援 `search`、`type`、`limit` query。
- `GET /api/admin/media/:fileId`：登入後由後端代理讀取私有 Drive 媒體。
- `GET /healthz`：健康檢查。

## 測試

```bash
npm test
npm run build
```

測試涵蓋 LINE 簽章驗證、公開摘要 API、管理登入與完整紀錄保護。
