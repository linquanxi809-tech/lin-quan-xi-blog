/**
 * 小站 · 轻量动态博客后端（完整账号系统）
 * 收信转发（Resend inbound → Gmail）使用 resend SDK；用受保护加载，未安装时自动降级不影响博客。
 *
 * 文章存为 <DATA_DIR>/articles/<id>.json
 * 用户存为 <DATA_DIR>/users.json
 * 会话保存在内存（重启后需重新登录）
 *
 * 启动：node server.js   （默认端口 3000，可用 PORT 环境变量覆盖）
 * 数据目录：默认用仓库内的 data/；部署到带持久化磁盘的平台（如 Render）时，
 *           用环境变量 DATA_DIR 指向挂载盘（如 /var/data），避免实例重启/休眠丢数据。
 *
 * 账号系统（完整版）：
 *   - 注册（用户名 + 邮箱 + 密码），注册后发送邮箱验证邮件
 *   - 登录（支持用户名或邮箱）
 *   - 退出登录 / 注销账号（连带删除其文章）
 *   - 个人资料（昵称 / 简介 / 头像）、修改密码
 *   - 邮箱验证、找回密码（重置令牌）
 *   - 管理员角色（用户列表 / 删除用户 / 改角色）
 *
 * 邮箱发送：若设置了 RESEND_API_KEY 则通过 Resend 真实发送；
 *           否则进入「开发模式」——仅把验证/重置链接打印到服务端日志，系统仍可完整跑通。
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

// Resend SDK：仅用于收信 webhook 转发到 Gmail。受保护加载——未安装时自动降级，不影响博客其它功能。
let Resend = null;
try {
  ({ Resend } = require("resend"));
} catch (e) {
  console.warn("[inbound] resend SDK 未加载，收信转发功能不可用");
}
// postal-mime：解析收信原始邮件，便于转发时保留正文/附件并带上原发送者（reply_to）。受保护加载。
let postalMime = null;
try {
  postalMime = require("postal-mime");
} catch (e) {
  console.warn("[inbound] postal-mime 未加载，转发将退回官方 forward（不带原发送者）");
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SEED_DIR = path.join(ROOT, "data");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : SEED_DIR;
const ARTICLES_DIR = path.join(DATA_DIR, "articles");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const PORT = process.env.PORT || 3000;
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天
const APP_ORIGIN = process.env.APP_ORIGIN || "https://gh-xiao-wu.de5.net";
const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@gh-xiao-wu.de5.net";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";
const FORWARD_TO = process.env.FORWARD_TO || "linquanxi809@gmail.com";
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- 初始化目录 ----------
function seedIfEmpty() {
  if (DATA_DIR === SEED_DIR) return;
  const seedArticles = path.join(SEED_DIR, "articles");
  const seedUsers = path.join(SEED_DIR, "users.json");
  let needSeed = false;
  if (!fs.existsSync(ARTICLES_DIR) || fs.readdirSync(ARTICLES_DIR).length === 0) needSeed = true;
  if (!fs.existsSync(USERS_FILE)) needSeed = true;
  if (!needSeed) return;
  try {
    fs.mkdirSync(ARTICLES_DIR, { recursive: true });
    if (fs.existsSync(seedArticles)) {
      for (const f of fs.readdirSync(seedArticles)) {
        if (f.endsWith(".json")) fs.copyFileSync(path.join(seedArticles, f), path.join(ARTICLES_DIR, f));
      }
    }
    if (!fs.existsSync(USERS_FILE) && fs.existsSync(seedUsers)) {
      fs.copyFileSync(seedUsers, USERS_FILE);
    }
    console.log("[seed] 已从内置 seed 初始化数据目录 " + DATA_DIR);
  } catch (e) {
    console.error("[seed] 初始化失败:", e.message);
  }
}
seedIfEmpty();
fs.mkdirSync(ARTICLES_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");

// 兼容旧版用户记录：补齐新模型字段（无邮箱的视为已验证，避免被卡在未验证状态）
(function normalizeUsers() {
  const users = readUsers();
  let changed = false;
  for (const u of users) {
    if (typeof u.email !== "string") { u.email = ""; changed = true; }
    if (typeof u.displayName !== "string") { u.displayName = ""; changed = true; }
    if (typeof u.bio !== "string") { u.bio = ""; changed = true; }
    if (typeof u.avatar !== "string") { u.avatar = ""; changed = true; }
    if (u.role !== "user" && u.role !== "admin") { u.role = "user"; changed = true; }
    if (typeof u.emailVerified !== "boolean") { u.emailVerified = !u.email; changed = true; }
    if (u.verifyToken === undefined) { u.verifyToken = null; changed = true; }
    if (u.verifyExpires === undefined) { u.verifyExpires = null; changed = true; }
    if (u.resetToken === undefined) { u.resetToken = null; changed = true; }
    if (u.resetExpires === undefined) { u.resetExpires = null; changed = true; }
  }
  if (changed) writeUsers(users);
})();

// ---------- 工具 ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
function sendHtml(res, status, html) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("无效的 JSON"));
      }
    });
    req.on("error", reject);
  });
}
// 读取原始请求体（webhook 签名校验需要原文，不能用 JSON.parse 后的对象）
function readRawBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function setCookie(res, name, value, maxAge) {
  const opts = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  res.setHeader("Set-Cookie", `${name}=${value}; ${opts}`);
}
function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; HttpOnly; Max-Age=0`);
}
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString("hex");
}
function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ---------- 用户 ----------
function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email || "",
    displayName: u.displayName || "",
    bio: u.bio || "",
    avatar: u.avatar || "",
    role: u.role || "user",
    emailVerified: !!u.emailVerified,
    createdAt: u.createdAt,
  };
}

// ---------- 会话（内存） ----------
const sessions = new Map(); // sid -> { userId, expires }
function createSession(userId) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { userId, expires: Date.now() + SESSION_TTL });
  return sid;
}
function currentUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  const user = readUsers().find((u) => u.id === s.userId);
  return user ? publicUser(user) : null;
}
function currentAdmin(req) {
  const u = currentUser(req);
  if (!u || u.role !== "admin") return null;
  return u;
}

// ---------- 邮件发送 ----------
// 真实发送走 Resend；未配置 RESEND_API_KEY 时进入开发模式，仅打印链接到日志。
async function sendEmail(to, subject, html) {
  const text = `[邮件] 收件人: ${to}\n主题: ${subject}\n${html}\n`;
  if (!RESEND_API_KEY) {
    console.log("=".repeat(40));
    console.log("[email:dev] 未配置 RESEND_API_KEY，以下为验证/重置链接（生产环境请配置后真实发送）：");
    console.log(text);
    console.log("=".repeat(40));
    return true;
  }
  const payload = JSON.stringify({ from: EMAIL_FROM, to, subject, html });
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.resend.com",
        path: "/emails",
        method: "POST",
        headers: {
          Authorization: "Bearer " + RESEND_API_KEY,
          "Content-Type": "application/json",
        },
      },
      (resp) => {
        let buf = "";
        resp.on("data", (c) => (buf += c));
        resp.on("end", () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(true);
          else {
            console.error("[email] 发送失败 " + resp.statusCode + ": " + buf);
            resolve(false);
          }
        });
      }
    );
    req.on("error", (e) => {
      console.error("[email] 请求出错:", e.message);
      resolve(false);
    });
    req.setTimeout(8000, () => {
      console.error("[email] 请求超时");
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

// ---------- 收信转发（Resend inbound webhook → Gmail） ----------
// Resend 收到发往 mail.gh-xiao-wu.de5.net 的邮件后，会 POST 一个 email.received 事件到这里；
// 我们校验 Svix 签名，再调用 Resend 官方 forward 把邮件原样转发到 FORWARD_TO（Gmail）。
async function handleResendInbound(req, res) {
  if (!Resend) {
    return sendJSON(res, 500, { error: "resend SDK 未加载，收信转发不可用" });
  }
  if (!RESEND_WEBHOOK_SECRET) {
    return sendJSON(res, 500, { error: "未配置 RESEND_WEBHOOK_SECRET" });
  }
  let raw = "";
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: "读取请求体失败" });
  }
  const id = req.headers["svix-id"];
  const timestamp = req.headers["svix-timestamp"];
  const signature = req.headers["svix-signature"];
  if (!id || !timestamp || !signature) {
    return sendJSON(res, 400, { error: "缺少 Svix 签名头" });
  }
  try {
    const resend = new Resend(RESEND_API_KEY);
    const event = resend.webhooks.verify({
      payload: raw,
      headers: { id, timestamp, signature },
      webhookSecret: RESEND_WEBHOOK_SECRET,
    });
    if (event && event.type === "email.received") {
      const emailId = event.data && event.data.email_id;
      if (emailId) {
        try {
          const emailResp = await resend.emails.receiving.get(emailId);
          const email = (emailResp && emailResp.data) || {};
          const originalSender = email.from || "";
          const originalSubject = email.subject || "(无主题)";
          const rawUrl = email.raw && email.raw.download_url;
          if (rawUrl && postalMime) {
            // 解析原始邮件，原样转发正文/附件，并把「原发送者」放进 reply_to、主题前缀显示发件人
            try {
              const pm = postalMime.default || postalMime;
              const rawContent = await fetch(rawUrl).then((r) => r.text());
              const parsed = await pm.parse(rawContent, { attachmentEncoding: "base64" });
              const attachments = (parsed.attachments || []).map((a) => ({
                filename: a.filename,
                content: a.content.toString(),
                content_type: a.mimeType,
                content_id: a.contentId ? a.contentId.replace(/^<|>$/g, "") : undefined,
              }));
              const { error } = await resend.emails.send({
                from: EMAIL_FROM,
                to: FORWARD_TO,
                replyTo: originalSender || undefined,
                subject: `来自 ${originalSender || "某人"}：「${originalSubject}」`,
                text: parsed.text || undefined,
                html: parsed.html || undefined,
                attachments: attachments.length ? attachments : undefined,
              });
              if (error) throw new Error(JSON.stringify(error));
              console.log("[inbound] 已转发邮件", emailId, "→", FORWARD_TO, "| 原发送者:", originalSender);
            } catch (customErr) {
              console.error("[inbound] 自定义转发失败，回退官方 forward:", customErr && customErr.message);
              const fb = await resend.emails.receiving.forward({ emailId, to: FORWARD_TO, from: EMAIL_FROM });
              if (fb.error) console.error("[inbound] 回退转发也失败:", fb.error);
              else console.log("[inbound] 已转发邮件(回退)", emailId, "→", FORWARD_TO);
            }
          } else {
            // raw 不可得或无 postal-mime：用官方 forward 兜底（仍可用，只是不带 reply_to）
            const { error } = await resend.emails.receiving.forward({ emailId, to: FORWARD_TO, from: EMAIL_FROM });
            if (error) console.error("[inbound] 转发失败:", error);
            else console.log("[inbound] 已转发邮件", emailId, "→", FORWARD_TO);
          }
        } catch (getErr) {
          console.error("[inbound] 获取邮件详情失败:", getErr && getErr.message);
        }
      }
    }
    return sendJSON(res, 200, { ok: true });
  } catch (e) {
    console.error("[inbound] 签名校验失败:", e && e.message);
    return sendJSON(res, 401, { error: "签名校验失败" });
  }
}

// ---------- 文章 ----------
function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}
function excerpt(html, len = 90) {
  const text = String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text.length > len ? text.slice(0, len) + "…" : text;
}
function listArticles() {
  let files = [];
  try {
    files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const items = files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, f), "utf8"));
    } catch {
      return null;
    }
  });
  return items
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((a) => ({
      id: a.id,
      title: a.title,
      tag: a.tag,
      date: a.date,
      readTime: a.readTime,
      authorId: a.authorId || "",
      author: a.author || a.authorName || "",
      excerpt: excerpt(a.content),
    }));
}
function getArticle(id) {
  const file = path.join(ARTICLES_DIR, safeId(id) + ".json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function saveArticle(article) {
  const file = path.join(ARTICLES_DIR, safeId(article.id) + ".json");
  fs.writeFileSync(file, JSON.stringify(article, null, 2));
}
function deleteArticle(id) {
  const file = path.join(ARTICLES_DIR, safeId(id) + ".json");
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
function deleteArticlesByAuthor(userId, username) {
  const all = listArticles();
  const mine = all.filter((a) => a.authorId === userId || (username && a.author === username));
  for (const a of mine) {
    deleteArticle(a.id);
    syncDeleteArticleGitHub(a.id).catch(() => {});
  }
  return mine.length;
}

// ---------- 自动同步到 GitHub 仓库（free 套餐无持久磁盘时的持久化方案）----------
const GH_TOKEN = process.env.GH_TOKEN || "";
const GH_REPO = process.env.GH_REPO || "linquanxi809-tech/lin-quan-xi-blog";
const GH_BRANCH = process.env.GH_BRANCH || "main";
function githubSyncEnabled() {
  return !!GH_TOKEN;
}
function ghApiRequest(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path: apiPath,
        method,
        headers: {
          Authorization: "Bearer " + GH_TOKEN,
          Accept: "application/vnd.github+json",
          "User-Agent": "lin-quan-xi-blog",
          "Content-Type": "application/json",
        },
      },
      (resp) => {
        let buf = "";
        resp.on("data", (c) => (buf += c));
        resp.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {}
          if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(json);
          else reject(new Error("GitHub " + resp.statusCode + ": " + (json && json.message)));
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("GitHub 请求超时")));
    if (data) req.write(data);
    req.end();
  });
}
async function getGitHubFileSha(repoPath) {
  try {
    const json = await ghApiRequest("GET", `/repos/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`);
    return json && json.sha ? json.sha : null;
  } catch (e) {
    if (String(e.message).includes("404")) return null;
    throw e;
  }
}
async function syncArticleToGitHub(article) {
  if (!githubSyncEnabled()) return;
  const repoPath = `data/articles/${safeId(article.id)}.json`;
  const content = Buffer.from(JSON.stringify(article, null, 2), "utf8").toString("base64");
  try {
    const sha = await getGitHubFileSha(repoPath);
    await ghApiRequest("PUT", `/repos/${GH_REPO}/contents/${repoPath}`, {
      message: `chore: sync article ${article.id}`,
      content,
      branch: GH_BRANCH,
      ...(sha ? { sha } : {}),
    });
    console.log("[github] 已同步文章到仓库: " + article.id);
  } catch (e) {
    console.error("[github] 同步文章失败 " + article.id + ": " + e.message);
  }
}
async function syncDeleteArticleGitHub(id) {
  if (!githubSyncEnabled()) return;
  const repoPath = `data/articles/${safeId(id)}.json`;
  try {
    const sha = await getGitHubFileSha(repoPath);
    if (!sha) return;
    await ghApiRequest("DELETE", `/repos/${GH_REPO}/contents/${repoPath}`, {
      message: `chore: delete article ${id}`,
      sha,
      branch: GH_BRANCH,
    });
    console.log("[github] 已从仓库删除文章: " + id);
  } catch (e) {
    console.error("[github] 删除 GitHub 文章失败 " + id + ": " + e.message);
  }
}
async function syncUsersToGitHub() {
  if (!githubSyncEnabled()) return;
  const repoPath = "data/users.json";
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = Buffer.from(JSON.stringify(readUsers(), null, 2), "utf8").toString("base64");
    try {
      const sha = await getGitHubFileSha(repoPath);
      await ghApiRequest("PUT", `/repos/${GH_REPO}/contents/${repoPath}`, {
        message: "chore: sync users.json",
        content,
        branch: GH_BRANCH,
        ...(sha ? { sha } : {}),
      });
      console.log("[github] 已同步 users.json 到仓库");
      return;
    } catch (e) {
      if (String(e.message).includes("does not match") && attempt < 2) {
        console.warn("[github] users.json sha 冲突，重试 (" + (attempt + 1) + ")");
        continue;
      }
      console.error("[github] 同步 users.json 失败: " + e.message);
      return;
    }
  }
}

// ---------- 静态文件 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, d2) => {
        if (e2) {
          res.writeHead(404);
          return res.end("Not Found");
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- 简单的 HTML 页面（用于邮箱验证/重置结果）----------
function resultPage(title, msg, isOk) {
  const color = isOk ? "#1f9d6b" : "#d9534f";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f0c1d;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1a1428;border:1px solid #4a3b66;border-radius:14px;padding:32px 40px;text-align:center;max-width:420px}
  h1{font-size:1.4rem;color:${color};margin:0 0 12px}
  p{color:#cbb8e8;line-height:1.6;margin:0 0 20px}
  a{display:inline-block;background:linear-gradient(120deg,#ff6d00,#ffca28);color:#1a1428;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:700}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${msg}</p><a href="login.html">前往登录</a></div></body></html>`;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const seg = parts.slice(1);

  // /api/resend-inbound  Resend 收信 webhook：校验签名后转发到 Gmail
  if (seg[0] === "resend-inbound" && req.method === "POST") {
    return handleResendInbound(req, res);
  }

  // /api/me (GET) 当前用户信息
  if (seg[0] === "me" && req.method === "GET") {
    const u = currentUser(req);
    return sendJSON(res, 200, { user: u });
  }

  // /api/verify?token=xxx  邮箱验证（GET，便于邮件链接直接点击）
  if (seg[0] === "verify" && req.method === "GET") {
    const token = url.searchParams.get("token");
    if (!token) return sendHtml(res, 400, resultPage("验证失败", "缺少验证令牌。", false));
    const users = readUsers();
    const user = users.find((u) => u.verifyToken === token && u.verifyExpires > Date.now());
    if (!user) return sendHtml(res, 400, resultPage("验证失败", "令牌无效或已过期，请重新获取验证邮件。", false));
    user.emailVerified = true;
    user.verifyToken = null;
    user.verifyExpires = null;
    writeUsers(users);
    await syncUsersToGitHub();
    return sendHtml(res, 200, resultPage("邮箱已验证 🎉", "你的邮箱已成功验证，现在可以正常使用了。", true));
  }

  // /api/register 注册
  if (seg[0] === "register" && req.method === "POST") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    if (username.length < 2) return sendJSON(res, 400, { error: "用户名至少 2 个字符" });
    if (password.length < 6) return sendJSON(res, 400, { error: "密码至少 6 位" });
    if (email && !isEmail(email)) return sendJSON(res, 400, { error: "邮箱格式不正确" });
    const users = readUsers();
    if (users.some((u) => u.username === username))
      return sendJSON(res, 409, { error: "用户名已存在" });
    if (email && users.some((u) => u.email && u.email.toLowerCase() === email.toLowerCase()))
      return sendJSON(res, 409, { error: "该邮箱已被注册" });
    const salt = makeSalt();
    const role = ADMIN_USERNAMES.includes(username) || users.length === 0 ? "admin" : "user";
    const token = randomToken();
    const user = {
      id: newId(),
      username,
      email,
      salt,
      hash: hashPassword(password, salt),
      displayName: "",
      bio: "",
      avatar: "",
      role,
      emailVerified: email ? false : true,
      verifyToken: email ? token : null,
      verifyExpires: email ? Date.now() + 1000 * 60 * 60 * 24 : null,
      resetToken: null,
      resetExpires: null,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    writeUsers(users);
    syncUsersToGitHub();
    if (email) {
      const link = `${APP_ORIGIN}/api/verify?token=${token}`;
      await sendEmail(
        email,
        "请验证你的邮箱 · 围坐篝火话天下",
        `<p>你好 ${username}，</p><p>欢迎来到「围坐篝火话天下」！请点击下面的链接验证你的邮箱：</p><p><a href="${link}">${link}</a></p><p>链接 24 小时内有效。</p>`
      );
    }
    const sid = createSession(user.id);
    setCookie(res, "sid", sid, SESSION_TTL / 1000);
    return sendJSON(res, 200, { ok: true, user: publicUser(user) });
  }

  // /api/login 登录（支持用户名或邮箱）
  if (seg[0] === "login" && req.method === "POST") {
    const body = await readBody(req);
    const loginId = String(body.username || "").trim();
    const password = String(body.password || "");
    const users = readUsers();
    const user = users.find(
      (u) => u.username === loginId || (u.email && u.email.toLowerCase() === loginId.toLowerCase())
    );
    if (!user || hashPassword(password, user.salt) !== user.hash)
      return sendJSON(res, 401, { error: "用户名/邮箱或密码错误" });
    const sid = createSession(user.id);
    setCookie(res, "sid", sid, SESSION_TTL / 1000);
    return sendJSON(res, 200, { ok: true, user: publicUser(user) });
  }

  // /api/logout 退出登录
  if (seg[0] === "logout" && req.method === "POST") {
    const cookies = parseCookies(req);
    if (cookies.sid) sessions.delete(cookies.sid);
    clearCookie(res, "sid");
    return sendJSON(res, 200, { ok: true });
  }

  // /api/forgot-password 找回密码（发送重置邮件）
  if (seg[0] === "forgot-password" && req.method === "POST") {
    const body = await readBody(req);
    const email = String(body.email || "").trim();
    const users = readUsers();
    const user = users.find((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
    if (user) {
      const token = randomToken();
      user.resetToken = token;
      user.resetExpires = Date.now() + 1000 * 60 * 60; // 1 小时
      writeUsers(users);
      await syncUsersToGitHub();
      const link = `${APP_ORIGIN}/reset-password.html?token=${token}`;
      await sendEmail(
        email,
        "重置你的密码 · 围坐篝火话天下",
        `<p>你好，</p><p>我们收到了重置密码的请求。请点击下面的链接设置新密码：</p><p><a href="${link}">${link}</a></p><p>如果该请求不是你发起的，请忽略此邮件。链接 1 小时内有效。</p>`
      );
    }
    // 无论邮箱是否存在都返回成功，避免泄露账号信息
    return sendJSON(res, 200, { ok: true });
  }

  // /api/reset-password 重置密码
  if (seg[0] === "reset-password" && req.method === "POST") {
    const body = await readBody(req);
    const token = String(body.token || "");
    const password = String(body.password || "");
    if (password.length < 6) return sendJSON(res, 400, { error: "密码至少 6 位" });
    const users = readUsers();
    const user = users.find((u) => u.resetToken === token && u.resetExpires > Date.now());
    if (!user) return sendJSON(res, 400, { error: "重置令牌无效或已过期" });
    user.salt = makeSalt();
    user.hash = hashPassword(password, user.salt);
    user.resetToken = null;
    user.resetExpires = null;
    writeUsers(users);
    syncUsersToGitHub();
    return sendJSON(res, 200, { ok: true });
  }

  // /api/me (PUT) 更新资料 / 修改密码
  if (seg[0] === "me" && req.method === "PUT") {
    const u = currentUser(req);
    if (!u) return sendJSON(res, 401, { error: "请先登录" });
    const users = readUsers();
    const user = users.find((x) => x.id === u.id);
    if (!user) return sendJSON(res, 401, { error: "请先登录" });
    const body = await readBody(req);
    // 改密码分支
    if (body.currentPassword || body.newPassword) {
      if (!body.currentPassword || !body.newPassword)
        return sendJSON(res, 400, { error: "需同时提供当前密码和新密码" });
      if (hashPassword(body.currentPassword, user.salt) !== user.hash)
        return sendJSON(res, 400, { error: "当前密码不正确" });
      if (String(body.newPassword).length < 6)
        return sendJSON(res, 400, { error: "新密码至少 6 位" });
      user.salt = makeSalt();
      user.hash = hashPassword(body.newPassword, user.salt);
      writeUsers(users);
      await syncUsersToGitHub();
      return sendJSON(res, 200, { ok: true });
    }
    // 资料分支
    if (typeof body.displayName === "string") user.displayName = body.displayName.slice(0, 40);
    if (typeof body.bio === "string") user.bio = body.bio.slice(0, 200);
    if (typeof body.avatar === "string") user.avatar = body.avatar.slice(0, 500);
    writeUsers(users);
    await syncUsersToGitHub();
    return sendJSON(res, 200, { ok: true, user: publicUser(user) });
  }

  // /api/me (DELETE) 注销账号：删除账号及其全部文章
  if (seg[0] === "me" && req.method === "DELETE") {
    const u = currentUser(req);
    if (!u) return sendJSON(res, 401, { error: "请先登录" });
    const n = deleteArticlesByAuthor(u.id, u.username);
    const users = readUsers().filter((x) => x.id !== u.id);
    writeUsers(users);
    syncUsersToGitHub();
    const cookies = parseCookies(req);
    if (cookies.sid) sessions.delete(cookies.sid);
    clearCookie(res, "sid");
    return sendJSON(res, 200, { ok: true, deletedArticles: n });
  }

  // /api/resend-verify 重新发送验证邮件
  if (seg[0] === "resend-verify" && req.method === "POST") {
    const u = currentUser(req);
    if (!u) return sendJSON(res, 401, { error: "请先登录" });
    const users = readUsers();
    const user = users.find((x) => x.id === u.id);
    if (!user || !user.email) return sendJSON(res, 400, { error: "该账号未绑定邮箱" });
    if (user.emailVerified) return sendJSON(res, 400, { error: "邮箱已验证" });
    const token = randomToken();
    user.verifyToken = token;
    user.verifyExpires = Date.now() + 1000 * 60 * 60 * 24;
    writeUsers(users);
    await syncUsersToGitHub();
    const link = `${APP_ORIGIN}/api/verify?token=${token}`;
    await sendEmail(
      user.email,
      "请验证你的邮箱 · 围坐篝火话天下",
      `<p>你好 ${user.username}，</p><p>这是新的验证链接：</p><p><a href="${link}">${link}</a></p><p>链接 24 小时内有效。</p>`
    );
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- 管理员端点 ----------
  if (seg[0] === "admin" && seg[1] === "users") {
    const admin = currentAdmin(req);
    if (!admin) return sendJSON(res, 403, { error: "需要管理员权限" });
    // 列表
    if (seg.length === 2 && req.method === "GET") {
      const users = readUsers().map(publicUser);
      return sendJSON(res, 200, { users });
    }
    const id = safeId(seg[2]);
    if (!id) return sendJSON(res, 400, { error: "无效的用户 ID" });
    // 设置角色
    if (seg.length === 3 && req.method === "PUT") {
      const body = await readBody(req);
      const role = body.role === "admin" ? "admin" : "user";
      const users = readUsers();
      const target = users.find((x) => x.id === id);
      if (!target) return sendJSON(res, 404, { error: "用户不存在" });
      if (target.role === "admin") return sendJSON(res, 400, { error: "不能修改管理员角色" });
      target.role = role;
      writeUsers(users);
      await syncUsersToGitHub();
      return sendJSON(res, 200, { ok: true, user: publicUser(target) });
    }
    // 删除用户
    if (seg.length === 3 && req.method === "DELETE") {
      const users = readUsers();
      const target = users.find((x) => x.id === id);
      if (!target) return sendJSON(res, 404, { error: "用户不存在" });
      if (target.role === "admin") return sendJSON(res, 400, { error: "不能删除管理员" });
      if (target.id === admin.id) return sendJSON(res, 400, { error: "不能删除自己" });
      const n = deleteArticlesByAuthor(target.id, target.username);
      writeUsers(users.filter((x) => x.id !== id));
      await syncUsersToGitHub();
      return sendJSON(res, 200, { ok: true, deletedArticles: n });
    }
    return sendJSON(res, 405, { error: "方法不被允许" });
  }

  // /api/articles
  if (seg[0] === "articles") {
    if (seg.length === 1 && req.method === "GET") {
      return sendJSON(res, 200, { articles: listArticles() });
    }
    if (seg.length === 1 && req.method === "POST") {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { error: "请先登录" });
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      const content = String(body.content || "");
      if (!title || !content) return sendJSON(res, 400, { error: "标题和正文不能为空" });
      const id = newId();
      const article = {
        id,
        title,
        tag: String(body.tag || "生活"),
        date: String(body.date || new Date().toISOString().slice(0, 10)),
        content,
        authorId: u.id,
        author: String(body.author || u.displayName || u.username),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveArticle(article);
      syncArticleToGitHub(article);
      return sendJSON(res, 200, { ok: true, id });
    }
    const id = safeId(seg[1]);
    if (!id) return sendJSON(res, 400, { error: "无效的文章 ID" });
    if (req.method === "GET") {
      const a = getArticle(id);
      if (!a) return sendJSON(res, 404, { error: "文章不存在" });
      return sendJSON(res, 200, { article: a });
    }
    if (req.method === "PUT" || req.method === "DELETE") {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { error: "请先登录" });
      const existing = getArticle(id);
      if (!existing) return sendJSON(res, 404, { error: "文章不存在" });
      // 仅作者本人或管理员可修改/删除
      const isOwner = existing.authorId === u.id || existing.author === u.username;
      if (!isOwner && u.role !== "admin")
        return sendJSON(res, 403, { error: "无权操作该文章" });
      if (req.method === "DELETE") {
        deleteArticle(id);
        syncDeleteArticleGitHub(id);
        return sendJSON(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const updated = {
        ...existing,
        title: String(body.title || existing.title),
        tag: String(body.tag || existing.tag),
        date: String(body.date || existing.date),
        author: String(body.author || existing.author),
        content: String(body.content || existing.content),
        updatedAt: new Date().toISOString(),
      };
      saveArticle(updated);
      syncArticleToGitHub(updated);
      return sendJSON(res, 200, { ok: true, id });
    }
    return sendJSON(res, 405, { error: "方法不被允许" });
  }

  return sendJSON(res, 404, { error: "接口不存在" });
}

// ---------- 主服务器 ----------
const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  const CANONICAL = "www.gh-xiao-wu.de5.net";
  // 旧 onrender 域名、以及裸域名(apex，已让给邮件 MX) 都跳转到 www 规范地址
  if (host === "lin-quan-xi-blog.onrender.com" || host === "gh-xiao-wu.de5.net") {
    const target = "https://" + CANONICAL + (req.url || "/");
    res.writeHead(301, { Location: target });
    return res.end();
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      sendJSON(res, 400, { error: err.message || "请求错误" });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`✨ 小站已启动： http://localhost:${PORT}`);
});

module.exports = server;
