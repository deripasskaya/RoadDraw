(function () {
  "use strict";

  /* ============================================================
     Константы и состояние
     ============================================================ */

  var CFG_KEY = "road-admin-v1";

  var MAX_SIDE = 1400;      /* до какого размера уменьшаем фото перед обработкой */
  var TARGET_H = 320;       /* высота готовой картинки */
  var MAX_OUT_W = 900;      /* предел ширины для автобусов */

  var els = {
    settings: document.getElementById("settings"),
    settingsBody: document.getElementById("settingsBody"),
    toggleSettings: document.getElementById("toggleSettings"),
    settingsBtn: document.getElementById("settingsBtn"),
    connectionState: document.getElementById("connectionState"),
    repo: document.getElementById("repoInput"),
    branch: document.getElementById("branchInput"),
    token: document.getElementById("tokenInput"),
    saveSettings: document.getElementById("saveSettings"),
    logout: document.getElementById("logoutBtn"),
    settingsStatus: document.getElementById("settingsStatus"),

    pickLabel: document.getElementById("pickLabel"),
    fileInput: document.getElementById("fileInput"),
    removeBg: document.getElementById("removeBg"),
    tolerance: document.getElementById("tolerance"),
    list: document.getElementById("list"),
    actions: document.getElementById("actions"),
    addBtn: document.getElementById("addBtn"),
    status: document.getElementById("status"),

    done: document.getElementById("doneCard"),
    doneText: document.getElementById("doneText"),
    againBtn: document.getElementById("againBtn")
  };

  var state = {
    cfg: loadCfg(),
    items: [],
    busy: false
  };

  var seq = 0;
  var reprocessTimer = 0;

  /* ============================================================
     Настройки и localStorage
     ============================================================ */

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch (e) {
      return {};
    }
  }

  function saveCfg(cfg) {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    } catch (e) { /* приватный режим */ }
  }

  function detectRepo() {
    var host = location.hostname;
    var parts = location.pathname.split("/").filter(Boolean);

    if (host.slice(-11) === ".github.io") {
      var owner = host.slice(0, -11);
      var repo = parts.length ? parts[0] : host;
      return owner + "/" + repo;
    }
    return "";
  }

  function parseRepo(value) {
    var s = String(value || "").trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    var parts = s.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  function expandSettings() {
    els.settingsBody.hidden = false;
    els.toggleSettings.textContent = "Свернуть";
    els.toggleSettings.setAttribute("aria-expanded", "true");
  }

  function collapseSettings() {
    els.settingsBody.hidden = true;
    els.toggleSettings.textContent = "Развернуть";
    els.toggleSettings.setAttribute("aria-expanded", "false");
  }

  function updateConnectionState() {
    var c = state.cfg;
    if (c.token && c.owner && c.repo) {
      els.connectionState.textContent =
        "Подключено: " + c.owner + "/" + c.repo + " · ветка " + (c.branch || "main");
    } else if (c.owner && c.repo) {
      els.connectionState.textContent =
        "Репозиторий: " + c.owner + "/" + c.repo + ". Осталось добавить токен.";
    } else {
      els.connectionState.textContent = "Проверьте данные репозитория и токен.";
    }
  }

  /* ============================================================
     GitHub API
     ============================================================ */

  function ghError(status, data) {
    var msg = (data && data.message) || "Ошибка GitHub";

    if (status === 401) return "Токен неверный или истёк. Создайте новый.";
    if (status === 403) return "GitHub не разрешил действие. Проверьте, что у токена включено Contents: Read and write.";
    if (status === 404) return "Репозиторий или ветка не найдены. Проверьте название и ветку.";
    if (status === 409 || status === 422) return "Не удалось обновить ветку — возможно, её изменили параллельно. Попробуйте ещё раз.";
    return msg + " (" + status + ")";
  }

  function gh(method, path, body, token) {
    return fetch("https://api.github.com" + path, {
      method: method,
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    }).catch(function () {
      throw new Error("Нет связи с GitHub. Проверьте интернет.");
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(ghError(res.status, data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function repoPath() {
    return "/repos/" + state.cfg.owner + "/" + state.cfg.repo;
  }

  function verifyAccess(cfg) {
    var base = "/repos/" + cfg.owner + "/" + cfg.repo;

    return gh("GET", base, null, cfg.token).then(function (repo) {
      if (repo && repo.permissions && repo.permissions.push === false) {
        throw new Error("У токена нет права записи. Включите Contents: Read and write.");
      }
      return gh("GET", base + "/branches/" + encodeURIComponent(cfg.branch), null, cfg.token);
    });
  }

  function readManifest() {
    var path = repoPath() + "/contents/cars.json?ref=" + encodeURIComponent(state.cfg.branch);

    return gh("GET", path, null, state.cfg.token).then(function (data) {
      var bin = atob(String((data && data.content) || "").replace(/\s/g, ""));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var text = new TextDecoder().decode(bytes);
      var arr = JSON.parse(text);
      return Array.isArray(arr) ? arr : [];
    }).catch(function (e) {
      if (e.status === 404) return [];
      throw e;
    });
  }

  function commitFiles(files, message) {
    var base = repoPath();
    var branch = state.cfg.branch;
    var headSha;
    var headTree;

    return gh("GET", base + "/git/ref/heads/" + branch, null, state.cfg.token)
      .then(function (ref) {
        headSha = ref.object.sha;
        return gh("GET", base + "/git/commits/" + headSha, null, state.cfg.token);
      })
      .then(function (commit) {
        headTree = commit.tree.sha;
        return files.reduce(function (chain, file) {
          return chain.then(function (entries) {
            return gh("POST", base + "/git/blobs", {
              content: file.base64,
              encoding: "base64"
            }, state.cfg.token).then(function (blob) {
              entries.push({
                path: file.path,
                mode: "100644",
                type: "blob",
                sha: blob.sha
              });
              return entries;
            });
          });
        }, Promise.resolve([]));
      })
      .then(function (entries) {
        return gh("POST", base + "/git/trees", {
          base_tree: headTree,
          tree: entries
        }, state.cfg.token);
      })
      .then(function (tree) {
        return gh("POST", base + "/git/commits", {
          message: message,
          tree: tree.sha,
          parents: [headSha]
        }, state.cfg.token);
      })
      .then(function (commit) {
        return gh("PATCH", base + "/git/refs/heads/" + branch, {
          sha: commit.sha,
          force: false
        }, state.cfg.token);
      });
  }

  function b64Utf8(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* ============================================================
     Обработка изображения
     ============================================================ */

  function loadImageFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        resolve({ img: img, url: url });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Не удалось открыть файл. Если это HEIC с iPhone, сохраните фото как JPEG."));
      };
      img.src = url;
    });
  }

  function sampleBackground(px, w, h) {
    var corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
    var sum = [0, 0, 0];
    var n = 0;

    for (var p = 0; p < corners.length; p++) {
      var cx = corners[p][0];
      var cy = corners[p][1];

      for (var dy = -3; dy <= 3; dy++) {
        for (var dx = -3; dx <= 3; dx++) {
          var x = Math.min(w - 1, Math.max(0, cx + dx));
          var y = Math.min(h - 1, Math.max(0, cy + dy));
          var o = (y * w + x) * 4;
          if (px[o + 3] < 16) continue;

          sum[0] += px[o];
          sum[1] += px[o + 1];
          sum[2] += px[o + 2];
          n++;
        }
      }
    }

    if (!n) return [255, 255, 255];
    return [sum[0] / n, sum[1] / n, sum[2] / n];
  }

  function isLight(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b >= 192;
  }

  function removeBackground(px, w, h, tolPercent) {
    var bg = sampleBackground(px, w, h);
    var bgLight = isLight(bg[0], bg[1], bg[2]);
    var tol = 30 + Math.max(0, Math.min(100, tolPercent)) * 1.1;
    var tol2 = tol * tol;
    var total = w * h;
    var seen = new Uint8Array(total);
    var stack = new Int32Array(total);
    var sp = 0;
    var removed = 0;

    function push(i) {
      if (seen[i]) return;
      seen[i] = 1;

      var o = i * 4;
      var dr = px[o] - bg[0];
      var dg = px[o + 1] - bg[1];
      var db = px[o + 2] - bg[2];

      if (dr * dr + dg * dg + db * db > tol2) return;
      stack[sp++] = i;
    }

    if (bgLight) {
      for (var x = 0; x < w; x++) {
        push(x);
        push((h - 1) * w + x);
      }
      for (var y = 0; y < h; y++) {
        push(y * w);
        push(y * w + w - 1);
      }

      while (sp > 0) {
        var i = stack[--sp];
        px[i * 4 + 3] = 0;
        removed++;

        var ix = i % w;
        var iy = (i / w) | 0;

        if (ix > 0) push(i - 1);
        if (ix < w - 1) push(i + 1);
        if (iy > 0) push(i - w);
        if (iy < h - 1) push(i + w);
      }
    }

    /* Если лист не касается краёв кадра — ищем самый большой светлый участок */
    if (removed < total * 0.005) {
      removed += removeLargestLightArea(px, w, h);
    }

    /* Убираем светлую кайму по краю рисунка */
    for (var yy = 0; yy < h; yy++) {
      for (var xx = 0; xx < w; xx++) {
        var idx = yy * w + xx;
        var oo = idx * 4;

        if (px[oo + 3] === 0) continue;
        if (px[oo] < 228 || px[oo + 1] < 228 || px[oo + 2] < 228) continue;

        var edge =
          (xx > 0 && px[(idx - 1) * 4 + 3] === 0) ||
          (xx < w - 1 && px[(idx + 1) * 4 + 3] === 0) ||
          (yy > 0 && px[(idx - w) * 4 + 3] === 0) ||
          (yy < h - 1 && px[(idx + w) * 4 + 3] === 0);

        if (edge) px[oo + 3] = 0;
      }
    }

    return removed > total * 0.005;
  }

  function removeLargestLightArea(px, w, h) {
    var total = w * h;
    var seen = new Uint8Array(total);
    var stack = new Int32Array(total);
    var bestStart = -1;
    var bestSize = 0;
    var bestX = 0;
    var bestY = 0;
    var bestW = 0;
    var bestH = 0;

    function isPaper(i) {
      var o = i * 4;
      if (px[o + 3] < 16) return false;
      if (!isLight(px[o], px[o + 1], px[o + 2])) return false;

      var diff = Math.max(px[o], px[o + 1], px[o + 2]) - Math.min(px[o], px[o + 1], px[o + 2]);
      return diff <= 38;
    }

    for (var start = 0; start < total; start++) {
      if (seen[start]) continue;
      seen[start] = 1;
      if (!isPaper(start)) continue;

      var sp = 0;
      stack[sp++] = start;

      var size = 0;
      var minX = w;
      var maxX = -1;
      var minY = h;
      var maxY = -1;

      while (sp > 0) {
        var i = stack[--sp];
        size++;

        var ix = i % w;
        var iy = (i / w) | 0;

        if (ix < minX) minX = ix;
        if (ix > maxX) maxX = ix;
        if (iy < minY) minY = iy;
        if (iy > maxY) maxY = iy;

        if (ix > 0) add(i - 1);
        if (ix < w - 1) add(i + 1);
        if (iy > 0) add(i - w);
        if (iy < h - 1) add(i + w);
      }

      if (size > bestSize) {
        bestSize = size;
        bestStart = start;
        bestX = minX;
        bestY = minY;
        bestW = maxX - minX + 1;
        bestH = maxY - minY + 1;
      }
    }

    function add(i) {
      if (seen[i]) return;
      seen[i] = 1;
      if (!isPaper(i)) return;
      stack[sp++] = i;
    }

    if (bestStart < 0) return 0;
    if (bestSize < total * 0.12) return 0;
    if (bestW < w * 0.45 || bestH < h * 0.45) return 0;

    /* Удаляем найденный лист */
    var done = new Uint8Array(total);
    var sp2 = 0;
    stack[sp2++] = bestStart;
    done[bestStart] = 1;

    var count = 0;

    while (sp2 > 0) {
      var idx = stack[--sp2];
      px[idx * 4 + 3] = 0;
      count++;

      var x = idx % w;
      var y = (idx / w) | 0;

      if (x > 0) add2(idx - 1);
      if (x < w - 1) add2(idx + 1);
      if (y > 0) add2(idx - w);
      if (y < h - 1) add2(idx + w);
    }

    function add2(i) {
      if (done[i]) return;
      done[i] = 1;
      if (!isPaper(i)) return;
      stack[sp2++] = i;
    }

    /* Всё за пределами листа (стол, фон) и кромку листа убираем */
    var inset = Math.max(4, Math.round(Math.min(bestW, bestH) * 0.015));
    var x0 = bestX + inset;
    var y0 = bestY + inset;
    var x1 = bestX + bestW - inset;
    var y1 = bestY + bestH - inset;

    for (var yy = 0; yy < h; yy++) {
      for (var xx = 0; xx < w; xx++) {
        if (xx < x0 || xx >= x1 || yy < y0 || yy >= y1) {
          px[(yy * w + xx) * 4 + 3] = 0;
        }
      }
    }

    return count;
  }

  function alphaBounds(px, w, h) {
    var minX = w;
    var minY = h;
    var maxX = -1;
    var maxY = -1;

    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        if (px[(row + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function processPhoto(img, removeBg, tolPercent) {
    var nw = img.naturalWidth || img.width;
    var nh = img.naturalHeight || img.height;
    if (!nw || !nh) throw new Error("Пустое изображение");

    var scale = Math.min(1, MAX_SIDE / Math.max(nw, nh));
    var w = Math.max(1, Math.round(nw * scale));
    var h = Math.max(1, Math.round(nh * scale));

    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    var c = canvas.getContext("2d", { willReadFrequently: true });
    c.drawImage(img, 0, 0, w, h);

    var data;
    try {
      data = c.getImageData(0, 0, w, h);
    } catch (e) {
      throw new Error("Браузер не дал прочитать изображение");
    }

    var px = data.data;
    var warning = "";

    if (removeBg) {
      var ok = removeBackground(px, w, h, tolPercent);
      if (!ok) {
        warning = "Фон не белый — сфотографируйте рисунок на белом листе.";
      }
      c.putImageData(data, 0, 0);
    }

    var box = alphaBounds(px, w, h);
    if (!box) throw new Error("Не нашёл рисунок на фото");

    var pad = Math.max(2, Math.round(Math.min(w, h) * 0.008));
    var cx = Math.max(0, box.x - pad);
    var cy = Math.max(0, box.y - pad);
    var cw = Math.min(w - cx, box.w + pad * 2);
    var ch = Math.min(h - cy, box.h + pad * 2);

    var oh = TARGET_H;
    var ow = Math.round(cw * (TARGET_H / ch));

    if (ow > MAX_OUT_W) {
      ow = MAX_OUT_W;
      oh = Math.round(ch * (MAX_OUT_W / cw));
    }

    ow = Math.max(1, ow);
    oh = Math.max(1, oh);

    var out = document.createElement("canvas");
    out.width = ow;
    out.height = oh;

    var octx = out.getContext("2d");
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(canvas, cx, cy, cw, ch, 0, 0, ow, oh);

    return {
      dataUrl: out.toDataURL("image/png"),
      width: ow,
      height: oh,
      warning: warning
    };
  }

  /* ============================================================
     Список машин
     ============================================================ */

  function renderItem(item) {
    var el = document.createElement("article");
    el.className = "item";

    var preview = document.createElement("div");
    preview.className = "preview";

    var img = document.createElement("img");
    img.alt = "Предпросмотр машины";
    img.hidden = true;

    var ph = document.createElement("span");
    ph.className = "placeholder";
    ph.textContent = "Загрузка…";

    preview.appendChild(img);
    preview.appendChild(ph);

    var fields = document.createElement("div");
    fields.className = "fields";

    var name = document.createElement("input");
    name.type = "text";
    name.value = item.name;
    name.maxLength = 40;
    name.placeholder = "Название машины";
    name.setAttribute("aria-label", "Название машины");
    name.addEventListener("input", function () {
      item.name = name.value;
    });

    var acts = document.createElement("div");
    acts.className = "item-actions";

    var flip = document.createElement("button");
    flip.type = "button";
    flip.textContent = "↔ Отразить";
    flip.disabled = true;
    flip.addEventListener("click", function () {
      item.flip = !item.flip;
      updateItem(item);
    });

    var rm = document.createElement("button");
    rm.type = "button";
    rm.className = "remove";
    rm.textContent = "Удалить";
    rm.addEventListener("click", function () {
      removeItem(item);
    });

    acts.appendChild(flip);
    acts.appendChild(rm);

    var st = document.createElement("p");
    st.className = "item-status";

    fields.appendChild(name);
    fields.appendChild(acts);
    fields.appendChild(st);

    el.appendChild(preview);
    el.appendChild(fields);

    item.el = el;
    item.previewImg = img;
    item.placeholder = ph;
    item.flipBtn = flip;
    item.statusEl = st;

    els.list.appendChild(el);
    updateItem(item);
  }

  function updateItem(item) {
    if (!item.el) return;

    if (item.result) {
      item.previewImg.src = item.result.dataUrl;
      item.previewImg.style.transform = item.flip ? "scaleX(-1)" : "none";
      item.previewImg.hidden = false;
      item.placeholder.hidden = true;
    } else {
      item.previewImg.hidden = true;
      item.placeholder.hidden = false;
      item.placeholder.textContent =
        item.status === "processing" ? "Обработка…" :
        item.status === "error" ? "Ошибка" : "Загрузка…";
    }

    item.flipBtn.disabled = !item.result;
    item.el.classList.toggle("is-error", item.status === "error");

    var msg = "";
    if (item.status === "error") msg = item.error || "Ошибка";
    else if (item.status === "ready" && item.result && item.result.warning) msg = item.result.warning;

    item.statusEl.textContent = msg;
    item.statusEl.className = "item-status" + (item.status === "error" ? " error" : "");
  }

  function removeItem(item) {
    state.items = state.items.filter(function (i) { return i !== item; });

    if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
    if (item.url) URL.revokeObjectURL(item.url);

    updateActions();
  }

  async function prepareItem(item) {
    try {
      var loaded = await loadImageFile(item.file);
      item.img = loaded.img;
      item.url = loaded.url;
      await processItem(item);
    } catch (e) {
      item.status = "error";
      item.error = e.message;
      updateItem(item);
    }
  }

  async function processItem(item) {
    if (!item.img) return;

    item.status = "processing";
    updateItem(item);

    await new Promise(function (r) { setTimeout(r, 30); });

    try {
      item.result = processPhoto(item.img, els.removeBg.checked, parseInt(els.tolerance.value, 10));
      item.status = "ready";
    } catch (e) {
      item.result = null;
      item.status = "error";
      item.error = e.message;
    }

    updateItem(item);
    updateActions();
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
    });

    if (!files.length) {
      setStatus("Выберите изображение", "error");
      return;
    }

    setStatus("");
    els.done.hidden = true;

    for (var i = 0; i < files.length; i++) {
      var item = {
        id: "it" + (++seq),
        file: files[i],
        name: "Машина",
        flip: false,
        status: "loading",
        result: null,
        img: null,
        url: null
      };

      state.items.push(item);
      renderItem(item);
      updateActions();
      await prepareItem(item);
    }

    updateActions();
  }

  async function reprocessAll() {
    var items = state.items.filter(function (i) { return i.img; });

    for (var i = 0; i < items.length; i++) {
      await processItem(items[i]);
    }
  }

  function updateActions() {
    var ready = state.items.filter(function (i) {
      return i.status === "ready" && i.result;
    }).length;

    els.actions.hidden = state.items.length === 0;
    els.addBtn.disabled = state.busy || ready === 0;

    if (state.busy) els.addBtn.textContent = "Загружаю…";
    else if (ready) els.addBtn.textContent = "Добавить на дорогу (" + ready + ")";
    else els.addBtn.textContent = "Добавить на дорогу";
  }

  /* ============================================================
     Загрузка в GitHub
     ============================================================ */

  function cleanName(value) {
    var s = String(value || "").replace(/\s+/g, " ").trim();
    if (!s) s = "Машина";
    return s.slice(0, 40);
  }

  function plural(n, one, few, many) {
    var n10 = n % 10;
    var n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    return many;
  }

  async function commitAll() {
    if (state.busy) return;

    var ready = state.items.filter(function (i) {
      return i.status === "ready" && i.result;
    });

    if (!ready.length) return;

    if (!state.cfg.token || !state.cfg.owner || !state.cfg.repo) {
      expandSettings();
      setSettingsStatus("Сначала подключите GitHub и сохраните токен.", "error");
      els.settings.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    state.busy = true;
    updateActions();
    setStatus("Читаю текущий список машин…");

    try {
      var manifest = await readManifest();
      var files = [];
      var entries = [];
      var stamp = Date.now().toString(36);

      ready.forEach(function (item, index) {
        var id = "car-" + stamp + "-" + (index + 1) + "-" + Math.random().toString(36).slice(2, 5);
        var path = "assets/cars/" + id + ".png";

        files.push({ path: path, base64: item.result.dataUrl.split(",")[1] });
        entries.push({
          file: path,
          name: cleanName(item.name),
          facing: item.flip ? "left" : "right"
        });
      });

      var next = manifest.concat(entries);
      files.push({
        path: "cars.json",
        base64: b64Utf8(JSON.stringify(next, null, 2) + "\n")
      });

      var word = plural(ready.length, "машину", "машины", "машин");
      setStatus("Загружаю " + ready.length + " " + word + "…");

      await commitFiles(
        files,
        "Добавить " + word + ": " + entries.map(function (e) { return e.name; }).join(", ")
      );

      ready.forEach(function (item) {
        removeItem(item);
      });

      setStatus("");
      showDone(entries.length);
    } catch (e) {
      setStatus(e.message || "Не удалось добавить машины", "error");
    } finally {
      state.busy = false;
      updateActions();
    }
  }

  function showDone(count) {
    els.done.hidden = false;
    els.doneText.textContent = count === 1
      ? "Машина добавлена в репозиторий."
      : count + " " + plural(count, "машина", "машины", "машин") + " добавлены в репозиторий.";
    els.done.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ============================================================
     Статусы
     ============================================================ */

  function setStatus(text, kind) {
    els.status.textContent = text || "";
    els.status.className = "status" + (kind ? " " + kind : "");
  }

  function setSettingsStatus(text, kind) {
    els.settingsStatus.textContent = text || "";
    els.settingsStatus.className = "status" + (kind ? " " + kind : "");
  }

  /* ============================================================
     События
     ============================================================ */

  els.toggleSettings.addEventListener("click", function () {
    if (els.settingsBody.hidden) expandSettings();
    else collapseSettings();
  });

  els.settingsBtn.addEventListener("click", function () {
    expandSettings();
    els.settings.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  els.saveSettings.addEventListener("click", async function () {
    var parsed = parseRepo(els.repo.value);
    var token = els.token.value.trim();
    var branch = els.branch.value.trim() || "main";

    if (!parsed) {
      setSettingsStatus("Укажите репозиторий в виде логин/название.", "error");
      return;
    }
    if (!token) {
      setSettingsStatus("Вставьте токен GitHub.", "error");
      return;
    }

    var cfg = {
      owner: parsed.owner,
      repo: parsed.repo,
      branch: branch,
      token: token
    };

    els.saveSettings.disabled = true;
    setSettingsStatus("Проверяю доступ…");

    try {
      await verifyAccess(cfg);
      state.cfg = cfg;
      saveCfg(cfg);
      updateConnectionState();
      setSettingsStatus("Доступ есть. Можно добавлять машины.", "ok");
      collapseSettings();
    } catch (e) {
      setSettingsStatus(e.message, "error");
    } finally {
      els.saveSettings.disabled = false;
    }
  });

  els.logout.addEventListener("click", function () {
    var cfg = state.cfg;
    delete cfg.token;
    state.cfg = cfg;
    saveCfg(cfg);

    els.token.value = "";
    expandSettings();
    updateConnectionState();
    setSettingsStatus("Токен удалён из этого браузера.", "ok");
  });

  els.fileInput.addEventListener("change", function () {
    var files = els.fileInput.files;
    if (files && files.length) addFiles(files);
    els.fileInput.value = "";
  });

  els.removeBg.addEventListener("change", reprocessAll);

  els.tolerance.addEventListener("input", function () {
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(reprocessAll, 280);
  });

  els.addBtn.addEventListener("click", commitAll);

  els.againBtn.addEventListener("click", function () {
    els.done.hidden = true;
    els.pickLabel.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  /* Drag & drop на компьютере */
  ["dragenter", "dragover"].forEach(function (name) {
    els.pickLabel.addEventListener(name, function (e) {
      e.preventDefault();
      els.pickLabel.classList.add("is-over");
    });
  });

  ["dragleave", "dragend", "drop"].forEach(function (name) {
    els.pickLabel.addEventListener(name, function (e) {
      e.preventDefault();
      els.pickLabel.classList.remove("is-over");
    });
  });

  els.pickLabel.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });

  /* ============================================================
     Старт
     ============================================================ */

  (function init() {
    var cfg = state.cfg;

    if (cfg.owner && cfg.repo) {
      els.repo.value = cfg.owner + "/" + cfg.repo;
    } else {
      var detected = detectRepo();
      if (detected) {
        var parsed = parseRepo(detected);
        if (parsed) {
          state.cfg.owner = parsed.owner;
          state.cfg.repo = parsed.repo;
          els.repo.value = detected;
        }
      }
    }

    els.branch.value = cfg.branch || "main";
    els.token.value = cfg.token || "";

    updateConnectionState();

    if (cfg.token) collapseSettings();
    else expandSettings();
  })();
})();
