(function () {
  "use strict";

  /* ============================================================
     Константы и состояние
     ============================================================ */

  var CFG_KEY = "road-admin-v1";

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
    toleranceValue: document.getElementById("toleranceValue"),
    juice: document.getElementById("juice"),
    juiceValue: document.getElementById("juiceValue"),
    list: document.getElementById("list"),
    actions: document.getElementById("actions"),
    addBtn: document.getElementById("addBtn"),
    status: document.getElementById("status"),

    refreshRoadBtn: document.getElementById("refreshRoadBtn"),
    publishedList: document.getElementById("publishedList"),
    clearRoadBtn: document.getElementById("clearRoadBtn"),
    roadStatus: document.getElementById("roadStatus"),

    cropModal: document.getElementById("cropModal"),
    cropStage: document.getElementById("cropStage"),
    cropImage: document.getElementById("cropImage"),
    cropFrame: document.getElementById("cropFrame"),
    cropApply: document.getElementById("cropApply"),
    cropCancel: document.getElementById("cropCancel"),
    cropCancelX: document.getElementById("cropCancelX"),
    cropReset: document.getElementById("cropReset"),

    done: document.getElementById("doneCard"),
    doneText: document.getElementById("doneText"),
    againBtn: document.getElementById("againBtn")
  };

  var state = {
    cfg: loadCfg(),
    items: [],
    busy: false,
    published: [],
    publishedCanDelete: false
  };

  var seq = 0;
  var reprocessTimer = 0;
  var reprocessToken = 0;
  var cropItem = null;
  var cropBusy = false;
  var cropNorm = { x: 0.02, y: 0.02, w: 0.96, h: 0.96 };
  var cropRect = { x: 0, y: 0, w: 0, h: 0 };
  var cropSize = { w: 0, h: 0 };
  var cropDrag = null;

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

    if (host.slice(-10) === ".github.io") {
      var owner = host.slice(0, -10);
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
      cache: "no-store",
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

  function commitFiles(files, message, deletions) {
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
        (deletions || []).forEach(function (path) {
          entries.push({
            path: path,
            mode: "100644",
            type: "blob",
            sha: null
          });
        });

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
     Выбранные фото: обработка и лента миниатюр
     ============================================================ */

  function nextTick(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms || 30);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("Не удалось открыть изображение")); };
      img.src = src;
    });
  }

  function sourceDataUrl(img, type) {
    var nw = img.naturalWidth || img.width;
    var nh = img.naturalHeight || img.height;
    if (!nw || !nh) throw new Error("Пустое изображение");

    var scale = Math.min(1, 800 / Math.max(nw, nh));
    var w = Math.max(1, Math.round(nw * scale));
    var h = Math.max(1, Math.round(nh * scale));

    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    var c = canvas.getContext("2d");
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.drawImage(img, 0, 0, w, h);

    return canvas.toDataURL("image/png");
  }

  function rotateSourceDataUrl(src) {
    return loadImage(src).then(function (img) {
      var w = img.naturalWidth;
      var h = img.naturalHeight;

      var canvas = document.createElement("canvas");
      canvas.width = h;
      canvas.height = w;

      var c = canvas.getContext("2d");
      c.translate(h, 0);
      c.rotate(Math.PI / 2);
      c.drawImage(img, 0, 0);

      return canvas.toDataURL("image/png");
    });
  }

  function cropSourceDataUrl(src, norm) {
    return loadImage(src).then(function (img) {
      var iw = img.naturalWidth;
      var ih = img.naturalHeight;

      var sx = Math.round(norm.x * iw);
      var sy = Math.round(norm.y * ih);
      var sw = Math.round(norm.w * iw);
      var sh = Math.round(norm.h * ih);

      sx = Math.max(0, Math.min(iw - 1, sx));
      sy = Math.max(0, Math.min(ih - 1, sy));
      sw = Math.max(1, Math.min(iw - sx, sw));
      sh = Math.max(1, Math.min(ih - sy, sh));

      var canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;

      var c = canvas.getContext("2d");
      c.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      return canvas.toDataURL("image/png");
    });
  }

  function setItemBusy(item, busy) {
    item.busy = !!busy;
    if (item.el) item.el.classList.toggle("is-busy", !!busy);
    if (item.rotateBtn) item.rotateBtn.disabled = !!busy || !item.source;
    if (item.cropBtn) item.cropBtn.disabled = !!busy || !item.source;
    if (item.removeBtn) item.removeBtn.disabled = !!busy;
  }

  function renderItem(item) {
    var el = document.createElement("article");
    el.className = "edit-thumb";

    var previewWrap = document.createElement("div");
    previewWrap.className = "thumb-preview-wrap";

    var preview = document.createElement("button");
    preview.type = "button";
    preview.className = "edit-preview";
    preview.title = "Нажмите, чтобы отразить машину";
    preview.setAttribute("aria-label", "Отразить машину");

    var img = document.createElement("img");
    img.alt = "Предпросмотр машины";
    img.hidden = true;

    var ph = document.createElement("span");
    ph.className = "placeholder";
    ph.textContent = "Загрузка…";

    var badge = document.createElement("span");
    badge.className = "thumb-badge";
    badge.hidden = true;

    var flipMark = document.createElement("span");
    flipMark.className = "thumb-flip-mark";
    flipMark.textContent = "↔";
    flipMark.hidden = true;
    flipMark.setAttribute("aria-hidden", "true");

    preview.appendChild(img);
    preview.appendChild(ph);
    preview.appendChild(badge);
    preview.appendChild(flipMark);
    preview.addEventListener("click", function () {
      if (item.busy || !item.result) return;
      item.flip = !item.flip;
      updateItem(item);
    });

    var rm = document.createElement("button");
    rm.type = "button";
    rm.className = "edit-remove";
    rm.textContent = "×";
    rm.title = "Убрать из подборки";
    rm.setAttribute("aria-label", "Убрать из подборки");
    rm.addEventListener("click", function () {
      removeItem(item);
    });

    previewWrap.appendChild(preview);
    previewWrap.appendChild(rm);

    var tools = document.createElement("div");
    tools.className = "thumb-tools";

    var rot = document.createElement("button");
    rot.type = "button";
    rot.className = "edit-tool";
    rot.textContent = "↻";
    rot.title = "Повернуть на 90° по часовой стрелке";
    rot.setAttribute("aria-label", "Повернуть на 90°");
    rot.disabled = true;
    rot.addEventListener("click", function () {
      rotateItem(item);
    });

    var crop = document.createElement("button");
    crop.type = "button";
    crop.className = "edit-tool";
    crop.textContent = "✂️";
    crop.title = "Обрезать рамкой";
    crop.setAttribute("aria-label", "Обрезать рамкой");
    crop.disabled = true;
    crop.addEventListener("click", function () {
      openCrop(item);
    });

    tools.appendChild(rot);
    tools.appendChild(crop);

    var name = document.createElement("input");
    name.type = "text";
    name.className = "edit-name";
    name.value = item.name;
    name.maxLength = 40;
    name.placeholder = "Название машины";
    name.setAttribute("aria-label", "Название машины");
    name.addEventListener("input", function () {
      item.name = name.value;
    });

    var st = document.createElement("p");
    st.className = "edit-status";

    el.appendChild(previewWrap);
    el.appendChild(tools);
    el.appendChild(name);
    el.appendChild(st);

    item.el = el;
    item.preview = preview;
    item.previewImg = img;
    item.previewBadge = badge;
    item.flipMark = flipMark;
    item.placeholder = ph;
    item.rotateBtn = rot;
    item.cropBtn = crop;
    item.removeBtn = rm;
    item.nameInput = name;
    item.statusEl = st;

    els.list.appendChild(el);
    updateItem(item);
  }

  /* Фон считается убранным, если прозрачна заметная часть фото
     или если от кадра остался заметно меньший фрагмент. */
  function backgroundLooksRemoved(item) {
    if (!item.result) return false;

    var pct = item.result.transparentPct || 0;
    var crop = typeof item.result.cropRatio === "number" ? item.result.cropRatio : 1;

    return pct >= 40 || crop < 0.75;
  }

  function updateItem(item) {
    if (!item.el) return;

    var ready = item.status === "ready" && !!item.result;

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

    item.flipMark.hidden = !ready;
    item.preview.disabled = item.busy || !ready;
    item.rotateBtn.disabled = item.busy || !item.source;
    item.cropBtn.disabled = item.busy || !item.source;
    item.removeBtn.disabled = !!item.busy;

    item.el.classList.toggle("is-error", item.status === "error");
    item.el.classList.toggle("is-busy", !!item.busy);

    var bgOk = backgroundLooksRemoved(item);

    if (item.previewBadge) {
      if (ready && bgOk) {
        item.previewBadge.textContent = "✓";
        item.previewBadge.className = "thumb-badge ok";
        item.previewBadge.title = "Фон прозрачный";
        item.previewBadge.hidden = false;
      } else if (ready && els.removeBg.checked) {
        item.previewBadge.textContent = "!";
        item.previewBadge.className = "thumb-badge warn";
        item.previewBadge.title = "Фон не убран";
        item.previewBadge.hidden = false;
      } else {
        item.previewBadge.hidden = true;
      }
    }

    var msg = "";
    if (item.status === "error") {
      msg = item.error || "Ошибка";
    } else if (ready && item.result.warning) {
      msg = item.result.warning;
    } else if (ready && els.removeBg.checked && !bgOk) {
      msg = "Фон не убран — увеличьте чувствительность.";
    }

    item.statusEl.textContent = msg;
    item.statusEl.className = "edit-status" + (item.status === "error" ? " error" : "");
  }

  function removeItem(item) {
    if (item.busy) return;

    if (cropItem === item) closeCropModal();

    state.items = state.items.filter(function (i) { return i !== item; });

    if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);

    updateActions();
  }

  async function prepareItem(item) {
    try {
      var loaded = await RoadImage.loadImageFile(item.file);

      try {
        item.source = sourceDataUrl(loaded.img, item.file.type);
      } finally {
        if (loaded.url) URL.revokeObjectURL(loaded.url);
      }

      item.img = await loadImage(item.source);
      await processItem(item);
    } catch (e) {
      item.status = "error";
      item.error = e.message;
      updateItem(item);
      updateActions();
    }
  }

  async function processItem(item) {
    if (!item.img) return;

    item.status = "processing";
    setItemBusy(item, true);
    updateItem(item);

    await nextTick(30);

    try {
      item.result = RoadImage.processPhoto(
        item.img,
        els.removeBg.checked,
        parseInt(els.tolerance.value, 10),
        parseInt(els.juice.value, 10)
      );
      item.status = "ready";
      item.error = "";
    } catch (e) {
      item.result = null;
      item.status = "error";
      item.error = e.message;
    }

    setItemBusy(item, false);
    updateItem(item);
    updateActions();
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif|svg)$/i.test(f.name);
    });

    if (!files.length) {
      setStatus("Выберите изображение", "error");
      return;
    }

    setStatus("");
    els.done.hidden = true;

    for (var i = 0; i < files.length; i++) {
      setStatus("Обрабатываю " + (i + 1) + " из " + files.length + "…");

      var item = {
        id: "it" + (++seq),
        file: files[i],
        name: "Машина",
        flip: false,
        busy: false,
        status: "loading",
        result: null,
        img: null,
        source: null
      };

      state.items.push(item);
      renderItem(item);
      updateActions();
      await prepareItem(item);
    }

    setStatus("");
    updateActions();
  }

  async function reprocessAll() {
    var token = ++reprocessToken;
    var items = state.items.filter(function (i) { return i.source; });

    if (!items.length) return;

    setStatus("Обновляю превью…");

    for (var i = 0; i < items.length; i++) {
      if (token !== reprocessToken) return;
      await processItem(items[i]);
    }

    setStatus("");
  }

  async function rotateItem(item) {
    if (!item || item.busy || !item.source) return;

    setItemBusy(item, true);
    setStatus("Поворачиваю машину…");

    try {
      var rotated = await rotateSourceDataUrl(item.source);
      item.source = rotated;
      item.img = await loadImage(rotated);
      await processItem(item);

      if (item.status === "error") {
        setStatus(item.error || "Не удалось повернуть фото", "error");
      } else {
        setStatus("Машина повернута.");
      }
    } catch (e) {
      setItemBusy(item, false);
      updateItem(item);
      setStatus(e.message || "Не удалось повернуть фото", "error");
    }
  }

  function updateActions() {
    var ready = state.items.filter(function (i) {
      return i.status === "ready" && i.result;
    }).length;

    els.actions.hidden = state.items.length === 0;
    els.addBtn.disabled = state.busy || ready === 0;
    els.clearRoadBtn.disabled = state.busy;
    els.refreshRoadBtn.disabled = state.busy;

    els.tolerance.disabled = state.busy;
    els.juice.disabled = state.busy;
    els.removeBg.disabled = state.busy;

    state.items.forEach(function (item) {
      if (item.preview) {
        item.preview.disabled = state.busy || item.busy || item.status !== "ready" || !item.result;
      }
      if (item.rotateBtn) {
        item.rotateBtn.disabled = state.busy || item.busy || !item.source;
      }
      if (item.cropBtn) {
        item.cropBtn.disabled = state.busy || item.busy || !item.source;
      }
      if (item.removeBtn) {
        item.removeBtn.disabled = state.busy || item.busy;
      }
      if (item.nameInput) {
        item.nameInput.disabled = state.busy;
      }
    });

    if (els.publishedList) {
      var dels = els.publishedList.querySelectorAll(".published-delete");
      for (var d = 0; d < dels.length; d++) {
        dels[d].disabled = state.busy || !state.publishedCanDelete;
      }
    }

    if (state.busy) els.addBtn.textContent = "Подождите…";
    else if (ready) els.addBtn.textContent = "Опубликовать на дороге (" + ready + ")";
    else els.addBtn.textContent = "Опубликовать на дороге";
  }

  /* ============================================================
     Ручная обрезка
     ============================================================ */

  function cropClamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function syncCropFrame() {
    if (!cropSize.w || !cropSize.h) return;

    var W = cropSize.w;
    var H = cropSize.h;

    var x = Math.round(cropNorm.x * W);
    var y = Math.round(cropNorm.y * H);
    var w = Math.round(cropNorm.w * W);
    var h = Math.round(cropNorm.h * H);

    x = cropClamp(x, 0, Math.max(0, W - 2));
    y = cropClamp(y, 0, Math.max(0, H - 2));
    w = cropClamp(w, 2, W - x);
    h = cropClamp(h, 2, H - y);

    cropRect = { x: x, y: y, w: w, h: h };

    els.cropFrame.style.left = x + "px";
    els.cropFrame.style.top = y + "px";
    els.cropFrame.style.width = w + "px";
    els.cropFrame.style.height = h + "px";
  }

  function resetCropFrame() {
    if (!cropSize.w || !cropSize.h) return;

    cropNorm = { x: 0.02, y: 0.02, w: 0.96, h: 0.96 };
    syncCropFrame();
  }

  function initCropStage() {
    if (!cropItem || els.cropModal.hidden) return;

    var w = els.cropImage.clientWidth;
    var h = els.cropImage.clientHeight;

    if (!w || !h) {
      setTimeout(initCropStage, 20);
      return;
    }

    cropSize.w = w;
    cropSize.h = h;

    syncCropFrame();
    els.cropFrame.hidden = false;
  }

  function openCrop(item) {
    if (!item || item.busy || !item.source) return;

    cropItem = item;
    cropBusy = false;
    cropDrag = null;
    cropNorm = { x: 0.02, y: 0.02, w: 0.96, h: 0.96 };
    els.cropFrame.hidden = true;

    els.cropApply.disabled = false;
    els.cropApply.textContent = "Применить";
    els.cropReset.disabled = false;
    els.cropCancel.disabled = false;
    els.cropCancelX.disabled = false;

    els.cropImage.onload = initCropStage;
    els.cropImage.onerror = function () {
      setStatus("Не удалось открыть фото", "error");
      closeCropModal();
    };

    els.cropImage.removeAttribute("src");
    els.cropModal.hidden = false;
    document.body.classList.add("crop-open");
    els.cropImage.src = item.source;

    if (els.cropImage.complete && els.cropImage.naturalWidth) {
      setTimeout(initCropStage, 0);
    }
  }

  function closeCropModal() {
    els.cropModal.hidden = true;
    document.body.classList.remove("crop-open");

    cropItem = null;
    cropDrag = null;
    cropBusy = false;

    document.removeEventListener("pointermove", cropPointerMove);
    document.removeEventListener("pointerup", cropPointerEnd);
    document.removeEventListener("pointercancel", cropPointerEnd);

    els.cropFrame.hidden = true;
    els.cropImage.removeAttribute("src");
  }

  function cropPointerDown(e) {
    if (cropBusy || !cropItem || !cropSize.w) return;

    var handle = e.target && e.target.getAttribute
      ? e.target.getAttribute("data-handle")
      : null;

    cropDrag = {
      mode: handle ? "resize" : "move",
      handle: handle || "",
      startX: e.clientX,
      startY: e.clientY,
      rect: {
        x: cropRect.x,
        y: cropRect.y,
        w: cropRect.w,
        h: cropRect.h
      }
    };

    if (e.target.setPointerCapture) {
      try {
        e.target.setPointerCapture(e.pointerId);
      } catch (err) { /* ignore */ }
    }

    document.removeEventListener("pointermove", cropPointerMove);
    document.removeEventListener("pointerup", cropPointerEnd);
    document.removeEventListener("pointercancel", cropPointerEnd);
    document.addEventListener("pointermove", cropPointerMove, { passive: false });
    document.addEventListener("pointerup", cropPointerEnd);
    document.addEventListener("pointercancel", cropPointerEnd);

    e.preventDefault();
  }

  function cropPointerMove(e) {
    if (!cropDrag || cropBusy) return;

    e.preventDefault();

    var W = cropSize.w;
    var H = cropSize.h;
    if (!W || !H) return;

    var min = Math.min(28, W * 0.3, H * 0.3);
    if (min < 6) min = 6;

    var dx = e.clientX - cropDrag.startX;
    var dy = e.clientY - cropDrag.startY;
    var r = cropDrag.rect;

    var x = r.x;
    var y = r.y;
    var w = r.w;
    var h = r.h;

    if (cropDrag.mode === "move") {
      x = cropClamp(r.x + dx, 0, W - r.w);
      y = cropClamp(r.y + dy, 0, H - r.h);
    } else {
      var left = r.x;
      var right = r.x + r.w;
      var top = r.y;
      var bottom = r.y + r.h;

      if (cropDrag.handle.indexOf("w") !== -1) {
        left = cropClamp(left + dx, 0, right - min);
      }
      if (cropDrag.handle.indexOf("e") !== -1) {
        right = cropClamp(right + dx, left + min, W);
      }
      if (cropDrag.handle.indexOf("n") !== -1) {
        top = cropClamp(top + dy, 0, bottom - min);
      }
      if (cropDrag.handle.indexOf("s") !== -1) {
        bottom = cropClamp(bottom + dy, top + min, H);
      }

      x = left;
      y = top;
      w = right - left;
      h = bottom - top;
    }

    cropNorm = {
      x: x / W,
      y: y / H,
      w: w / W,
      h: h / H
    };

    syncCropFrame();
  }

  function cropPointerEnd() {
    cropDrag = null;

    document.removeEventListener("pointermove", cropPointerMove);
    document.removeEventListener("pointerup", cropPointerEnd);
    document.removeEventListener("pointercancel", cropPointerEnd);
  }

  async function applyCrop() {
    if (cropBusy || !cropItem) return;

    var item = cropItem;

    if (!item.source) {
      closeCropModal();
      return;
    }

    if (cropNorm.w < 0.02 || cropNorm.h < 0.02) {
      setStatus("Рамка слишком маленькая", "error");
      return;
    }

    cropBusy = true;
    setItemBusy(item, true);

    els.cropApply.disabled = true;
    els.cropApply.textContent = "Обработка…";
    els.cropReset.disabled = true;
    els.cropCancel.disabled = true;
    els.cropCancelX.disabled = true;

    try {
      var cropped = await cropSourceDataUrl(item.source, cropNorm);
      item.source = cropped;
      item.img = await loadImage(cropped);
      await processItem(item);

      if (item.status === "error") {
        throw new Error(item.error || "Не удалось обработать фото");
      }

      closeCropModal();
      setStatus("Машина обрезана.");
    } catch (e) {
      setStatus(e.message || "Не удалось обрезать фото", "error");
    } finally {
      cropBusy = false;

      els.cropApply.disabled = false;
      els.cropApply.textContent = "Применить";
      els.cropReset.disabled = false;
      els.cropCancel.disabled = false;
      els.cropCancelX.disabled = false;

      setItemBusy(item, false);
      updateItem(item);
    }
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

    var busyItem = state.items.some(function (i) { return i.busy; });
    if (busyItem) {
      setStatus("Дождитесь окончания обработки фото.", "error");
      return;
    }

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

    var word = plural(ready.length, "машину", "машины", "машин");
    var entries = [];
    var attempts = 3;

    try {
      for (var attempt = 1; attempt <= attempts; attempt++) {
        try {
          var manifest = await readManifest();
          var files = [];
          entries = [];
          var stamp = Date.now().toString(36) + "-" + attempt;

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

          setStatus(attempt === 1
            ? "Загружаю " + ready.length + " " + word + "…"
            : "Ветка изменилась, повторяю загрузку…");

          await commitFiles(
            files,
            "Добавить " + word + ": " + entries.map(function (e) { return e.name; }).join(", ")
          );

          break;
        } catch (e) {
          var conflict = e.status === 409 || e.status === 422;

          if (conflict && attempt < attempts) {
            await new Promise(function (resolve) { setTimeout(resolve, 700 * attempt); });
            continue;
          }

          throw e;
        }
      }

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
      refreshPublished(true);
    }
  }

  function showDone(count) {
    els.done.hidden = false;
    els.doneText.textContent = count === 1
      ? "Машина добавлена в репозиторий."
      : count + " " + plural(count, "машина", "машины", "машин") + " добавлены в репозиторий.";
    els.done.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function clearRoad() {
    if (state.busy) return;

    if (!state.cfg.token || !state.cfg.owner || !state.cfg.repo) {
      expandSettings();
      setSettingsStatus("Сначала подключите GitHub и сохраните токен.", "error");
      els.settings.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    var ok = confirm("Убрать все машины с дороги? Рисунки останутся в репозитории.");
    if (!ok) return;

    state.busy = true;
    updateActions();
    setRoadStatus("Очищаю дорогу…");

    var attempts = 3;

    try {
      for (var attempt = 1; attempt <= attempts; attempt++) {
        try {
          var manifest = await readManifest();

          if (!manifest.length) {
            setRoadStatus("Дорога уже пустая.", "ok");
            return;
          }

          await commitFiles(
            [{ path: "cars.json", base64: b64Utf8("[]\n") }],
            "Очистить дорогу"
          );

          setRoadStatus("Дорога очищена. Игра обновится в течение минуты.", "ok");
          return;
        } catch (e) {
          var conflict = e.status === 409 || e.status === 422;

          if (conflict && attempt < attempts) {
            setRoadStatus("Ветка изменилась, повторяю…");
            await new Promise(function (resolve) { setTimeout(resolve, 700 * attempt); });
            continue;
          }

          throw e;
        }
      }
    } catch (e) {
      setRoadStatus(e.message || "Не удалось очистить дорогу", "error");
    } finally {
      state.busy = false;
      updateActions();
      refreshPublished(true);
    }
  }

  /* ============================================================
     Сейчас на дороге: опубликованные машины
     ============================================================ */

  function hasGitHub() {
    return !!(state.cfg.token && state.cfg.owner && state.cfg.repo);
  }

  function fetchSiteManifest() {
    return fetch("cars.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("Не удалось прочитать cars.json");
        return r.json();
      })
      .catch(function () { return []; });
  }

  function publishedImageSrc(entry) {
    var bust = "?v=" + Date.now();

    if (hasGitHub()) {
      var path = String(entry.file || "")
        .replace(/^\/+/, "")
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      return "https://raw.githubusercontent.com/" +
        state.cfg.owner + "/" + state.cfg.repo + "/" +
        encodeURIComponent(state.cfg.branch || "main") + "/" + path + bust;
    }

    return entry.file + bust;
  }

  function renderPublished() {
    if (!els.publishedList) return;

    els.publishedList.textContent = "";

    if (!state.published.length) {
      var empty = document.createElement("p");
      empty.className = "published-empty";
      empty.textContent = "Пока на дороге никого нет.";
      els.publishedList.appendChild(empty);
      return;
    }

    state.published.forEach(function (entry) {
      if (!entry || !entry.file) return;

      var card = document.createElement("article");
      card.className = "published-item";

      var preview = document.createElement("div");
      preview.className = "published-preview";

      var img = document.createElement("img");
      img.alt = entry.name || "Машина";
      img.src = publishedImageSrc(entry);
      preview.appendChild(img);

      var name = document.createElement("p");
      name.className = "published-name";
      name.textContent = cleanName(entry.name);

      var facing = document.createElement("p");
      facing.className = "published-facing";
      facing.textContent = entry.facing === "left" ? "нос влево" : "нос вправо";

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "published-delete";
      rm.textContent = "🗑";
      rm.title = state.publishedCanDelete
        ? "Удалить с дороги и из репозитория"
        : "Подключите GitHub, чтобы удалять машины";
      rm.setAttribute("aria-label", "Удалить " + cleanName(entry.name) + " с дороги");
      rm.disabled = !state.publishedCanDelete || state.busy;
      rm.addEventListener("click", function () {
        deletePublished(entry);
      });

      card.appendChild(preview);
      card.appendChild(rm);
      card.appendChild(name);
      card.appendChild(facing);
      els.publishedList.appendChild(card);
    });
  }

  function refreshPublished(quiet) {
    if (!els.publishedList) return Promise.resolve();

    if (!quiet) setRoadStatus("Загружаю список машин…");
    if (els.refreshRoadBtn) els.refreshRoadBtn.disabled = true;

    var request = hasGitHub() ? readManifest() : fetchSiteManifest();

    return request.then(function (list) {
      state.published = Array.isArray(list) ? list : [];
      state.publishedCanDelete = hasGitHub();
      renderPublished();
      if (!quiet) setRoadStatus("");
    }).catch(function (e) {
      return fetchSiteManifest().then(function (list) {
        state.published = Array.isArray(list) ? list : [];
        state.publishedCanDelete = false;
        renderPublished();
        if (!quiet) setRoadStatus(e.message || "Список загружен с сайта.", "");
      });
    }).then(function () {
      if (els.refreshRoadBtn) els.refreshRoadBtn.disabled = state.busy;
    });
  }

  async function deletePublished(entry) {
    if (state.busy) return;

    if (!hasGitHub()) {
      expandSettings();
      setSettingsStatus("Сначала подключите GitHub и сохраните токен.", "error");
      els.settings.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    var name = cleanName(entry.name);
    var ok = confirm("Удалить «" + name + "» с дороги и из репозитория? PNG-файл будет удалён.");
    if (!ok) return;

    state.busy = true;
    updateActions();
    setRoadStatus("Удаляю машину…");

    var attempts = 3;
    var finalMsg = "";
    var finalKind = "ok";

    try {
      for (var attempt = 1; attempt <= attempts; attempt++) {
        try {
          var manifest = await readManifest();
          var idx = -1;

          for (var i = 0; i < manifest.length; i++) {
            if (manifest[i] && manifest[i].file === entry.file) {
              idx = i;
              break;
            }
          }

          if (idx < 0) {
            finalMsg = "Машина уже удалена.";
            break;
          }

          var next = manifest.slice(0);
          next.splice(idx, 1);

          var stillUsed = false;
          for (var j = 0; j < next.length; j++) {
            if (next[j] && next[j].file === entry.file) {
              stillUsed = true;
              break;
            }
          }

          var deletions = (!stillUsed && entry.file)
            ? [String(entry.file).replace(/^\/+/, "")]
            : [];

          await commitFiles(
            [{ path: "cars.json", base64: b64Utf8(JSON.stringify(next, null, 2) + "\n") }],
            "Удалить машину: " + name,
            deletions
          );

          finalMsg = "Машина удалена с дороги и из репозитория.";
          break;
        } catch (e) {
          var conflict = e.status === 409 || e.status === 422;

          if (conflict && attempt < attempts) {
            setRoadStatus("Ветка изменилась, повторяю…");
            await new Promise(function (resolve) { setTimeout(resolve, 700 * attempt); });
            continue;
          }

          throw e;
        }
      }
    } catch (e) {
      finalMsg = e.message || "Не удалось удалить машину";
      finalKind = "error";
    } finally {
      state.busy = false;
      updateActions();
    }

    await refreshPublished(true);
    setRoadStatus(finalMsg, finalKind);
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

  function setRoadStatus(text, kind) {
    els.roadStatus.textContent = text || "";
    els.roadStatus.className = "status" + (kind ? " " + kind : "");
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
      refreshPublished(true);
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
    refreshPublished(true);
  });

  els.fileInput.addEventListener("change", function () {
    var files = els.fileInput.files;
    if (files && files.length) addFiles(files);
    els.fileInput.value = "";
  });

  els.removeBg.addEventListener("change", reprocessAll);

  function updateToleranceLabel() {
    els.toleranceValue.textContent = els.tolerance.value;
  }

  els.tolerance.addEventListener("input", function () {
    updateToleranceLabel();
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(reprocessAll, 220);
  });

  function updateJuiceLabel() {
    var v = parseInt(els.juice.value, 10) || 0;
    els.juiceValue.textContent = v === 50 ? "50% · авто" : v + "%";
  }

  els.juice.addEventListener("input", function () {
    updateJuiceLabel();
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(reprocessAll, 220);
  });

  updateToleranceLabel();
  updateJuiceLabel();

  els.addBtn.addEventListener("click", commitAll);
  els.clearRoadBtn.addEventListener("click", clearRoad);
  els.refreshRoadBtn.addEventListener("click", function () {
    refreshPublished();
  });

  els.cropFrame.addEventListener("pointerdown", cropPointerDown);
  els.cropApply.addEventListener("click", applyCrop);
  els.cropCancel.addEventListener("click", closeCropModal);
  els.cropCancelX.addEventListener("click", closeCropModal);
  els.cropReset.addEventListener("click", resetCropFrame);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !els.cropModal.hidden && !cropBusy) closeCropModal();
  });

  window.addEventListener("resize", function () {
    if (!els.cropModal.hidden) setTimeout(initCropStage, 150);
  });

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
    state.cfg.branch = cfg.branch || "main";

    updateConnectionState();

    if (cfg.token) collapseSettings();
    else expandSettings();

    refreshPublished();
  })();
})();
