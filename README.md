# Ritual Playbook — 部署说明（零后端 / 不碰命令行版）

整套只有两个核心文件：
- `index.html` — 整个 App（不需要打包，浏览器直接跑）
- `functions/api/coach.js` — 服务端 AI 接口（调用 Cloudflare Workers AI + 成本闸门）
- `README.md` — 你正在看的这份

AI 调用全部发生在服务端（`/api/coach`），浏览器里没有任何密钥。成本闸门也在服务端。

---

## 一、为什么必须用 Git 连接（而不是拖拽上传）

Cloudflare 官方限制：网页端"拖拽上传"**不会编译 `functions` 文件夹**。
要让 `/api/coach` 这个后端跑起来，只能走 **Git 连接** 或 Wrangler 命令行。
下面用的是 Git 连接，全程在浏览器里完成，不用装任何东西。

---

## 二、把文件放上 GitHub（浏览器操作）

1. 注册 / 登录 https://github.com
2. 右上角 `+` → `New repository` → 取个名字（如 `ritual-playbook`）→ Public → `Create repository`
3. 进入空仓库页面 → `uploading an existing file`（或 `Add file → Upload files`）
4. 把这个文件夹里的内容拖进去，**保持目录结构**：
   ```
   index.html
   functions/api/coach.js
   README.md
   ```
   注意 `coach.js` 必须在 `functions/api/` 下。GitHub 上传时可以直接把 `functions` 文件夹拖进去，
   或在文件名里手动输入路径 `functions/api/coach.js`。
5. `Commit changes`

---

## 三、连接 Cloudflare Pages（浏览器操作）

1. 登录 https://dash.cloudflare.com（免费账号，不用信用卡）
2. 左侧 `Workers & Pages` → `Create` → `Pages` 选项卡 → `Connect to Git`
3. 授权并选中你刚建的仓库
4. 构建设置（关键，别填错）：
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `/`
5. `Save and Deploy`。等一两分钟，你会拿到一个网址：`https://<项目名>.pages.dev`

此时打开网址，App 已经能用 —— 但 AI 还不会工作，因为还没绑定 AI 和 KV。继续第四步。

---

## 四、绑定 Workers AI 和 KV（这一步让 AI + 闸门生效）

### 4.1 先建一个 KV 命名空间（用来记每天的调用次数）
1. Cloudflare 后台左侧 `Storage & Databases` → `KV` → `Create a namespace`
2. 名字随便（如 `ritual_rl`）→ 创建

### 4.2 给 Pages 项目加两个绑定
1. 回到你的 Pages 项目 → `Settings` → 找到 `Bindings`（或 `Functions` 下的 Bindings）
2. 加 **AI 绑定**：
   - Add → `Workers AI`
   - Variable name 必须填：`AI`
3. 加 **KV 绑定**：
   - Add → `KV namespace`
   - Variable name 必须填：`RL`
   - KV namespace 选你刚建的 `ritual_rl`
4. 保存后 **必须重新部署一次**：`Deployments` → 最新一条 → `Retry deployment`（或往 GitHub 再 commit 一次触发部署）

> 变量名一定是 `AI` 和 `RL`，因为 `coach.js` 里就是用 `env.AI` 和 `env.RL` 读它们的。

完成后再打开网址，进 **Facilitator Coach**，问一句试试，AI 就会从你的 playbook 里回答了。

---

## 五、成本闸门是怎么做的（写进作业说明 / 视频里讲这段）

Workers AI 免费层 ≈ **每天 10,000 neurons**，一次约 300 token 的回答要几百 neurons，
所以整个账号一天大概只够 ~20 次免费调用。代码里用了三层闸门：

1. **服务端调用**：模型只在 `coach.js` 里调，浏览器拿不到任何凭据，别人无法盗用你的额度。
2. **限制输出长度**：`max_tokens = 300` —— 答案短 = 每次耗的 neurons 少。
3. **每日调用上限**（存在 KV 里，按 UTC 日期自动重置）：
   - 全站每天 `DAILY_GLOBAL_CAP = 25` 次，护住免费额度不被刷爆；
   - 每个访客每天 `DAILY_IP_CAP = 8` 次，保证演示时大家都能用上。
   超限直接返回 429，前端显示"今日额度已用完"。

数字都在 `coach.js` 顶部，可按需要调。
（注：KV 是最终一致的，计数在高并发下不是严格精确——对课堂 demo 足够；要更严谨可换 Durable Objects。）

---

## 六、可选：之后想升级成"真·RAG"给导师加分

现在是 **grounding**（把整本 playbook 塞进 prompt），因为内容小，这是正确选择。
若要演示完整 RAG：把 playbook 切块 → 用 Workers AI 的 embedding 模型转向量 → 存进 Cloudflare **Vectorize** →
提问时先检索最相关的几块再拼进 prompt。需要时我可以再带你加这一层。

---

## 七、命令行替代路径（如果你愿意装 Node）

```bash
npm install -g wrangler
wrangler login
cd ritual-playbook
wrangler pages deploy . --project-name=ritual-playbook
```
之后同样在后台加 `AI` / `RL` 绑定并重新部署。命令行更快，但不是必须。
