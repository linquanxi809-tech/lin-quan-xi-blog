// 文章管理：修改 / 删除
// 注意：删除仅更新首页/归档页的列表，文章文件需手动删除（浏览器无法删本地文件）。
// 这些功能需要站点通过 http 访问（本地服务器或托管），直接双击 file:// 打开时 fetch 可能被浏览器拦截。

(function () {
  function download(name, html) {
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function fetchAndStrip(pageName, file) {
    return fetch(pageName).then(function (res) {
      if (!res.ok) throw new Error("无法读取 " + pageName);
      return res.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var links = doc.querySelectorAll('a[href="' + file + '"]');
      var changed = false;
      links.forEach(function (a) {
        var card = a.closest(".card") || a.closest(".archive-item");
        if (card && card.parentNode) {
          card.parentNode.removeChild(card);
          changed = true;
        }
      });
      if (!changed) return null;
      return { name: pageName, html: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML };
    });
  }

  function removeFromLists(file) {
    return Promise.all([
      fetchAndStrip("../index.html", file),
      fetchAndStrip("../archive.html", file)
    ]).then(function (results) {
      results.forEach(function (r) {
        if (r) download(r.name, r.html);
      });
    });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-delete]");
    if (!btn) return;
    e.preventDefault();
    var file = btn.getAttribute("data-delete");
    var title = btn.getAttribute("data-title") || file;
    if (!confirm("确定要删除《" + title + "》吗？\n会更新首页和归档页的文章列表，文章文件(" + file + ")需要你手动删除。")) return;

    removeFromLists(file)
      .then(function () {
        alert("已生成更新后的 首页(index.html) 和 归档页(archive.html)，请在下载后替换原文件。\n最后别忘了手动删除文章文件：" + file);
        if (history.length > 1) history.back(); else location.href = "../archive.html";
      })
      .catch(function (err) {
        alert("处理失败：" + err.message + "\n请手动删除。如果是 file:// 直接打开，建议改用本地服务器。");
      });
  });
})();
