# AGENTS.md

本檔是給 Codex / 維護者看的專案操作說明。請先讀完本檔再修改、部署或檢查本專案。

## 協作規則

- 全程使用繁體中文討論與回覆。
- 不要批量刪除檔案，例如 `rm -rf *`。任何破壞性清理都必須先取得使用者明確同意。
- 不要把 `.env`、service account JSON、LINE token、Gemini key、密碼或其他 secret commit 到 git。
- 修改程式後至少跑：`npm test` 與 `npm run build`。
- 若修改 Cloud Run / GitHub Actions / Google API 串接，完成後要驗證 live endpoint。

## 專案概述

本專案是一個 LINE 群組訊息歸檔與公開儀表板，部署為單一 Google Cloud Run 服務。

主要功能：

- 接收 LINE Messaging API Webhook：`POST /webhook/line`
- 驗證 LINE `x-line-signature`
- 文字訊息寫入 Google Sheets
- 圖片與檔案從 LINE content API 下載後上傳 Google Drive
- 使用 Gemini 對文字做分類與摘要
- 提供公開摘要頁與密碼保護的管理頁

目前 repo：

- 本機路徑：`/Users/alien/Desktop/Line-bot`
- GitHub repo：`https://github.com/alien0077/Line-bot`
- Cloud Run service：`line-bot-backup`
- GCP project id：`line-bot-backup-501005`
- Region：`asia-east1`
- Cloud Run URL：`https://line-bot-backup-4a6j4fxaxq-de.a.run.app`
- LINE Webhook URL：`https://line-bot-backup-4a6j4fxaxq-de.a.run.app/webhook/line`

## 技術架構

- Runtime：Node.js 22+
- Language：TypeScript
- Web framework：Express
- Hosting：Google Cloud Run
- CI/CD：GitHub Actions Git-backed deployment
- Storage：Google Sheets + Google Drive
- AI：Gemini API
- Secrets：Google Cloud Secret Manager

重要目錄：

- `src/app.ts`：Express app 與 route 掛載
- `src/routes/webhook.ts`：LINE Webhook 入口
- `src/routes/api.ts`：公開摘要、管理登入、完整紀錄與媒體代理 API
- `src/services/googleWorkspace.ts`：Google Sheets / Drive 串接
- `src/services/gemini.ts`：Gemini 分析
- `src/services/line.ts`：LINE 簽章驗證與內容下載
- `src/services/store.ts`：Sheets 或 memory store 切換
- `public/`：儀表板前端
- `.github/workflows/deploy-cloud-run.yml`：GitHub Actions 自動部署設定

## 常用指令

```bash
npm install
npm run dev
npm test
npm run build
npm run lint
npm run sample:webhook
```

本機開發預設使用 `.env`。Cloud Run 不使用 `.env`，而是從 GitHub variables 與 Google Secret Manager 掛入環境變數。

## API 與驗證

主要端點：

- `GET /`：儀表板首頁
- `GET /healthz/`：健康檢查。注意目前帶尾斜線 `/healthz/` 已驗證正常。
- `POST /webhook/line`：LINE Webhook。沒有正確 LINE 簽章時應回 `401 LINE Webhook 簽章驗證失敗`。
- `GET /api/public/summary`：公開摘要。正式接上 Sheets / Gemini 後應看到 `storageMode: "sheets"` 與 `analysisMode: "gemini"`。
- `POST /api/admin/login`：管理登入。
- `GET /api/admin/records`：管理完整紀錄，未登入時應回 `401 請先登入`。
- `GET /api/admin/media/:fileId`：管理模式下代理讀取 Drive 私有媒體。

live smoke test：

```bash
curl -i https://line-bot-backup-4a6j4fxaxq-de.a.run.app/api/public/summary
curl -i -X POST https://line-bot-backup-4a6j4fxaxq-de.a.run.app/webhook/line \
  -H 'Content-Type: application/json' \
  -d '{}'
```

第二個假 webhook 應回 401，這代表簽章驗證有啟用，是正常結果。

## GitHub Actions Variables

這些設定放在 GitHub repo：`Settings > Secrets and variables > Actions > Variables`。

| 名稱 | 目前用途 | 值的格式 |
| --- | --- | --- |
| `GCP_PROJECT_ID` | GitHub Actions 部署到哪個 GCP project | GCP project id，例如 `line-bot-backup-501005` |
| `CLOUD_RUN_SERVICE` | 要部署的 Cloud Run service 名稱 | 例如 `line-bot-backup` |
| `CLOUD_RUN_REGION` | Cloud Run region | 例如 `asia-east1` |
| `APP_BASE_URL` | App 對外 URL，程式與部署設定會使用 | Cloud Run URL，不含尾斜線 |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Runtime env var，讓程式知道要寫哪份試算表 | Google Sheets URL 中 `/d/` 與 `/edit` 中間的 ID |
| `GOOGLE_DRIVE_FOLDER_ID` | Runtime env var，讓程式知道媒體要存哪個 Drive 資料夾 | Google Drive folder URL 中 `/folders/` 後面的 ID |

目前 workflow 會在部署時把下列 non-secret env vars 寫進 Cloud Run：

```text
NODE_ENV=production
APP_BASE_URL=${{ vars.APP_BASE_URL }}
GOOGLE_SHEETS_SPREADSHEET_ID=${{ vars.GOOGLE_SHEETS_SPREADSHEET_ID }}
GOOGLE_DRIVE_FOLDER_ID=${{ vars.GOOGLE_DRIVE_FOLDER_ID }}
ALLOW_UNSIGNED_WEBHOOKS=false
```

`ALLOW_UNSIGNED_WEBHOOKS=false` 很重要，正式環境必須拒絕沒有 LINE 簽章的請求。

## GitHub Actions Secrets

這些只用於 GitHub Actions 對 Google Cloud 進行部署授權，不是 app runtime secret。

放在 GitHub repo：`Settings > Secrets and variables > Actions > Secrets`。

| 名稱 | 用途 | 值的格式 |
| --- | --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | GitHub Actions 用 Workload Identity 登入 GCP | 完整 provider resource name，例如 `projects/.../locations/global/workloadIdentityPools/.../providers/...` |
| `GCP_SERVICE_ACCOUNT` | GitHub Actions deploy service account | service account email，例如 `github-cloud-run-deployer@...iam.gserviceaccount.com` |

不要把 `DASHBOARD_PASSWORD`、LINE token、Gemini key、Google service account JSON 放 GitHub Secrets；本專案 runtime secrets 統一放 Google Cloud Secret Manager。

## Google Cloud Secret Manager Secrets

這些 secrets 放在 Google Cloud Secret Manager。Secret 名稱目前與 Cloud Run 環境變數名稱相同，workflow 會用 `--update-secrets` 掛入 Cloud Run。

| Secret Manager 名稱 | Cloud Run env var | 要填什麼 | 程式用途 |
| --- | --- | --- | --- |
| `DASHBOARD_PASSWORD` | `DASHBOARD_PASSWORD` | 管理頁登入密碼 | `/api/admin/login` 驗證管理模式登入 |
| `SESSION_SECRET` | `SESSION_SECRET` | 隨機長字串，例如 `openssl rand -base64 32` | 簽署登入 cookie，防止偽造 session |
| `USER_HASH_SALT` | `USER_HASH_SALT` | 隨機長字串，例如 `openssl rand -base64 32` | 將 LINE userId 雜湊後寫入 Sheets，避免保存原始 userId |
| `GEMINI_API_KEY` | `GEMINI_API_KEY` | Google AI Studio 建立的 Gemini API key | 文字分類與摘要 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `GOOGLE_SERVICE_ACCOUNT_JSON` | Google service account JSON 原文，或 base64 後的 JSON | 讓程式讀寫 Google Sheets / Drive |
| `LINE_CHANNEL_SECRET` | `LINE_CHANNEL_SECRET` | LINE Developers Messaging API channel secret | 驗證 Webhook 簽章 |
| `LINE_CHANNEL_ACCESS_TOKEN` | `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Messaging API channel access token | 下載 LINE 圖片與檔案內容 |

重要：程式讀的是 `GOOGLE_SERVICE_ACCOUNT_JSON`，不是 `GOOGLE_CREDENTIALS_JSON`。不要新增或使用 `GOOGLE_CREDENTIALS_JSON`。

## Secret 權限

Cloud Run runtime service account：

```text
line-bot-collector@line-bot-backup-501005.iam.gserviceaccount.com
```

這個 service account 需要：

- 對上述 7 個 Secret Manager secrets 擁有 `roles/secretmanager.secretAccessor`
- 被 Google Sheets 分享為編輯者
- 被 Google Drive 媒體資料夾分享為編輯者

建議只對單一 secret 授權，不要直接在整個 project 層級授予所有 secrets 的讀取權限。

## Google Sheets / Drive 使用方式

Google Sheets：

- Spreadsheet ID 由 `GOOGLE_SHEETS_SPREADSHEET_ID` 提供
- 預設 sheet name：`Records`
- 程式會自動確認 `Records` 分頁存在，並寫入表頭
- 資料欄位包含時間、來源、群組 ID、使用者 hash、訊息類型、內容、分類、Drive fileId、Gemini 摘要等

Google Drive：

- Folder ID 由 `GOOGLE_DRIVE_FOLDER_ID` 提供
- 圖片/檔案會建立日期與群組資料夾後上傳
- Drive 檔案不需要公開分享
- 管理頁媒體預覽由後端驗證登入後代理讀取

若 `/api/public/summary` 回：

```json
{"storageMode":"sheets","analysisMode":"gemini"}
```

代表 Sheets 與 Gemini 都已被 runtime 偵測到。

## LINE Webhook 設定

LINE Developers 後台 Webhook URL 使用：

```text
https://line-bot-backup-4a6j4fxaxq-de.a.run.app/webhook/line
```

Cloud Run 必須允許未驗證外部請求，因為 LINE 會直接呼叫 webhook；安全性靠 `LINE_CHANNEL_SECRET` 驗證 `x-line-signature`。

正式環境確認：

- `ALLOW_UNSIGNED_WEBHOOKS=false`
- 假 webhook curl 回 401
- LINE Developers Console webhook verify 通過
- 實際把 bot 加進群組後，文字進 Sheets，圖片/檔案進 Drive

## Gemini 使用方式

- `GEMINI_API_KEY` 存在時，`analysisMode` 應為 `gemini`
- 預設模型由 `GEMINI_MODEL` 控制，目前 `.env.example` 是 `gemini-2.5-flash`
- `GEMINI_DAILY_LIMIT` 控制每個服務實例每日文字分析上限
- 若要節省額度，可設 `GEMINI_TEXT_ANALYSIS_ENABLED=false`，程式會退回本機規則摘要與分類

## 部署流程

自動部署：

1. 修改程式
2. 跑 `npm test` 與 `npm run build`
3. commit 並 push 到 `main`
4. GitHub Actions workflow `Deploy to Cloud Run` 自動執行
5. 成功後檢查 live endpoint

常用檢查：

```bash
gh run list --repo alien0077/Line-bot --limit 3
gcloud run services describe line-bot-backup --region asia-east1 --format='value(status.latestReadyRevisionName)'
curl -i https://line-bot-backup-4a6j4fxaxq-de.a.run.app/api/public/summary
```

如果 Secret Manager 內容更新，建議觸發一次重新部署，讓 Cloud Run 以新 revision 啟動並讀到新值。

## 故障排查

- `storageMode: "memory"`：Cloud Run 沒讀到 `GOOGLE_SHEETS_SPREADSHEET_ID` 或 `GOOGLE_SERVICE_ACCOUNT_JSON`。
- `analysisMode: "local"`：Cloud Run 沒讀到 `GEMINI_API_KEY`，或 Gemini 被關閉。
- webhook 假請求不是 401：檢查 `ALLOW_UNSIGNED_WEBHOOKS` 是否誤設為 true。
- Sheets 403：確認 service account email 已被分享為 Sheet 編輯者。
- Drive 上傳失敗：確認 Drive folder 已分享給 service account，且 `GOOGLE_DRIVE_FOLDER_ID` 正確。
- GitHub Actions 部署失敗：先看 `gh run view <run-id> --log-failed`，通常是 WIF、Cloud Run IAM、Artifact Registry、Cloud Build 或 Secret Manager 權限。

## 安全注意事項

- 不要在終端輸出 secret value，尤其不要用會印出 env value 的 `gcloud run services describe` 格式。
- 檢查 Cloud Run env 時，只列名稱即可。
- 若 service account JSON 曾被直接放在 Cloud Run env value 或貼到聊天紀錄，建議重新產生 key，刪除舊 key，並更新 `GOOGLE_SERVICE_ACCOUNT_JSON` secret。
- `USER_HASH_SALT` 設定後不要隨意更換；更換會讓同一個 LINE userId 變成不同 hash，歷史資料難以對應。
- `SESSION_SECRET` 可輪替；輪替後管理者需要重新登入。
