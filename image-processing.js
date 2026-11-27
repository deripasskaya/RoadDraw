(function (global) {
  "use strict";

  /* Модуль обработки фото для админки. Это исходный алгоритм,
     который использовался до экспериментов с силуэтом и автообрезкой. */

  var MAX_SIDE = 800;
  var TARGET_H = 320;
  var MAX_OUT_W = 900;

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

  /* Мягкое уплотнение: Multiply с размытой копией (radius 1–2 px).
     Работает только по непрозрачным пикселям, альфа не меняется. */
  function blurMultiply(px, w, h, strength) {
    if (strength <= 0.001) return;

    var total = w * h;
    var radius = Math.max(1, Math.round(Math.min(w, h) / 400));
    var hr = new Float32Array(total);
    var hg = new Float32Array(total);
    var hb = new Float32Array(total);
    var ha = new Float32Array(total);
    var x, y, k, o, i;

    /* Горизонтальный проход с учётом альфы */
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var x0 = x - radius < 0 ? 0 : x - radius;
        var x1 = x + radius > w - 1 ? w - 1 : x + radius;
        var sr = 0;
        var sg = 0;
        var sb = 0;
        var sa = 0;

        for (k = x0; k <= x1; k++) {
          o = (y * w + k) * 4;
          var a = px[o + 3] / 255;
          if (a <= 0) continue;
          sr += px[o] * a;
          sg += px[o + 1] * a;
          sb += px[o + 2] * a;
          sa += a;
        }

        i = y * w + x;
        hr[i] = sr;
        hg[i] = sg;
        hb[i] = sb;
        ha[i] = sa;
      }
    }

    /* Вертикальный проход и мягкое умножение */
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var y0 = y - radius < 0 ? 0 : y - radius;
        var y1 = y + radius > h - 1 ? h - 1 : y + radius;
        var sr2 = 0;
        var sg2 = 0;
        var sb2 = 0;
        var sa2 = 0;

        for (k = y0; k <= y1; k++) {
          i = k * w + x;
          sr2 += hr[i];
          sg2 += hg[i];
          sb2 += hb[i];
          sa2 += ha[i];
        }

        if (sa2 <= 0.0001) continue;

        var br = sr2 / sa2;
        var bg = sg2 / sa2;
        var bb = sb2 / sa2;

        o = (y * w + x) * 4;
        var rr = px[o];
        var gg = px[o + 1];
        var b2 = px[o + 2];

        var mr = rr * br / 255;
        var mg = gg * bg / 255;
        var mb = b2 * bb / 255;

        px[o] = rr + (mr - rr) * strength;
        px[o + 1] = gg + (mg - gg) * strength;
        px[o + 2] = b2 + (mb - b2) * strength;
      }
    }
  }

  /* Мягкое усиление без «ксерокса»: гамма + Multiply с размытой копией.
     juicePercent: 50 = авто, 0 = выкл, 100 = максимум. */
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

    if (p5 > p90 - 25) p5 = p90 - 25;
    if (p5 < 0) p5 = 0;

    var juice = Math.max(0, Math.min(100, juicePercent)) / 50;

    /* Мягкая гамма: сильнее для бледных рисунков, без порогов */
    var faint = (p5 - 60) / 160;
    if (faint < 0) faint = 0;
    if (faint > 1) faint = 1;

    var gamma = 1 + faint * 0.8 * juice;
    if (gamma > 2.1) gamma = 2.1;

    /* 1) Гамма по яркости, оттенок сохраняем */
    for (i = 0; i < total; i++) {
      var o1 = i * 4;
      if (px[o1 + 3] < 16) continue;

      var r1 = px[o1];
      var g1 = px[o1 + 1];
      var b1 = px[o1 + 2];
      var l1 = luma(r1, g1, b1);

      var nl = 255 * Math.pow(l1 / 255, gamma);
      var scale = l1 > 0.5 ? nl / l1 : 1;

      px[o1] = r1 * scale;
      px[o1 + 1] = g1 * scale;
      px[o1 + 2] = b1 * scale;
    }

    /* 2) Мягкое уплотнение штриховки */
    var multStrength = Math.max(0, Math.min(100, juicePercent)) / 100 * 0.9;
    blurMultiply(px, w, h, multStrength);

    /* 3) Авто-насыщенность (Vibrance) */
    var satFactor = 1;
    if (p99sat >= 10) {
      satFactor = 180 / p99sat;
      if (satFactor < 0.7) satFactor = 0.7;
      if (satFactor > 1.7) satFactor = 1.7;
    }

    satFactor = 1 + (satFactor - 1) * juice;
    if (satFactor < 0.6) satFactor = 0.6;
    if (satFactor > 2.0) satFactor = 2.0;

    for (i = 0; i < total; i++) {
      var o2 = i * 4;
      if (px[o2 + 3] < 16) continue;

      var r2 = px[o2];
      var g2 = px[o2 + 1];
      var b2 = px[o2 + 2];
      var l2 = luma(r2, g2, b2);
      var s2 = Math.max(r2, g2, b2) - Math.min(r2, g2, b2);

      var weight;
      if (satFactor >= 1) {
        weight = 1 - s2 / 255;
      } else {
        weight = s2 / 255;
      }

      var vib = 1 + (satFactor - 1) * weight;
      if (vib < 0.5) vib = 0.5;
      if (vib > 2.2) vib = 2.2;

      var nr = l2 + (r2 - l2) * vib;
      var ng = l2 + (g2 - l2) * vib;
      var nb = l2 + (b2 - l2) * vib;

      /* Мягкая подтяжка только чистой бумаги: цветную штриховку не трогаем */
      var brightness = (l2 - 225) / 20;
      if (brightness < 0) brightness = 0;
      if (brightness > 1) brightness = 1;
      brightness = brightness * brightness * (3 - 2 * brightness);

      var neutral = 1 - (s2 - 3) / 6;
      if (neutral < 0) neutral = 0;
      if (neutral > 1) neutral = 1;

      var paper = brightness * neutral * 0.95;

      nr = nr + (250 - nr) * paper;
      ng = ng + (250 - ng) * paper;
      nb = nb + (250 - nb) * paper;

      px[o2] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
      px[o2 + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
      px[o2 + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
    }
  }

  /* Простой и предсказуемый способ: находим цвет бумаги по краям кадра,
     заливаем от краёв всё похожее на бумагу и оставляем только рисунок. */
  function removeLightBackground(px, w, h, tolPercent) {
    var total = w * h;
    var bg = sampleCornerColor(px, w, h);
    var slider = Math.max(0, Math.min(100, tolPercent));

    /* Чем выше «Чувствительность», тем шире допуск к цвету бумаги. */
    var tol = 24 + slider * 1.05;
    var tol2 = tol * tol;
    var lumFloor = 198 - slider * 0.55;
    var satMax = 9 + slider * 0.09;

    var bgLike = new Uint8Array(total);
    var wasClear = new Uint8Array(total);
    var i, o, r, g, b;

    for (i = 0; i < total; i++) {
      if (px[i * 4 + 3] < 16) {
        wasClear[i] = 1;
        bgLike[i] = 1;
        continue;
      }

      o = i * 4;
      r = px[o];
      g = px[o + 1];
      b = px[o + 2];

      if (luma(r, g, b) < lumFloor) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) > satMax) continue;

      var dr = r - bg[0];
      var dg = g - bg[1];
      var db = b - bg[2];

      if (dr * dr + dg * dg + db * db > tol2) continue;

      bgLike[i] = 1;
    }

    /* Заливка только от внешнего края: внутренние белые области
       (кузов, стекло) остаются нетронутыми, если обводка замкнута. */
    var outside = new Uint8Array(total);
    var stack = new Int32Array(total);
    var sp = 0;

    function push(idx) {
      if (outside[idx] || !bgLike[idx]) return;
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
      px[i * 4 + 3] = (outside[i] || wasClear[i]) ? 0 : 255;
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

    var removed = removeLightBackground(px, w, h, tolPercent);

    autoTune(px, w, h, juicePercent);
    featherAlpha(px, w, h, 1);
    decontaminateEdgeColors(px, w, h);

    return removed > total * 0.005;
  }

  /* Аккуратно сглаживаем рваные одиночные ступеньки на альфа-крае:
     медиана 3×3 дважды, без расширения и без новых полупрозрачных пикселей. */
  function smoothAlphaOutline(px, w, h) {
    var total = w * h;
    var src = new Uint8Array(total);
    var out = new Uint8Array(total);
    var vals = new Uint8Array(9);
    var i;

    for (i = 0; i < total; i++) src[i] = px[i * 4 + 3];

    for (var pass = 0; pass < 2; pass++) {
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var n = 0;

          for (var dy = -1; dy <= 1; dy++) {
            var ny = y + dy;

            for (var dx = -1; dx <= 1; dx++) {
              var nx = x + dx;

              if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
                vals[n++] = 0;
              } else {
                vals[n++] = src[ny * w + nx];
              }
            }
          }

          for (var a = 0; a < 9; a++) {
            for (var b = a + 1; b < 9; b++) {
              if (vals[b] < vals[a]) {
                var t = vals[a];
                vals[a] = vals[b];
                vals[b] = t;
              }
            }
          }

          out[y * w + x] = vals[4];
        }
      }

      src.set(out);
    }

    for (i = 0; i < total; i++) px[i * 4 + 3] = src[i];
  }

  /* Одна простая операция закрытия контура: не даёт белому кузову
     провалиться в фон через разрывы обводки. */




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

  function paperPixel(r, g, b) {
    var mx = Math.max(r, g, b);
    var mn = Math.min(r, g, b);
    return luma(r, g, b) >= 126 && mx - mn <= 66;
  }

  function longestPaperRun(frac, threshold) {
    var bestStart = 0;
    var bestLen = 0;
    var start = -1;

    for (var i = 0; i < frac.length; i++) {
      if (frac[i] >= threshold) {
        if (start < 0) start = i;
        var len = i - start + 1;
        if (len > bestLen) {
          bestLen = len;
          bestStart = start;
        }
      } else {
        start = -1;
      }
    }

    if (!bestLen) return null;
    return { start: bestStart, end: bestStart + bestLen - 1 };
  }

  function detectPaperBounds(px, w, h) {
    var step = Math.max(2, Math.round(Math.max(w, h) / 170));
    var cols = Math.ceil(w / step);
    var rows = Math.ceil(h / step);
    var rowHits = new Uint32Array(rows);
    var rowTot = new Uint32Array(rows);
    var colHits = new Uint32Array(cols);
    var colTot = new Uint32Array(cols);
    var x, y;

    for (y = 0; y < h; y += step) {
      var ry = (y / step) | 0;

      for (x = 0; x < w; x += step) {
        var cx = (x / step) | 0;
        var o = (y * w + x) * 4;

        rowTot[ry]++;
        colTot[cx]++;

        if (paperPixel(px[o], px[o + 1], px[o + 2])) {
          rowHits[ry]++;
          colHits[cx]++;
        }
      }
    }

    var rowFrac = new Float32Array(rows);
    var colFrac = new Float32Array(cols);
    var rowMax = 0;
    var colMax = 0;

    for (var i = 0; i < rows; i++) {
      rowFrac[i] = rowTot[i] ? rowHits[i] / rowTot[i] : 0;
      if (rowFrac[i] > rowMax) rowMax = rowFrac[i];
    }

    for (var j = 0; j < cols; j++) {
      colFrac[j] = colTot[j] ? colHits[j] / colTot[j] : 0;
      if (colFrac[j] > colMax) colMax = colFrac[j];
    }

    var rowRun = longestPaperRun(rowFrac, Math.max(0.1, rowMax * 0.18));
    var colRun = longestPaperRun(colFrac, Math.max(0.1, colMax * 0.18));

    if (!rowRun || !colRun) return null;

    var x0 = colRun.start * step;
    var y0 = rowRun.start * step;
    var x1 = Math.min(w, (colRun.end + 1) * step);
    var y1 = Math.min(h, (rowRun.end + 1) * step);

    if ((x1 - x0) * (y1 - y0) < w * h * 0.08) return null;
    if (x0 < 2 && y0 < 2 && w - x1 < 2 && h - y1 < 2) return null;

    var inset = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) * 0.015));

    x0 += inset;
    y0 += inset;
    x1 -= inset;
    y1 -= inset;

    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(w, x1);
    y1 = Math.min(h, y1);

    var bw = x1 - x0;
    var bh = y1 - y0;

    if (bw < 2 || bh < 2) return null;

    return { x: x0, y: y0, w: bw, h: bh };
  }

  /* Убираем светлые пиксели бумаги, прилипшие к внешнему краю рисунка. */
  function trimLightEdgePixels(px, w, h, radius, lumMin, satMax) {
    lumMin = lumMin || 205;
    satMax = satMax || 40;
    var total = w * h;
    var srcAlpha = new Uint8Array(total);
    var i;

    for (i = 0; i < total; i++) srcAlpha[i] = px[i * 4 + 3];

    var removed = 0;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        i = y * w + x;
        if (srcAlpha[i] < 128) continue;

        var o = i * 4;
        var r = px[o];
        var g = px[o + 1];
        var b = px[o + 2];
        var lum = luma(r, g, b);
        var sat = Math.max(r, g, b) - Math.min(r, g, b);

        if (lum < lumMin || sat > satMax) continue;

        var nearEdge = false;

        for (var dy = -radius; dy <= radius && !nearEdge; dy++) {
          var ny = y + dy;

          for (var dx = -radius; dx <= radius; dx++) {
            var nx = x + dx;

            if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
              nearEdge = true;
              break;
            }

            if (srcAlpha[ny * w + nx] < 48) {
              nearEdge = true;
              break;
            }
          }
        }

        if (nearEdge) {
          px[o + 3] = 0;
          removed++;
        }
      }
    }

    return removed;
  }

  /* Полупрозрачной кромке отдаём цвет плотных штрихов рядом,
     а не белый оттенок бумаги. */
  function decontaminateEdgeColors(px, w, h) {
    var total = w * h;
    var src = new Uint8ClampedArray(px);
    var radius = 3;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var a = src[i * 4 + 3];

        if (a === 0 || a >= 250) continue;

        var sumR = 0;
        var sumG = 0;
        var sumB = 0;
        var sumW = 0;
        var inkR = 0;
        var inkG = 0;
        var inkB = 0;
        var inkW = 0;

        for (var dy = -radius; dy <= radius; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;

          for (var dx = -radius; dx <= radius; dx++) {
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;

            var ni = ny * w + nx;
            var na = src[ni * 4 + 3];
            if (na < 64) continue;

            sumR += src[ni * 4] * na;
            sumG += src[ni * 4 + 1] * na;
            sumB += src[ni * 4 + 2] * na;
            sumW += na;

            var nr = src[ni * 4];
            var ng = src[ni * 4 + 1];
            var nb = src[ni * 4 + 2];
            var nLum = luma(nr, ng, nb);
            var nSat = Math.max(nr, ng, nb) - Math.min(nr, ng, nb);

            if (nLum < 190 || nSat > 30) {
              inkR = nr * na;
              inkG = ng * na;
              inkB = nb * na;
              inkW = na;
              if (na > 180) break;
            }
          }
          if (inkW > 0 && inkW >= 180) break;
        }

        if (inkW > 0) {
          px[i * 4] = inkR / inkW;
          px[i * 4 + 1] = inkG / inkW;
          px[i * 4 + 2] = inkB / inkW;
        } else if (a < 250 && luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) >= 200) {
          px[i * 4 + 3] = 0;
        } else if (sumW > 0) {
          px[i * 4] = sumR / sumW;
          px[i * 4 + 1] = sumG / sumW;
          px[i * 4 + 2] = sumB / sumW;
        }
      }
    }
  }

  /* Мелкие светлые островки пыли и бумажных точек (меньше 80 px). */
  function removeSmallLightIslands(px, w, h) {
    var total = w * h;
    var seen = new Uint8Array(total);
    var stack = new Int32Array(total);
    var comp = [];
    var removed = 0;

    for (var start = 0; start < total; start++) {
      if (seen[start] || px[start * 4 + 3] < 16) continue;

      var sp = 0;
      stack[sp++] = start;
      seen[start] = 1;
      comp.length = 0;

      var area = 0;
      var light = 0;

      while (sp > 0) {
        var idx = stack[--sp];
        var x = idx % w;
        var y = (idx / w) | 0;

        comp.push(idx);
        area++;

        var o = idx * 4;
        var r = px[o];
        var g = px[o + 1];
        var b = px[o + 2];
        var lum = luma(r, g, b);
        var sat = Math.max(r, g, b) - Math.min(r, g, b);

        if (lum >= 125 && sat <= 70) light++;

        if (x > 0) {
          var ni = idx - 1;
          if (!seen[ni] && px[ni * 4 + 3] >= 16) {
            seen[ni] = 1;
            stack[sp++] = ni;
          }
        }
        if (x < w - 1) {
          var ni2 = idx + 1;
          if (!seen[ni2] && px[ni2 * 4 + 3] >= 16) {
            seen[ni2] = 1;
            stack[sp++] = ni2;
          }
        }
        if (y > 0) {
          var ni3 = idx - w;
          if (!seen[ni3] && px[ni3 * 4 + 3] >= 16) {
            seen[ni3] = 1;
            stack[sp++] = ni3;
          }
        }
        if (y < h - 1) {
          var ni4 = idx + w;
          if (!seen[ni4] && px[ni4 * 4 + 3] >= 16) {
            seen[ni4] = 1;
            stack[sp++] = ni4;
          }
        }
      }

      var lightRatio = area ? light / area : 0;

      if (area < 80 && lightRatio >= 0.5) {
        for (var k = 0; k < comp.length; k++) {
          px[comp[k] * 4 + 3] = 0;
        }
        removed += area;
      }
    }

    return removed;
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
      var clearCount = 0;
      for (var ci = 3; ci < px.length; ci += 4) {
        if (px[ci] < 16) clearCount++;
      }

      /* Сначала убираем стол по краям кадра: работаем только с бумагой. */
      if (clearCount < w * h * 0.02) {
        var paper = detectPaperBounds(px, w, h);

        if (paper) {
          var paperCanvas = document.createElement("canvas");
          paperCanvas.width = paper.w;
          paperCanvas.height = paper.h;

          var pc = paperCanvas.getContext("2d", { willReadFrequently: true });
          pc.drawImage(canvas, paper.x, paper.y, paper.w, paper.h, 0, 0, paper.w, paper.h);

          data = pc.getImageData(0, 0, paper.w, paper.h);
          px = data.data;
          canvas = paperCanvas;
          c = pc;
          w = paper.w;
          h = paper.h;
        }
      }

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
    /* Финальная чистка кромки: убираем прилипшие светлые пиксели бумаги,
       затем мягко сглаживаем альфу и подкрашиваем полупрозрачный край
       цветом соседних штрихов, чтобы не было белого ореола. */
    fillInteriorHoles(outData.data, ow, oh);
    removeSmallLightIslands(outData.data, ow, oh);
    trimLightEdgePixels(outData.data, ow, oh, 2);
    smoothAlphaOutline(outData.data, ow, oh);
    featherAlpha(outData.data, ow, oh, 1);
    decontaminateEdgeColors(outData.data, ow, oh);
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

  global.RoadImage = {
    MAX_SIDE: MAX_SIDE,
    loadImageFile: loadImageFile,
    processPhoto: processPhoto
  };
})(window);
