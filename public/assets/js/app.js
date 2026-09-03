// 小站 · 前端通用脚本（动态版 · 完整账号系统）
// 提供：API 请求、登录态 UI、标签配色、正文 HTML <-> 文本 转换

const App = (function () {
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || "请求失败");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function tagClass(tag) {
    if (tag === "生活") return "tag-pink";
    if (tag === "学习") return "tag-blue";
    if (tag === "随笔") return "tag-green";
    if (tag === "技术") return "tag-yellow";
    return "tag-pink";
  }

  // 根据登录态填充右上角
  async function renderAuthUI() {
    const area = document.getElementById("auth-area");
    if (!area) return;
    try {
      const { user } = await api("/api/me");
      if (user) {
        const name = user.displayName || user.username;
        let menu = '<a href="profile.html">个人资料</a>';
        if (user.role === "admin") menu += '<a href="admin.html">用户管理</a>';
        menu += '<a href="#" id="logout-btn">退出登录</a>';
        const avatarHtml = user.avatar
          ? '<img class="auth-avatar" src="' + escapeHtml(user.avatar) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;auth-emoji&quot; aria-hidden=&quot;true&quot;>👤</span>\'">'
          : '<span class="auth-emoji" aria-hidden="true">👤</span>';
        area.innerHTML =
          '<div class="user-bar">' +
            '<div class="user-dropdown" id="user-dropdown">' +
              '<button class="user-trigger" type="button" aria-haspopup="true" aria-expanded="false">' +
                '<span class="auth-user">' + avatarHtml + ' ' + escapeHtml(name) + '</span>' +
                '<span class="user-caret">▾</span>' +
              '</button>' +
              '<div class="user-menu" id="user-menu">' + menu + '</div>' +
            '</div>' +
          '</div>';
        const dropdown = document.getElementById("user-dropdown");
        const trigger = dropdown.querySelector(".user-trigger");
        const menuEl = document.getElementById("user-menu");
        function toggleMenu() {
          const open = menuEl.classList.toggle("show");
          trigger.setAttribute("aria-expanded", String(open));
        }
        trigger.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleMenu();
        });
        document.addEventListener("click", function (e) {
          if (!dropdown.contains(e.target)) {
            menuEl.classList.remove("show");
            trigger.setAttribute("aria-expanded", "false");
          }
        });
        const lb = document.getElementById("logout-btn");
        if (lb)
          lb.addEventListener("click", function (e) {
            e.preventDefault();
            api("/api/logout", { method: "POST" }).then(function () {
              location.reload();
            });
          });
      } else {
        area.innerHTML =
          '<a class="auth-link" href="login.html">登录</a>' +
          '<a class="auth-link" href="register.html">注册</a>';
      }
    } catch (e) {
      area.innerHTML =
        '<a class="auth-link" href="login.html">登录</a>' +
        '<a class="auth-link" href="register.html">注册</a>';
    }
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 文本 -> HTML（与发布编辑器一致）：空行分段，以 "- " 开头成列表
  function textToHtml(text) {
    return String(text || "")
      .split(/\n\s*\n/)
      .map(function (block) {
        block = block.trim();
        if (!block) return "";
        var lines = block.split("\n").map(function (l) {
          return l.trim();
        });
        if (lines.every(function (l) {
          return l.startsWith("- ");
        })) {
          var items = lines
            .map(function (l) {
              return "        <li>" + escapeHtml(l.slice(2)) + "</li>";
            })
            .join("\n");
          return "      <ul>\n" + items + "\n      </ul>\n";
        }
        var p = block.replace(/\n/g, "<br>\n");
        return "      <p>" + p + "</p>\n";
      })
      .join("");
  }

  // HTML -> 文本（编辑时回填）
  function htmlToText(el) {
    var out = [];
    el.childNodes.forEach(function (node) {
      if (node.nodeType === 3) {
        var t = node.textContent.trim();
        if (t) out.push(t);
      } else if (node.nodeType === 1) {
        var tag = node.tagName.toLowerCase();
        if (tag === "p") {
          out.push(node.innerHTML.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
        } else if (tag === "ul" || tag === "ol") {
          node.querySelectorAll("li").forEach(function (li) {
            out.push("- " + li.textContent.trim());
          });
        } else if (tag === "blockquote") {
          out.push("> " + node.textContent.trim());
        } else if (tag === "h2" || tag === "h3") {
          out.push(node.textContent.trim());
        } else {
          out.push(node.textContent.trim());
        }
      }
    });
    return out.filter(Boolean).join("\n\n");
  }

  return {
    api: api,
    tagClass: tagClass,
    renderAuthUI: renderAuthUI,
    escapeHtml: escapeHtml,
    textToHtml: textToHtml,
    htmlToText: htmlToText,
  };
})();
