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
    juice: document.getElementById("juice"),
    juiceValue: document.getElementById("juiceValue"),
    list: document.getElementById("list"),
    actions: document.getElementById("actions"),
    addBtn: document.getElementById("addBtn"),
    status: document.getElementById("status"),

    clearRoadBtn: document.getElementById("clearRoadBtn"),
    roadStatus: document.getElementById("roadStatus"),

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
     Список машин
     ============================================================ */

  function renderItem(item) {
    var el = document.createElement("article");
    el.className = "item";

    var previewWrap = document.createElement("div");
    previewWrap.className = "preview-wrap";

    var preview = document.createElement("div");
    preview.className = "preview";

    var img = document.createElement("img");
    img.alt = "Предпросмотр машины";
    img.hidden = true;

    var ph = document.createElement("span");
    ph.className = "placeholder";
    ph.textContent = "Загрузка…";

    var badge = document.createElement("span");
    badge.className = "preview-badge";
    badge.hidden = true;

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "preview-toggle";
    toggle.textContent = "На дороге";
    toggle.hidden = true;
    toggle.addEventListener("click", function () {
      item.showRoad = !item.showRoad;
      updatePreviewStyle(item);
    });

    preview.appendChild(img);
    preview.appendChild(ph);
    preview.appendChild(badge);
    preview.appendChild(toggle);

    var caption = document.createElement("span");
    caption.className = "preview-caption";
    caption.textContent = "Шахматка — прозрачный фон";

    previewWrap.appendChild(preview);
    previewWrap.appendChild(caption);

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

    el.appendChild(previewWrap);
    el.appendChild(fields);

    item.el = el;
    item.preview = preview;
    item.previewImg = img;
    item.previewBadge = badge;
    item.previewToggle = toggle;
    item.placeholder = ph;
    item.flipBtn = flip;
    item.statusEl = st;

    updatePreviewStyle(item);

    els.list.appendChild(el);
    updateItem(item);
  }

  function updatePreviewStyle(item) {
    if (!item.preview) return;

    item.preview.classList.toggle("is-road", !!item.showRoad);
    item.previewToggle.textContent = item.showRoad ? "Прозрачность" : "На дороге";
    item.previewToggle.setAttribute("aria-pressed", item.showRoad ? "true" : "false");
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

    if (item.previewToggle) item.previewToggle.hidden = !item.result;

    var bgOk = backgroundLooksRemoved(item);

    if (item.previewBadge) {
      if (item.result && bgOk) {
        item.previewBadge.textContent = "Фон прозрачный";
        item.previewBadge.className = "preview-badge ok";
        item.previewBadge.hidden = false;
      } else if (item.result && els.removeBg.checked) {
        item.previewBadge.textContent = "Фон не убран";
        item.previewBadge.className = "preview-badge warn";
        item.previewBadge.hidden = false;
      } else {
        item.previewBadge.hidden = true;
      }
    }

    var msg = "";
    if (item.status === "error") {
      msg = item.error || "Ошибка";
    } else if (item.status === "ready" && item.result && item.result.warning) {
      msg = item.result.warning;
    } else if (item.status === "ready" && item.result && els.removeBg.checked && !bgOk) {
      msg = "Фон не убран — увеличьте чувствительность.";
    }

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
      var loaded = await RoadImage.loadImageFile(item.file);
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
      item.result = RoadImage.processPhoto(
        item.img,
        els.removeBg.checked,
        parseInt(els.tolerance.value, 10),
        parseInt(els.juice.value, 10)
      );
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
        showRoad: false,
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
    els.clearRoadBtn.disabled = state.busy;

    if (state.busy) els.addBtn.textContent = "Подождите…";
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
    }
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

  function updateJuiceLabel() {
    var v = parseInt(els.juice.value, 10) || 0;
    els.juiceValue.textContent = v === 50 ? "50% · авто" : v + "%";
  }

  els.juice.addEventListener("input", function () {
    updateJuiceLabel();
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(reprocessAll, 280);
  });

  updateJuiceLabel();

  els.addBtn.addEventListener("click", commitAll);
  els.clearRoadBtn.addEventListener("click", clearRoad);

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
