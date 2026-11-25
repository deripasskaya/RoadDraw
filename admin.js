(function () {
  "use strict";

  /* ============================================================
     Константы и состояние
     ============================================================ */

  var CFG_KEY = "road-admin-v1";

  var MAX_SIDE = 800;       /* сжимаем фото до 800px по длинной стороне */
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

  function luma(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  /* ============================================================
     Обработка фото: нормализация освещения и удаление фона
     ============================================================ */

  /* Карта «бумаги»: по ячейкам собираем светлые малонасыщенные пиксели,
     пустые ячейки заполняем от соседей и сглаживаем. */
  function buildPaperGrid(px, w, h) {
    var cell = Math.max(8, Math.round(Math.max(w, h) / 40));
    var gw = Math.ceil(w / cell);
    var gh = Math.ceil(h / cell);
    var n = gw * gh;

    var sumR = new Float32Array(n);
    var sumG = new Float32Array(n);
    var sumB = new Float32Array(n);
    var cnt = new Float32Array(n);
    var tot = new Float32Array(n);

    for (var y = 0; y < h; y++) {
      var gy = (y / cell) | 0;

      for (var x = 0; x < w; x++) {
        var gi = gy * gw + ((x / cell) | 0);
        tot[gi]++;

        var o = (y * w + x) * 4;
        if (px[o + 3] < 16) continue;

        var r = px[o];
        var g = px[o + 1];
        var b = px[o + 2];
        var mx = Math.max(r, g, b);
        var mn = Math.min(r, g, b);

        if (luma(r, g, b) >= 100 && mx - mn <= 80) {
          sumR[gi] += r;
          sumG[gi] += g;
          sumB[gi] += b;
          cnt[gi]++;
        }
      }
    }

    var gr = new Float32Array(n);
    var gg = new Float32Array(n);
    var gb = new Float32Array(n);
    var valid = new Uint8Array(n);
    var validCount = 0;

    for (var i = 0; i < n; i++) {
      if (cnt[i] >= Math.max(3, tot[i] * 0.08)) {
        gr[i] = sumR[i] / cnt[i];
        gg[i] = sumG[i] / cnt[i];
        gb[i] = sumB[i] / cnt[i];
        valid[i] = 1;
        validCount++;
      }
    }

    if (validCount < 3) return null;

    /* Заполняем ячейки без бумаги от соседей */
    var queue = new Int32Array(n);
    var qh = 0;
    var qt = 0;

    for (i = 0; i < n; i++) {
      if (valid[i]) queue[qt++] = i;
    }

    while (qh < qt) {
      var ci = queue[qh++];
      var cx = ci % gw;
      var cy = (ci / gw) | 0;

      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;

          var nx = cx + dx;
          var ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;

          var ni = ny * gw + nx;
          if (valid[ni]) continue;

          var sr = 0;
          var sg = 0;
          var sb = 0;
          var sc = 0;

          for (var yy = -1; yy <= 1; yy++) {
            for (var xx = -1; xx <= 1; xx++) {
              var ax = nx + xx;
              var ay = ny + yy;
              if (ax < 0 || ay < 0 || ax >= gw || ay >= gh) continue;

              var ai = ay * gw + ax;
              if (!valid[ai]) continue;

              sr += gr[ai];
              sg += gg[ai];
              sb += gb[ai];
              sc++;
            }
          }

          if (sc) {
            gr[ni] = sr / sc;
            gg[ni] = sg / sc;
            gb[ni] = sb / sc;
            valid[ni] = 1;
            queue[qt++] = ni;
          }
        }
      }
    }

    /* Сглаживаем карту */
    for (var pass = 0; pass < 2; pass++) {
      var tr = new Float32Array(n);
      var tg = new Float32Array(n);
      var tb = new Float32Array(n);

      for (var sy = 0; sy < gh; sy++) {
        for (var sx = 0; sx < gw; sx++) {
          var si = sy * gw + sx;
          var ar = 0;
          var ag = 0;
          var ab = 0;
          var ac = 0;

          for (var by = -1; by <= 1; by++) {
            for (var bx = -1; bx <= 1; bx++) {
              var ux = sx + bx;
              var uy = sy + by;
              if (ux < 0 || uy < 0 || ux >= gw || uy >= gh) continue;

              var ui = uy * gw + ux;
              if (!valid[ui]) continue;

              ar += gr[ui];
              ag += gg[ui];
              ab += gb[ui];
              ac++;
            }
          }

          tr[si] = ar / ac;
          tg[si] = ag / ac;
          tb[si] = ab / ac;
        }
      }

      gr = tr;
      gg = tg;
      gb = tb;
    }

    return { r: gr, g: gg, b: gb, gw: gw, gh: gh, cell: cell };
  }

  function samplePaperGrid(grid, x, y, out) {
    var u = x / grid.cell - 0.5;
    var v = y / grid.cell - 0.5;

    var x0 = Math.floor(u);
    var y0 = Math.floor(v);
    var fx = u - x0;
    var fy = v - y0;
    var x1 = x0 + 1;
    var y1 = y0 + 1;

    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 < 0) x1 = 0;
    if (y1 < 0) y1 = 0;
    if (x0 > grid.gw - 1) x0 = grid.gw - 1;
    if (y0 > grid.gh - 1) y0 = grid.gh - 1;
    if (x1 > grid.gw - 1) x1 = grid.gw - 1;
    if (y1 > grid.gh - 1) y1 = grid.gh - 1;

    var i00 = y0 * grid.gw + x0;
    var i10 = y0 * grid.gw + x1;
    var i01 = y1 * grid.gw + x0;
    var i11 = y1 * grid.gw + x1;

    out[0] = (grid.r[i00] * (1 - fx) + grid.r[i10] * fx) * (1 - fy) +
             (grid.r[i01] * (1 - fx) + grid.r[i11] * fx) * fy;
    out[1] = (grid.g[i00] * (1 - fx) + grid.g[i10] * fx) * (1 - fy) +
             (grid.g[i01] * (1 - fx) + grid.g[i11] * fx) * fy;
    out[2] = (grid.b[i00] * (1 - fx) + grid.b[i10] * fx) * (1 - fy) +
             (grid.b[i01] * (1 - fx) + grid.b[i11] * fx) * fy;
  }

  /* Выравниваем освещение и убираем цветовой оттенок бумаги */
  function normalizeLighting(px, w, h) {
    var grid = buildPaperGrid(px, w, h);
    if (!grid) return false;

    var out = [0, 0, 0];
    var target = 244;
    var i = 0;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        samplePaperGrid(grid, x, y, out);

        var o = i * 4;
        var gr = target / Math.max(45, out[0]);
        var gg = target / Math.max(45, out[1]);
        var gb = target / Math.max(45, out[2]);

        if (gr > 2.8) gr = 2.8;
        if (gg > 2.8) gg = 2.8;
        if (gb > 2.8) gb = 2.8;

        px[o] = px[o] * gr;
        px[o + 1] = px[o + 1] * gg;
        px[o + 2] = px[o + 2] * gb;
        i++;
      }
    }

    return true;
  }

  /* Цвет фона — медиана по четырём углам */
  function sampleCornerColor(px, w, h) {
    var patch = Math.max(1, Math.min(w, h, Math.max(4, Math.round(Math.min(w, h) * 0.04))));
    var rs = [];
    var gs = [];
    var bs = [];

    function addRegion(x0, y0, x1, y1) {
      var step = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) / 12));

      for (var y = y0; y < y1; y += step) {
        for (var x = x0; x < x1; x += step) {
          var o = (y * w + x) * 4;
          rs.push(px[o]);
          gs.push(px[o + 1]);
          bs.push(px[o + 2]);
        }
      }
    }

    addRegion(0, 0, patch, patch);
    addRegion(w - patch, 0, w, patch);
    addRegion(0, h - patch, patch, h);
    addRegion(w - patch, h - patch, w, h);

    function median(arr) {
      arr.sort(function (a, b) { return a - b; });
      return arr[(arr.length / 2) | 0];
    }

    return [median(rs), median(gs), median(bs)];
  }

  /* Мягкое сглаживание края (feathering) */
  function featherAlpha(px, w, h, r) {
    if (r < 1) return;

    var total = w * h;
    var src = new Float32Array(total);
    var tmp = new Float32Array(total);
    var i;

    for (i = 0; i < total; i++) src[i] = px[i * 4 + 3];

    for (var y = 0; y < h; y++) {
      var row = y * w;

      for (var x = 0; x < w; x++) {
        var from = x - r < 0 ? 0 : x - r;
        var to = x + r > w - 1 ? w - 1 : x + r;
        var sum = 0;
        var n = 0;

        for (var k = from; k <= to; k++) {
          sum += src[row + k];
          n++;
        }

        tmp[row + x] = sum / n;
      }
    }

    for (var x2 = 0; x2 < w; x2++) {
      for (var y2 = 0; y2 < h; y2++) {
        var from2 = y2 - r < 0 ? 0 : y2 - r;
        var to2 = y2 + r > h - 1 ? h - 1 : y2 + r;
        var sum2 = 0;
        var n2 = 0;

        for (var k2 = from2; k2 <= to2; k2++) {
          sum2 += tmp[k2 * w + x2];
          n2++;
        }

        px[(y2 * w + x2) * 4 + 3] = sum2 / n2;
      }
    }
  }

  /* Маска штрихов: Собель по нормализованной яркости + локальный контраст.
     Тень на бумаге плавная, а карандаш даёт резкий перепад и тёмную сторону. */
  function buildStrokeMask(px, w, h) {
    var total = w * h;
    var lum = new Float32Array(total);
    var i;

    for (i = 0; i < total; i++) {
      var o = i * 4;
      lum[i] = luma(px[o], px[o + 1], px[o + 2]);
    }

    var edge = new Uint8Array(total);
    var edgeThresh = 55;
    var x, y;

    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;

        var gx =
          -lum[i - w - 1] + lum[i - w + 1] -
          2 * lum[i - 1] + 2 * lum[i + 1] -
          lum[i + w - 1] + lum[i + w + 1];

        var gy =
          -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] +
          lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];

        if (Math.abs(gx) + Math.abs(gy) <= edgeThresh) continue;

        /* Отсекаем светлую текстуру бумаги: у штриха есть тёмная сторона */
        var mn = 255;
        var mx = 0;

        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var v = lum[(y + dy) * w + (x + dx)];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }

        if (mx - mn < 18) continue;
        if (mn > 232) continue;

        edge[i] = 1;
      }
    }

    /* Убираем одиночные пиксели шума, оставляем линии */
    var protect = new Uint8Array(total);

    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;
        if (!edge[i]) continue;

        var count = 0;
        for (var dy2 = -1; dy2 <= 1; dy2++) {
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            if (dx2 || dy2) count += edge[(y + dy2) * w + (x + dx2)];
          }
        }

        if (count >= 2) protect[i] = 1;
      }
    }

    return protect;
  }

  /* Авто-уровни + вибранс только для пикселей машины.
     Меряем 5-й процентиль тёмных и максимум насыщенности и подтягиваем
     к эталону. juicePercent: 50 = авто, 0 = выкл, 100 = максимум. */
  function autoTune(px, w, h, juicePercent) {
    var total = w * h;
    var lumHist = new Uint32Array(256);
    var satHist = new Uint32Array(256);
    var count = 0;
    var i;

    for (i = 0; i < total; i++) {
      var o = i * 4;
      if (px[o + 3] < 16) continue;

      var r = px[o];
      var g = px[o + 1];
      var b = px[o + 2];
      var l = luma(r, g, b) | 0;
      if (l < 0) l = 0;
      if (l > 255) l = 255;

      var s = Math.max(r, g, b) - Math.min(r, g, b);

      lumHist[l]++;
      satHist[s]++;
      count++;
    }

    if (!count) return;

    function percentile(hist, p) {
      var target = count * p;
      var acc = 0;
      for (var v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= target) return v;
      }
      return 255;
    }

    var p90 = percentile(lumHist, 0.9);
    var p5 = percentile(lumHist, 0.05);
    var p99sat = percentile(satHist, 0.99);

    /* Если тёмных пикселей мало, не принимаем бумагу за штрих */
    if (p5 > p90 - 25) p5 = p90 - 25;
    if (p5 < 0) p5 = 0;

    var span = Math.max(20, p90 - p5);

    var juice = Math.max(0, Math.min(100, juicePercent)) / 50;
    var targetDark = 52;
    var targetWhite = 250;

    var darkOut = p5 + (Math.min(p5, targetDark) - p5) * juice;
    var whiteOut = p90 + (Math.max(p90, targetWhite) - p90) * juice;

    if (darkOut < 0) darkOut = 0;
    if (whiteOut > 255) whiteOut = 255;

    var satFactor = 1;
    if (p99sat >= 10) {
      satFactor = 165 / p99sat;
      if (satFactor < 0.7) satFactor = 0.7;
      if (satFactor > 1.5) satFactor = 1.5;
    }

    satFactor = 1 + (satFactor - 1) * juice;
    if (satFactor < 0.6) satFactor = 0.6;
    if (satFactor > 2.0) satFactor = 2.0;

    var lut = new Uint8Array(256);

    for (var v2 = 0; v2 < 256; v2++) {
      var t = (v2 - p5) / span;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      lut[v2] = Math.round(darkOut + (whiteOut - darkOut) * t);
    }

    for (i = 0; i < total; i++) {
      var o2 = i * 4;
      if (px[o2 + 3] < 16) continue;

      var r2 = px[o2];
      var g2 = px[o2 + 1];
      var b2 = px[o2 + 2];
      var l2 = luma(r2, g2, b2);
      var s2 = Math.max(r2, g2, b2) - Math.min(r2, g2, b2);

      /* Бумага внутри контура — в чистый белый */
      if (l2 >= 235 && s2 <= 42) {
        px[o2] = r2 + (252 - r2) * 0.85;
        px[o2 + 1] = g2 + (252 - g2) * 0.85;
        px[o2 + 2] = b2 + (252 - b2) * 0.85;
        continue;
      }

      var idx = l2 | 0;
      if (idx < 0) idx = 0;
      if (idx > 255) idx = 255;

      var newL = lut[idx];

      /* Vibrance: малонасыщенные цвета усиливаем сильнее,
         а перенасыщенные — наоборот, слегка приглушаем */
      var weight;
      if (satFactor >= 1) {
        weight = 1 - s2 / 255;
      } else {
        weight = s2 / 255;
      }

      var vib = 1 + (satFactor - 1) * weight;
      if (vib < 0.5) vib = 0.5;
      if (vib > 2.2) vib = 2.2;

      var nr = newL + (r2 - l2) * vib;
      var ng = newL + (g2 - l2) * vib;
      var nb = newL + (b2 - l2) * vib;

      px[o2] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
      px[o2 + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
      px[o2 + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
    }
  }

  /* Удаляем светлый малонасыщенный фон, связанный с краями.
     Штрихи (protect) и их расширенная маска (guard) не дают
     заливке протечь внутрь кузова через тонкие линии. */
  function removeLightBackground(px, w, h, tolPercent, protect) {
    var total = w * h;
    var bg = sampleCornerColor(px, w, h);
    var slider = Math.max(0, Math.min(100, tolPercent));

    var lThresh = 210 - slider * 0.55;
    var satThresh = 40 + slider * 0.3;
    var tol = 35 + slider * 1.0;
    var tol2 = tol * tol;

    var bgLike = new Uint8Array(total);
    var wasClear = new Uint8Array(total);
    var i;

    for (i = 0; i < total; i++) {
      if (px[i * 4 + 3] < 16) wasClear[i] = 1;
    }

    for (i = 0; i < total; i++) {
      var o = i * 4;
      if (wasClear[i]) {
        bgLike[i] = 1;
        continue;
      }

      var r = px[o];
      var g = px[o + 1];
      var b = px[o + 2];
      var mx = Math.max(r, g, b);
      var mn = Math.min(r, g, b);

      if (luma(r, g, b) < lThresh) continue;
      if (mx - mn > satThresh) continue;

      var dr = r - bg[0];
      var dg = g - bg[1];
      var db = b - bg[2];
      if (dr * dr + dg * dg + db * db > tol2) continue;

      bgLike[i] = 1;
    }

    var radius = Math.max(2, Math.min(3, Math.round(Math.min(w, h) / 350)));
    var guard = morphDilate(protect, w, h, radius);

    var outside = new Uint8Array(total);
    var stack = new Int32Array(total);
    var sp = 0;

    function push(idx) {
      if (outside[idx] || !bgLike[idx] || guard[idx]) return;
      outside[idx] = 1;
      stack[sp++] = idx;
    }

    for (var x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }

    for (var y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }

    while (sp > 0) {
      var idx = stack[--sp];
      var ix = idx % w;
      var iy = (idx / w) | 0;

      if (ix > 0) push(idx - 1);
      if (ix < w - 1) push(idx + 1);
      if (iy > 0) push(idx - w);
      if (iy < h - 1) push(idx + w);
    }

    var removed = 0;
    for (i = 0; i < total; i++) {
      if (outside[i]) removed++;
    }

    /* Съедаем светлую кайму вокруг штрихов, сами штрихи не трогаем */
    for (var pass = 0; pass < radius + 1; pass++) {
      var add = [];

      for (var y2 = 0; y2 < h; y2++) {
        for (var x2 = 0; x2 < w; x2++) {
          var i2 = y2 * w + x2;
          if (outside[i2] || !bgLike[i2] || protect[i2]) continue;

          var near =
            (x2 > 0 && outside[i2 - 1]) ||
            (x2 < w - 1 && outside[i2 + 1]) ||
            (y2 > 0 && outside[i2 - w]) ||
            (y2 < h - 1 && outside[i2 + w]);

          if (near) add.push(i2);
        }
      }

      for (i = 0; i < add.length; i++) outside[add[i]] = 1;
      removed += add.length;
    }

    for (i = 0; i < total; i++) {
      px[i * 4 + 3] = (outside[i] || wasClear[i]) ? 0 : 255;
    }

    featherAlpha(px, w, h, Math.max(1, Math.round(Math.min(w, h) / 400)));

    for (i = 0; i < total; i++) {
      if (wasClear[i]) px[i * 4 + 3] = 0;
    }

    return removed;
  }

  /* Расширяем непрозрачные участки на r пикселей во все стороны */
  function morphDilate(src, w, h, r) {
    var tmp = new Uint8Array(w * h);
    var out = new Uint8Array(w * h);

    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var from = Math.max(0, x - r);
        var to = Math.min(w - 1, x + r);
        var v = 0;
        for (var k = from; k <= to; k++) {
          if (src[row + k]) { v = 1; break; }
        }
        tmp[row + x] = v;
      }
    }

    for (var x2 = 0; x2 < w; x2++) {
      for (var y2 = 0; y2 < h; y2++) {
        var from2 = Math.max(0, y2 - r);
        var to2 = Math.min(h - 1, y2 + r);
        var v2 = 0;
        for (var k2 = from2; k2 <= to2; k2++) {
          if (tmp[k2 * w + x2]) { v2 = 1; break; }
        }
        out[y2 * w + x2] = v2;
      }
    }

    return out;
  }

  /* Морфологическое закрытие: заделывает узкие разрывы в обводке */
  function morphClose(mask, w, h, r) {
    var grown = morphDilate(mask, w, h, r);
    var inv = new Uint8Array(w * h);

    for (var i = 0; i < inv.length; i++) inv[i] = grown[i] ? 0 : 1;

    var grownInv = morphDilate(inv, w, h, r);
    for (var j = 0; j < grownInv.length; j++) grownInv[j] = grownInv[j] ? 0 : 1;

    return grownInv;
  }

  /* Незакрашенные места внутри рисунка (дырки, не связанные с внешним
     фоном) заливаем белым. Иначе через них просвечивает фон игры.
     Небольшие разрывы обводки перед этим заделываем, чтобы заливка
     не «утекла» наружу. */
  function fillInteriorHoles(px, w, h) {
    var total = w * h;
    var mask = new Uint8Array(total);

    for (var i = 0; i < total; i++) {
      if (px[i * 4 + 3] >= 16) mask[i] = 1;
    }

    var r = Math.max(2, Math.min(5, Math.round(Math.min(w, h) / 300)));
    var closed = morphClose(mask, w, h, r);

    var outside = new Uint8Array(total);
    var stack = new Int32Array(total);
    var sp = 0;

    function push(idx) {
      if (outside[idx] || closed[idx]) return;
      outside[idx] = 1;
      stack[sp++] = idx;
    }

    for (var x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (var y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }

    while (sp > 0) {
      var idx2 = stack[--sp];
      var ix = idx2 % w;
      var iy = (idx2 / w) | 0;

      if (ix > 0) push(idx2 - 1);
      if (ix < w - 1) push(idx2 + 1);
      if (iy > 0) push(idx2 - w);
      if (iy < h - 1) push(idx2 + w);
    }

    var filled = 0;

    for (var k = 0; k < total; k++) {
      if (px[k * 4 + 3] >= 16 || outside[k]) continue;

      var o = k * 4;
      px[o] = 255;
      px[o + 1] = 255;
      px[o + 2] = 255;
      px[o + 3] = 255;
      filled++;
    }

    return filled;
  }

  function removeBackground(px, w, h, tolPercent, juicePercent) {
    var total = w * h;

    var clearCount = 0;
    for (var i = 3; i < px.length; i += 4) {
      if (px[i] < 16) clearCount++;
    }

    /* Уже вырезанная картинка: прозрачный фон не трогаем */
    if (clearCount > total * 0.08) {
      autoTune(px, w, h, juicePercent);
      return true;
    }

    normalizeLighting(px, w, h);

    var protect = buildStrokeMask(px, w, h);
    var removed = removeLightBackground(px, w, h, tolPercent, protect);

    autoTune(px, w, h, juicePercent);

    return removed > total * 0.005;
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

  function processPhoto(img, removeBg, tolPercent, juicePercent) {
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
      var ok = removeBackground(px, w, h, tolPercent, juicePercent);
      if (!ok) {
        warning = "Не удалось отделить фон. Сфотографируйте рисунок на однотонном листе покрупнее.";
      }
      c.putImageData(data, 0, 0);
    } else {
      /* Прозрачный PNG: фон уже убран, но «сочность» всё равно работает */
      var hasClear = false;
      for (var ai = 3; ai < px.length; ai += 4) {
        if (px[ai] < 16) {
          hasClear = true;
          break;
        }
      }

      if (hasClear) {
        autoTune(px, w, h, juicePercent);
        c.putImageData(data, 0, 0);
      }
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

    /* Повторно заливаем внутренние дырки уже в готовой картинке:
       при уменьшении тонкие разрывы обводки могут сомкнуться, и тогда
       незакрашенные места остались бы прозрачными. */
    var outData = octx.getImageData(0, 0, ow, oh);
    fillInteriorHoles(outData.data, ow, oh);
    octx.putImageData(outData, 0, 0);

    var transparent = 0;
    for (var tp = 3; tp < px.length; tp += 4) {
      if (px[tp] < 16) transparent++;
    }

    return {
      dataUrl: out.toDataURL("image/png"),
      width: ow,
      height: oh,
      transparentPct: Math.round(transparent / (w * h) * 100),
      cropRatio: (cw * ch) / (w * h),
      warning: warning
    };
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
      item.result = processPhoto(
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
