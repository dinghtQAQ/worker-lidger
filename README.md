# worker-lidger

Cloudflare Workers + D1 个人收支记账 API，附带可在 iPhone 上记录账目的快捷指令。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dinghtQAQ/worker-lidger)

## 中文：快速部署

### 一键部署（推荐）

1. 点击上方 **Deploy to Cloudflare** 按钮，并登录 Cloudflare。
2. 部署表单会创建 Worker 和 D1 数据库。为 `WORKER_API_TOKEN` 生成并填入一个新的随机 Token，例如：

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. 保存这个 Token 的原始值。稍后配置快捷指令时需要它，**不要**包含 `Bearer ` 前缀。
4. 完成部署后，打开 Worker 的 HTTPS 地址，并访问 `<Worker URL>/healthz`。返回正常响应即表示部署可用。

一键部署会自动创建和配置 D1 数据库、执行远程迁移并发布 Worker。请勿将真实 Token、Cloudflare 账户 ID 或数据库 ID 提交到仓库。

### 手动部署（备选）

需要 Node.js 22+、Cloudflare 账号和 npm：

```sh
npm install
npx wrangler login
npx wrangler d1 create worker-lidger-db
# 将命令输出的 database_id 写入 wrangler.jsonc，仅保留在本地
npx wrangler secret put WORKER_API_TOKEN
npm run deploy
```

`npm run deploy` 会先向远程 D1 应用 `migrations/` 中的迁移，再发布 Worker。手动部署时，必须将 [`wrangler.jsonc`](wrangler.jsonc) 中的全零 `database_id` 替换为创建 D1 数据库时返回的 ID。

## 中文：iPhone 快捷指令

### 文件位置

- **直接导入文件**：[`shortcuts/worker-lidger.shortcut`](shortcuts/worker-lidger.shortcut)
- **可维护的快捷指令源码**：[`scripts/generate-shortcut.mjs`](scripts/generate-shortcut.mjs)
- **生成的 plist**：[`shortcuts/worker-lidger.shortcut.plist`](shortcuts/worker-lidger.shortcut.plist)

日常使用请导入 `.shortcut` 文件；不要把 `.plist` 当作 iPhone 的导入文件。修改快捷指令时编辑源码，然后在 macOS 上运行：

```sh
npm run shortcut:build
```

该命令需要 macOS 的 `shortcuts` 和 `plutil`，会重新生成并签名可导入的 `.shortcut` 文件。

### 导入与配置

1. 从 GitHub 下载 [`shortcuts/worker-lidger.shortcut`](shortcuts/worker-lidger.shortcut)，或通过 AirDrop / iCloud Drive 将该文件发送到 iPhone。
2. 在 iPhone 上打开该文件，选择“添加快捷指令”。
3. 安装过程中填写：
   - 已部署 Worker 的 HTTPS 地址，末尾**不要**加 `/`，例如 `https://ledger.example.com`。
   - `WORKER_API_TOKEN` 的原始 Token 值，**不要**加 `Bearer ` 前缀。
4. 运行“Worker Lidger 记账”，依次选择收入或支出、分类和可选细项，再输入正数金额。

快捷指令会读取 Worker 中当前可用的分类，使用 iPhone 本地当天日期，并将人民币金额转换为以分为单位的整数提交。若提示“未授权”，请核对 Token 是否与 Worker 中的 `WORKER_API_TOKEN` 完全一致；若“获取分类失败”，请确认 Worker 已部署、地址可从 iPhone 访问且使用 HTTPS。

## English: Quick Deployment

### One-click deployment (recommended)

1. Click the **Deploy to Cloudflare** button above and sign in to Cloudflare.
2. The form provisions the Worker and D1 database. Generate and enter a new random value for `WORKER_API_TOKEN`, for example:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Keep the raw token value. The iPhone Shortcut needs it later, **without** the `Bearer ` prefix.
4. When deployment finishes, open the Worker HTTPS URL and visit `<Worker URL>/healthz`. A normal response confirms that the service is available.

One-click deployment provisions and configures D1, applies remote migrations, and publishes the Worker. Do not commit real tokens, Cloudflare account IDs, or provisioned database IDs.

### Manual deployment (alternative)

Node.js 22+, npm, and a Cloudflare account are required:

```sh
npm install
npx wrangler login
npx wrangler d1 create worker-lidger-db
# Put the returned database_id in wrangler.jsonc; keep it local
npx wrangler secret put WORKER_API_TOKEN
npm run deploy
```

`npm run deploy` applies the migrations in `migrations/` to remote D1 before publishing the Worker. For manual deployment, replace the all-zero `database_id` in [`wrangler.jsonc`](wrangler.jsonc) with the ID returned when creating the D1 database.

## English: iPhone Shortcut

### File locations

- **Import this file on iPhone**: [`shortcuts/worker-lidger.shortcut`](shortcuts/worker-lidger.shortcut)
- **Maintainable source**: [`scripts/generate-shortcut.mjs`](scripts/generate-shortcut.mjs)
- **Generated plist**: [`shortcuts/worker-lidger.shortcut.plist`](shortcuts/worker-lidger.shortcut.plist)

For normal use, import the `.shortcut` file; the `.plist` file is not the iPhone import artifact. To change the Shortcut, edit the source and run this on macOS:

```sh
npm run shortcut:build
```

This requires the macOS `shortcuts` and `plutil` commands and regenerates a signed, importable `.shortcut` file.

### Import and configure

1. Download [`shortcuts/worker-lidger.shortcut`](shortcuts/worker-lidger.shortcut) from GitHub, or send it to the iPhone through AirDrop or iCloud Drive.
2. Open the file on the iPhone and choose **Add Shortcut**.
3. During installation, enter:
   - The deployed Worker HTTPS URL, with **no trailing `/`**, such as `https://ledger.example.com`.
   - The raw `WORKER_API_TOKEN` value, with **no** `Bearer ` prefix.
4. Run **Worker Lidger Ledger**, choose income or expense, a category and optional subcategory, then enter a positive amount.

The Shortcut loads the currently available categories from the Worker, uses the iPhone's local date, and submits CNY amounts as integer fen. For an unauthorized error, make sure the value exactly matches the Worker's `WORKER_API_TOKEN`. For a category-loading error, make sure the Worker is deployed, reachable from the iPhone, and served over HTTPS.

## 中文：本地开发

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrations:local
npm run dev
```

在 `.dev.vars` 中设置一个足够长的随机 `WORKER_API_TOKEN`。该文件仅用于本地开发且已被 Git 忽略；使用 `npm test` 运行测试套件。

## 中文：API 说明

`GET /healthz` 为公开端点。所有 `/v1/*` 端点均要求 `Authorization: Bearer <WORKER_API_TOKEN>` 和 JSON 内容。`amount_minor` 等金额字段使用最小货币单位的整数，`1234` 表示人民币 12.34 元。删除分类会将其停用，删除账目会将其作废，以保留审计历史。

## English: Local development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrations:local
npm run dev
```

Set a long random `WORKER_API_TOKEN` in `.dev.vars`; it is used only for local development and is ignored by Git. Run the project test suite with `npm test`.

## English: API notes

`GET /healthz` is public. Every `/v1/*` endpoint requires `Authorization: Bearer <WORKER_API_TOKEN>` and JSON content. Amount fields such as `amount_minor` are integer minor units: `1234` represents CNY 12.34. Category deletion deactivates records and entry deletion voids them, preserving the audit history.
