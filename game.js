(function () {
  "use strict";

  /* ============================================================
     Элементы и состояние
     ============================================================ */

  var canvas = document.getElementById("scene");
  var ctx = canvas.getContext("2d", { alpha: false });
  var hintEl = document.getElementById("hint");
  var pauseBtn = document.getElementById("pause");
  var soundBtn = document.getElementById("sound");
  var speedInput = document.getElementById("speed");

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var cars = [];
  var library = [];
  var lanes = [];
  var clouds = [];
  var birds = [];
  var flowers = [];
  var butterflies = [];
  var firLights = [];
  var snowflakes = [];
  var G = {};

  var imageCache = {};
  var manifestSig = "";
  var toastEl = document.getElementById("toast");
  var toastTimer = 0;

  var W = 0;
  var H = 0;
  var dpr = 1;
  var time = 0;
  var lastTs = 0;
  var raf = 0;
  var running = true;
  var speedMul = 1;
  var muted = false;
  var audio = null;
  var music = null;
  var musicFadeTimer = 0;
  var musicPauseTimer = 0;
  var musicPlaying = false;

  var MUSIC_VOLUME = 0.22;
  var MUSIC_SRC = "assets/audio/derevenskiy-rassvet.mp3";

  /* Время суток: 0 = полночь, 0.25 = рассвет, 0.5 = полдень, 0.75 = закат */
  var dayPhase = 0.45;
  var DAY_LENGTH = 240;   /* секунд на полный цикл */
  var night = 0;

  /* ============================================================
     Геометрия сцены
     ============================================================ */

  function computeGeometry() {
    var roadBottom = H * 0.96;
    var roadH = Math.min(H * 0.5, W * 0.95);
    var roadTop = roadBottom - roadH;
    var sidewalkTop = roadTop - roadH * 0.16;

    /* Машины вдвое крупнее прежнего: ближняя полоса занимает больше
       половины высоты дороги, дальняя — пропорционально меньше. */
    var nearH = roadH * 0.54;
    var farH = nearH * 0.76;

    G = {
      roadTop: roadTop,
      roadBottom: roadBottom,
      roadH: roadH,
      sidewalkTop: sidewalkTop,
      horizon: sidewalkTop - roadH * 0.12,
      centerY: roadTop + roadH * 0.5,
      farY: roadTop + farH - roadH * 0.02,
      nearY: roadTop + roadH * 0.84
    };

    if (!lanes.length) {
      lanes = [
        { id: "far", dir: -1, y: G.farY, carH: farH, speed: [0.052, 0.068], timer: 0.8 },
        { id: "near", dir: 1, y: G.nearY, carH: nearH, speed: [0.06, 0.08], timer: 1.8 }
      ];
    } else {
      lanes[0].y = G.farY;
      lanes[0].carH = farH;
      lanes[1].y = G.nearY;
      lanes[1].carH = nearH;
    }

    for (var i = 0; i < cars.length; i++) {
      var c = cars[i];
      c.h = c.lane.carH * c.sizeMul;
      c.w = c.h * c.aspect;
      if (c.w > W * 0.5) {
        c.w = W * 0.5;
        c.h = c.w / c.aspect;
      }
    }
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    computeGeometry();
    makeClouds();
    makeBirds();
    makeFlowers();
    makeButterflies();
    makeSnowfall();

    if (!running) draw();
  }

  /* ============================================================
     Загрузка машин
     ============================================================ */

  function loadImage(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  function loadLibrary(force) {
    return fetchManifest().then(function (list) {
      /* Сеть недоступна — оставляем то, что уже едет по дороге */
      if (list === null) return { changed: false, added: 0, failed: true };

      if (!Array.isArray(list)) list = [];

      var sig = JSON.stringify(list);
      if (!force && sig === manifestSig) return { changed: false, added: 0 };

      manifestSig = sig;

      return Promise.all(list.map(libraryItem)).then(function (items) {
        var prev = library.length;
        var ok = items.filter(Boolean);

        /* Если картинка ещё не доехала до CDN — попробуем в следующий раз */
        if (ok.length < items.length) manifestSig = "";

        library = ok;

        /* Пустой список — это команда «очистить дорогу»,
           а не сбой загрузки. */
        if (!list.length && cars.length) clearCars();

        return { changed: true, added: library.length - prev };
      });
    });
  }

  function fetchManifest() {
    return fetch("cars.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("no manifest");
        return r.json();
      })
      .catch(function () { return null; });
  }

  function clearCars() {
    cars.length = 0;
    toast("Дорога очищена");
    if (!running) draw();
  }

  function libraryItem(item) {
    var cached = imageCache[item.file];

    if (cached) {
      return Promise.resolve({
        img: cached.img,
        aspect: cached.aspect,
        name: item.name || "",
        facing: item.facing === "left" ? "left" : "right"
      });
    }

    var bust = location.protocol === "file:" ? "" : "?v=" + Date.now();
    return loadImage(item.file + bust).then(function (img) {
      if (!img || !img.naturalWidth) return null;

      var aspect = img.naturalWidth / img.naturalHeight;
      imageCache[item.file] = { img: img, aspect: aspect };

      return {
        img: img,
        aspect: aspect,
        name: item.name || "",
        facing: item.facing === "left" ? "left" : "right"
      };
    });
  }

  function refreshLibrary() {
    loadLibrary().then(function (res) {
      updateHint();

      if (res && res.changed && res.added > 0) {
        toast(res.added === 1 ? "На дороге новая машина!" : "На дороге новые машины!");
      }
    });
  }

  function updateHint() {
    if (!hintEl) return;

    hintEl.textContent = library.length
      ? "Нажми на машинку — она посигналит"
      : "Пока машин нет";
  }

  function toast(text) {
    if (!toastEl) return;

    toastEl.textContent = text;
    toastEl.classList.add("is-visible");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("is-visible");
    }, 4000);
  }

  /* ============================================================
     Машинки: спавн и движение
     ============================================================ */

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  /* Устойчивое «случайное» число 0..1 по номеру — для декораций,
     которые не должны перепрыгивать при изменении размера окна. */
  function rndAt(n) {
    var v = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  function imgOnRoad(img) {
    for (var i = 0; i < cars.length; i++) {
      if (cars[i].img === img) return true;
    }
    return false;
  }

  function spawn(lane) {
    if (!library.length) return false;

    /* Одна и та же картинка не должна ехать дважды */
    var pool = [];
    for (var i = 0; i < library.length; i++) {
      if (!imgOnRoad(library[i].img)) pool.push(library[i]);
    }

    if (!pool.length) return false;

    var item = pool[(Math.random() * pool.length) | 0];
    var sizeMul = rand(0.92, 1.08);
    var h = lane.carH * sizeMul;
    var w = h * item.aspect;

    if (w > W * 0.5) {
      w = W * 0.5;
      h = w / item.aspect;
      sizeMul = h / lane.carH;
    }

    var shouldFace = lane.dir === 1 ? "right" : "left";

    var car = {
      img: item.img,
      name: item.name,
      aspect: item.aspect,
      lane: lane,
      dir: lane.dir,
      sizeMul: sizeMul,
      h: h,
      w: w,
      x: lane.dir === 1 ? -w - 12 : W + 12,
      vmax: W * rand(lane.speed[0], lane.speed[1]) * rand(0.94, 1.06),
      v: 0,
      phase: Math.random() * Math.PI * 2,
      bounce: 0,
      bubble: 0,
      box: null,
      flip: item.facing !== shouldFace
    };

    car.v = car.vmax * 0.55;
    cars.push(car);

    return true;
  }

  function canSpawn(lane) {
    var gapPx = Math.max(140, W * 0.1);
    var edge = null;

    for (var i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (c.lane !== lane) continue;
      if (!edge) {
        edge = c;
      } else if (lane.dir === 1 ? c.x < edge.x : c.x > edge.x) {
        edge = c;
      }
    }

    if (!edge) return true;

    var free = lane.dir === 1 ? edge.x : W - (edge.x + edge.w);
    return free > gapPx;
  }

  function update(dt) {
    time += dt;

    /* Плавная смена времени суток */
    dayPhase = (dayPhase + dt / DAY_LENGTH) % 1;
    night = 1 - (1 - Math.cos(2 * Math.PI * dayPhase)) / 2;

    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li];
      lane.timer -= dt;

      if (lane.timer <= 0) {
        if (canSpawn(lane) && spawn(lane)) {
          lane.timer = rand(0.9, 2.6);
        } else {
          lane.timer = 0.35;
        }
      }
    }

    for (var i = cars.length - 1; i >= 0; i--) {
      var c = cars[i];

      /* Ближайшая машина впереди в той же полосе */
      var leader = null;
      for (var j = 0; j < cars.length; j++) {
        var o = cars[j];
        if (o === c || o.lane !== c.lane) continue;

        if (c.dir === 1) {
          if (o.x > c.x && (!leader || o.x < leader.x)) leader = o;
        } else {
          if (o.x < c.x && (!leader || o.x > leader.x)) leader = o;
        }
      }

      var target = c.vmax;

      if (leader) {
        var gap = c.dir === 1
          ? leader.x - (c.x + c.w)
          : c.x - (leader.x + leader.w);
        var desired = c.w * 0.45 + 34;

        if (gap < 24) {
          target = 0;
        } else if (gap < desired) {
          target = Math.max(leader.v * 0.35, leader.v * (gap / desired));
        }
      }

      c.v += (target - c.v) * Math.min(1, dt * 2.2);
      if (c.v < 0) c.v = 0;
      c.x += c.dir * c.v * speedMul * dt;

      if (c.bounce > 0) c.bounce = Math.max(0, c.bounce - dt);
      if (c.bubble > 0) c.bubble = Math.max(0, c.bubble - dt);

      var gone = c.dir === 1 ? c.x > W + 40 : c.x + c.w < -40;
      if (gone) cars.splice(i, 1);
    }
  }

  /* ============================================================
     Рисование
     ============================================================ */

  function mixColor(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function rgb(c) {
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  function makeClouds() {
    clouds = [];
    var count = Math.max(3, Math.round(W / 420));
    var base = Math.min(W, H) / 900;

    for (var i = 0; i < count; i++) {
      clouds.push({
        x: Math.random() * W,
        y: H * (0.04 + Math.random() * 0.2),
        s: Math.max(0.55, (0.7 + Math.random() * 0.7) * base),
        v: 3 + Math.random() * 6,
        a: 0.75 + Math.random() * 0.22
      });
    }
  }

  function makeBirds() {
    birds = [];

    if (reducedMotion) return;

    var count = W > 900 ? 4 : 3;
    var base = Math.max(0.55, Math.min(1.15, Math.min(W, H) / 900));

    for (var i = 0; i < count; i++) {
      birds.push({
        x: Math.random() * W,
        y: H * (0.05 + Math.random() * 0.22),
        s: base * (0.7 + Math.random() * 0.5),
        v: (Math.random() < 0.5 ? -1 : 1) * (13 + Math.random() * 17),
        phase: Math.random() * Math.PI * 2,
        flap: 5.5 + Math.random() * 3.5
      });
    }
  }

  function makeFlowers() {
    flowers = [];

    var count = Math.max(6, Math.round(W / 130));
    var palette = ["#ff8fb1", "#ffd166", "#f5f5ff", "#c79bff", "#ff9f68"];

    for (var i = 0; i < count; i++) {
      var r = rndAt(i + 1);
      var r2 = rndAt(i * 2.7 + 5);

      flowers.push({
        x: ((i + 0.5) / count) * W + (r - 0.5) * 46,
        s: 0.7 + r2 * 0.7,
        color: palette[(r2 * palette.length) | 0],
        phase: r * Math.PI * 2
      });
    }
  }

  function makeButterflies() {
    butterflies = [];

    if (reducedMotion) return;

    var count = 2;
    for (var i = 0; i < count; i++) {
      butterflies.push({
        x: W * (0.18 + i * 0.52 + rndAt(i + 11) * 0.18),
        y: G.roadBottom + (H - G.roadBottom) * 0.45,
        phase: rndAt(i + 3) * Math.PI * 2,
        ax: 26 + rndAt(i + 7) * 34,
        ay: 6 + rndAt(i + 9) * 10,
        color: i ? "#ffd166" : "#ff9ec4"
      });
    }
  }

  function makeSnowfall() {
    snowflakes = [];

    var count = Math.max(36, Math.min(150, Math.round(W * H / 16000)));

    for (var i = 0; i < count; i++) {
      snowflakes.push({
        x: Math.random() * W,
        y: Math.random() * (H + 20),
        r: 1 + Math.random() * 2.2,
        v: 12 + Math.random() * 28,
        drift: 8 + Math.random() * 18,
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  function drawCloud(x, y, s, alpha) {
    /* Мягкая голубая тень снизу */
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = "#bfdcf0";
    ctx.beginPath();
    ctx.arc(x + 2 * s, y + 8 * s, 26 * s, 0, Math.PI * 2);
    ctx.arc(x + 32 * s, y - 3 * s, 31 * s, 0, Math.PI * 2);
    ctx.arc(x + 66 * s, y + 7 * s, 23 * s, 0, Math.PI * 2);
    ctx.arc(x + 36 * s, y + 21 * s, 25 * s, 0, Math.PI * 2);
    ctx.fill();

    /* Само облако */
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, 26 * s, 0, Math.PI * 2);
    ctx.arc(x + 30 * s, y - 12 * s, 32 * s, 0, Math.PI * 2);
    ctx.arc(x + 66 * s, y - 2 * s, 24 * s, 0, Math.PI * 2);
    ctx.arc(x + 34 * s, y + 12 * s, 26 * s, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  function drawStars(t, n) {
    if (n < 0.03) return;

    var count = Math.max(14, Math.round(W / 55));
    var top = G.horizon * 0.9;

    ctx.save();
    for (var i = 0; i < count; i++) {
      var x = rndAt(i + 101) * W;
      var y = rndAt(i + 207) * top;
      var big = rndAt(i + 311) > 0.78;
      var size = big
        ? 2.2 + rndAt(i + 401) * 1.6
        : 1.2 + rndAt(i + 401) * 0.8;

      var tw = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 1.7);
      var alpha = n * (0.3 + 0.7 * tw);
      if (big) alpha = Math.min(1, alpha * 1.2);

      ctx.globalAlpha = alpha;

      if (big) {
        ctx.shadowColor = "rgba(210, 228, 255, 0.9)";
        ctx.shadowBlur = 10;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSky(t) {
    var n = night;

    var top = mixColor([111, 196, 239], [8, 13, 42], n);
    var mid = mixColor([191, 232, 251], [22, 34, 76], n);
    var bot = mixColor([234, 247, 255], [40, 54, 96], n);

    var sky = ctx.createLinearGradient(0, 0, 0, G.horizon + 40);
    sky.addColorStop(0, rgb(top));
    sky.addColorStop(0.6, rgb(mid));
    sky.addColorStop(1, rgb(bot));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, G.horizon + 40);

    drawStars(t, n);

    /* Солнце — движется по дуге и заходит за горизонт */
    var sunTop = Math.min(H * 0.13, G.horizon * 0.55);
    var sunR = Math.max(18, Math.min(W, H) * 0.045);
    var pulse = reducedMotion ? 0 : Math.sin(t * 0.9) * 0.06;

    var e = -Math.cos(2 * Math.PI * dayPhase);   /* 1=полдень, 0=горизонт, -1=полночь */
    var sunX = W * (0.12 + 0.76 * Math.max(0, Math.min(1, (dayPhase - 0.25) / 0.5)));
    var sunY = G.horizon - e * (G.horizon - sunTop);
    var sunA = Math.max(0, Math.min(1, 1 + e * 5));   /* видно до горизонта, гаснет за ним */

    if (sunA > 0.02) {
      ctx.save();
      ctx.globalAlpha = sunA;

      var glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 3);
      glow.addColorStop(0, "rgba(255, 236, 150, 0.85)");
      glow.addColorStop(1, "rgba(255, 236, 150, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR * 3 * (1 + pulse), 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ffe58a";
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    /* Луна — ночью */
    if (n > 0.02) {
      var moonX = W * 0.16;
      var moonY = Math.min(H * 0.13, G.horizon * 0.55);
      var moonR = sunR * 0.72;

      ctx.save();
      ctx.globalAlpha = n;

      var mglow = ctx.createRadialGradient(moonX, moonY, moonR * 0.4, moonX, moonY, moonR * 2.6);
      mglow.addColorStop(0, "rgba(220, 230, 255, 0.5)");
      mglow.addColorStop(1, "rgba(220, 230, 255, 0)");
      ctx.fillStyle = mglow;
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR * 2.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#eaf0ff";
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
      ctx.fill();

      /* Лёгкая тень-кратер */
      ctx.fillStyle = "rgba(180, 196, 235, 0.5)";
      ctx.beginPath();
      ctx.arc(moonX - moonR * 0.3, moonY - moonR * 0.2, moonR * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(moonX + moonR * 0.28, moonY + moonR * 0.3, moonR * 0.16, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    /* Облака — ночью приглушены */
    ctx.save();
    var cloudDim = 1 - n * 0.65;
    for (var i = 0; i < clouds.length; i++) {
      var cl = clouds[i];
      var drift = reducedMotion ? 0 : t * cl.v;
      var x = ((cl.x + drift) % (W + 200)) - 100;
      drawCloud(x, cl.y, cl.s, cl.a * cloudDim);
    }
    ctx.restore();

    drawBirds(t);
  }

  function drawBirds(t) {
    if (!birds.length) return;

    ctx.save();
    ctx.strokeStyle = "rgba(58, 78, 98, " + (0.72 * (1 - night)) + ")";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";

    var span = W + 160;

    for (var i = 0; i < birds.length; i++) {
      var b = birds[i];
      var x = b.x + b.v * t;
      x = ((x + 80) % span + span) % span - 80;

      var lift = Math.sin(t * b.flap + b.phase) * 5.5 * b.s;

      ctx.beginPath();
      ctx.moveTo(x - 10 * b.s, b.y - lift * 0.25);
      ctx.quadraticCurveTo(x - 4 * b.s, b.y - 4 * b.s - lift, x, b.y);
      ctx.quadraticCurveTo(x + 4 * b.s, b.y - 4 * b.s - lift, x + 10 * b.s, b.y - lift * 0.25);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawHills() {
    var y = G.horizon;

    /* Заснеженные холмы */
    ctx.fillStyle = "#eef6ff";
    ctx.beginPath();
    ctx.moveTo(0, y + 26);
    ctx.quadraticCurveTo(W * 0.16, y - 34, W * 0.36, y + 6);
    ctx.quadraticCurveTo(W * 0.54, y + 38, W * 0.72, y - 4);
    ctx.quadraticCurveTo(W * 0.88, y - 36, W, y + 10);
    ctx.lineTo(W, G.roadTop);
    ctx.lineTo(0, G.roadTop);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#d9e8f8";
    ctx.beginPath();
    ctx.moveTo(0, y + 52);
    ctx.quadraticCurveTo(W * 0.22, y + 16, W * 0.44, y + 44);
    ctx.quadraticCurveTo(W * 0.66, y + 70, W * 0.86, y + 30);
    ctx.quadraticCurveTo(W * 0.95, y + 14, W, y + 34);
    ctx.lineTo(W, G.roadTop);
    ctx.lineTo(0, G.roadTop);
    ctx.closePath();
    ctx.fill();
  }

  function drawCurb() {
    var y = G.roadTop;

    /* Снежный бордюр у дороги */
    ctx.fillStyle = "#f4f9ff";
    ctx.fillRect(0, y - 7, W, 7);
    ctx.fillStyle = "#b9c9da";
    ctx.fillRect(0, y - 1, W, 1.5);
  }

  function drawFir(x, baseY, s, sway) {
    /* Ствол */
    ctx.fillStyle = "#6b4a2f";
    ctx.fillRect(x - 2.4 * s, baseY - 16 * s, 4.8 * s, 16 * s);

    var tiers = 4;

    for (var i = 0; i < tiers; i++) {
      var frac = i / (tiers - 1);
      var yBottom = baseY - 10 * s - frac * 42 * s;
      var w = (30 - frac * 19) * s;
      var h = (26 - frac * 8) * s;
      var tipX = x + sway * (0.5 + frac * 0.5);
      var tipY = yBottom - h;

      ctx.fillStyle = i % 2 ? "#2f7d52" : "#256b45";
      ctx.beginPath();
      ctx.moveTo(x - w / 2, yBottom);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(x + w / 2, yBottom);
      ctx.closePath();
      ctx.fill();

      /* Снег на ветках */
      ctx.fillStyle = "rgba(248, 252, 255, 0.95)";
      ctx.beginPath();
      ctx.moveTo(x - w * 0.26, yBottom - h * 0.42);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(x + w * 0.26, yBottom - h * 0.42);
      ctx.closePath();
      ctx.fill();
    }

    /* Снежный сугроб у основания */
    ctx.fillStyle = "rgba(245, 250, 255, 0.95)";
    ctx.beginPath();
    ctx.ellipse(x, baseY + 1, 15 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function addFirLights(x, baseY, s, sway, seed) {
    var palette = ["#ff5a5a", "#ffd166", "#6ec6ff", "#9dff7a", "#ffb3e6", "#fff3b0"];
    var tiers = 4;

    for (var i = 0; i < tiers; i++) {
      var frac = i / (tiers - 1);
      var yBottom = baseY - 10 * s - frac * 42 * s;
      var w = (30 - frac * 19) * s;
      var h = (26 - frac * 8) * s;
      var n = i === 0 ? 3 : 2;

      for (var k = 0; k < n; k++) {
        var f = 0.22 + (k / Math.max(1, n - 1)) * 0.58;
        var halfW = (w / 2) * (1 - f);
        var side = k % 2 === 0 ? -1 : 1;
        var r = rndAt(seed * 13 + i * 7 + k * 3 + 50);

        firLights.push({
          x: x + side * halfW * 0.62 + sway * f,
          y: yBottom - f * h,
          color: palette[(r * palette.length) | 0],
          phase: r * Math.PI * 2,
          size: (1.4 + r * 1.1) * Math.max(0.7, s)
        });
      }
    }
  }

  function drawTrees(t) {
    var unit = Math.max(0.6, Math.min(1.5, H / 820));
    var count = Math.max(6, Math.round(W / 190));
    var baseY = G.roadTop - 2;

    firLights.length = 0;

    for (var i = 0; i < count; i++) {
      var rnd = rndAt(i + 1);
      var x = ((i + 0.5) / count) * W + (rnd - 0.5) * 60;
      var s = (0.7 + rnd * 0.6) * unit;
      var sway = reducedMotion ? 0 : Math.sin(t * 0.9 + i * 1.7) * 1.6 * s;

      drawFir(x, baseY, s, sway);
      addFirLights(x, baseY, s, sway, i);
    }
  }

  function drawFlowers(t) {
    var baseY = G.roadTop - 3;

    ctx.save();
    ctx.lineCap = "round";

    for (var i = 0; i < flowers.length; i++) {
      var f = flowers[i];
      var sway = reducedMotion ? 0 : Math.sin(t * 1.6 + f.phase) * 1.8 * f.s;
      var topY = baseY - 15 * f.s;
      var topX = f.x + sway;

      ctx.strokeStyle = "rgba(76, 150, 74, 0.9)";
      ctx.lineWidth = Math.max(1, 1.6 * f.s);
      ctx.beginPath();
      ctx.moveTo(f.x, baseY);
      ctx.quadraticCurveTo(f.x + sway * 0.4, baseY - 8 * f.s, topX, topY);
      ctx.stroke();

      ctx.fillStyle = f.color;
      for (var p = 0; p < 5; p++) {
        var a = (p / 5) * Math.PI * 2 + f.phase;
        ctx.beginPath();
        ctx.arc(topX + Math.cos(a) * 2.6 * f.s, topY + Math.sin(a) * 2.6 * f.s, 1.9 * f.s, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = "#ffd45e";
      ctx.beginPath();
      ctx.arc(topX, topY, 1.5 * f.s, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawRoad() {
    var top = G.roadTop;
    var bot = G.roadBottom;
    var h = bot - top;

    var asphalt = ctx.createLinearGradient(0, top, 0, bot);
    asphalt.addColorStop(0, "#4b515a");
    asphalt.addColorStop(0.45, "#3d434b");
    asphalt.addColorStop(1, "#343a42");
    ctx.fillStyle = asphalt;
    ctx.fillRect(0, top, W, h);

    /* Следы шин */
    ctx.fillStyle = "rgba(0, 0, 0, 0.055)";
    var tracks = [0.16, 0.38, 0.62, 0.84];
    for (var i = 0; i < tracks.length; i++) {
      ctx.fillRect(0, top + h * tracks[i], W, h * 0.045);
    }

    /* Крайние линии */
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillRect(0, top + 7, W, 3);
    ctx.fillRect(0, bot - 12, W, 3);

    /* Прерывистая осевая — неподвижная */
    var dash = Math.max(26, h * 0.1);
    var gap = dash * 0.85;

    ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
    for (var x = 0; x < W; x += dash + gap) {
      ctx.fillRect(x, G.centerY - 2, dash, 4);
    }
  }

  function drawForeground() {
    var y = G.roadBottom;
    var snow = ctx.createLinearGradient(0, y, 0, H);
    snow.addColorStop(0, "#f3f9ff");
    snow.addColorStop(1, "#dce8f6");
    ctx.fillStyle = snow;
    ctx.fillRect(0, y, W, H - y);

    /* Снежные сугробы у нижнего края */
    ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
    for (var i = 0; i < 12; i++) {
      var r = rndAt(i + 30);
      var mx = ((i + 0.5) / 12) * W + (r - 0.5) * 40;
      ctx.beginPath();
      ctx.ellipse(mx, H - 1, 18 + r * 18, 5 + r * 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#f8fcff";
    ctx.fillRect(0, y - 6, W, 6);
    ctx.fillStyle = "rgba(150, 170, 195, 0.35)";
    ctx.fillRect(0, y - 6, W, 1.5);
  }

  function drawGrass(t) {
    var band = H - G.roadBottom;
    var count = Math.max(20, Math.round(W / 38));
    var maxH = Math.max(10, band * 0.9);

    ctx.save();
    ctx.lineCap = "round";

    for (var i = 0; i < count; i++) {
      var r = rndAt(i * 1.7 + 2);
      var x = ((i + 0.5) / count) * W + (r - 0.5) * 34;
      var hgt = maxH * (0.5 + rndAt(i * 3.1 + 4) * 0.7);
      var sway = reducedMotion ? 0 : Math.sin(t * 1.9 + i * 0.8) * 2.6;

      ctx.strokeStyle = i % 3 === 0
        ? "rgba(126, 198, 96, 0.9)"
        : "rgba(66, 140, 62, 0.75)";
      ctx.lineWidth = i % 2 ? 1.6 : 2.2;
      ctx.beginPath();
      ctx.moveTo(x, H + 1);
      ctx.quadraticCurveTo(x + sway * 0.4, H - hgt * 0.55, x + sway, H - hgt);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawButterflies(t) {
    if (!butterflies.length) return;

    ctx.save();

    for (var i = 0; i < butterflies.length; i++) {
      var b = butterflies[i];
      var x = b.x + Math.sin(t * 0.7 + b.phase) * b.ax;
      var y = b.y + Math.sin(t * 1.4 + b.phase * 1.7) * b.ay;
      var flap = 0.35 + Math.abs(Math.sin(t * 7 + b.phase)) * 0.65;

      ctx.save();
      ctx.translate(x, y);

      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.ellipse(-3.4, -1, 3.6, 2.6 * flap, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(3.4, -1, 3.6, 2.6 * flap, 0.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(80, 60, 40, 0.8)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.9, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    ctx.restore();
  }

  /* Свечение фар — только ночью, спереди машины (на носу). */
  function drawHeadlights(c) {
    var n = night;
    if (n <= 0.02) return;

    var baseline = c.box.y + c.h;
    var frontX = c.dir === 1 ? c.x + c.w - 2 : c.x + 2;
    var hy = baseline - c.h * 0.38;
    var r = Math.max(8, c.h * 0.16);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    var glow = ctx.createRadialGradient(frontX, hy, 1, frontX, hy, r * 2.2);
    glow.addColorStop(0, "rgba(255, 238, 175, " + (0.85 * n) + ")");
    glow.addColorStop(0.4, "rgba(255, 228, 145, " + (0.3 * n) + ")");
    glow.addColorStop(1, "rgba(255, 228, 145, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(frontX, hy, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawAllHeadlights() {
    if (night <= 0.02) return;

    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li];
      for (var i = 0; i < cars.length; i++) {
        if (cars[i].lane === lane) drawHeadlights(cars[i]);
      }
    }
  }

  /* Ночное затемнение земли (дороги, холмов, машин) */
  function drawNightOverlay() {
    var a = night * 0.55;
    if (a <= 0.01) return;

    /* Плавное начало выше вершин холмов — без видимой полосы */
    var top = Math.round(G.horizon - 52);
    var solid = Math.round(G.horizon - 20);
    var gradEnd = solid + 2;

    ctx.save();

    var grad = ctx.createLinearGradient(0, top, 0, solid);
    grad.addColorStop(0, "rgba(7, 12, 32, 0)");
    grad.addColorStop(1, "rgba(7, 12, 32, " + a + ")");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top, W, gradEnd - top);

    ctx.fillStyle = "rgba(7, 12, 32, " + a + ")";
    ctx.fillRect(0, gradEnd, W, H - gradEnd);

    ctx.restore();
  }

  /* Огоньки на ёлках — зажигаются ночью */
  function drawFirLights(t) {
    if (night <= 0.05 || !firLights.length) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (var i = 0; i < firLights.length; i++) {
      var l = firLights[i];
      var tw = 0.6 + 0.4 * Math.sin(t * 3 + l.phase);

      ctx.globalAlpha = night * tw;
      ctx.shadowColor = l.color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.arc(l.x, l.y, l.size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /* Снегопад */
  function drawSnowfall(t) {
    if (!snowflakes.length) return;

    ctx.save();
    ctx.fillStyle = "#ffffff";

    for (var i = 0; i < snowflakes.length; i++) {
      var f = snowflakes[i];
      var y = reducedMotion ? f.y : (f.y + t * f.v) % (H + 20) - 10;
      var x = reducedMotion ? f.x : f.x + Math.sin(t * 0.6 + f.phase) * f.drift;

      ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t * 1.5 + f.phase);
      ctx.beginPath();
      ctx.arc(x, y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawCar(c, t) {
    var bob = reducedMotion ? 0 : Math.sin(t * 5.5 + c.phase) * c.h * 0.012;
    var jump = 0;

    if (c.bounce > 0) {
      jump = -Math.sin((1 - c.bounce / 0.55) * Math.PI) * c.h * 0.16;
    }

    var baseline = c.lane.y + bob + jump;

    c.box = {
      x: c.x,
      y: baseline - c.h,
      w: c.w,
      h: c.h
    };

    /* Тень на асфальте */
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(c.x + c.w / 2, c.lane.y + 3, c.w * 0.45, Math.max(3, c.h * 0.06), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    if (night > 0.02) {
      ctx.filter = "brightness(" + (1 - night * 0.18).toFixed(3) + ")";
    }
    ctx.translate(c.x + c.w / 2, baseline);
    if (c.flip) ctx.scale(-1, 1);
    ctx.drawImage(c.img, -c.w / 2, -c.h, c.w, c.h);
    ctx.restore();

    if (c.bubble > 0) drawBubble(c, baseline);
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBubble(c, baseline) {
    var life = 0.9;
    var p = 1 - c.bubble / life;
    var alpha = Math.min(1, c.bubble * 4);
    var cy = baseline - c.h - 14 - p * 18;

    ctx.save();
    ctx.globalAlpha = alpha;

    var fontSize = Math.max(12, Math.round(c.h * 0.17));
    ctx.font = "700 " + fontSize + "px system-ui, -apple-system, sans-serif";

    var text = "Бип!";
    var tw = ctx.measureText(text).width;
    var padX = Math.max(8, fontSize * 0.55);
    var bw = tw + padX * 2;
    var bh = fontSize * 1.9;
    var bx = c.x + c.w / 2 - bw / 2;
    var by = cy - bh;

    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(30, 45, 60, 0.18)";
    ctx.lineWidth = 2;
    roundRect(bx, by, bw, bh, bh / 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(c.x + c.w / 2 - 6, by + bh - 1);
    ctx.lineTo(c.x + c.w / 2, by + bh + 8);
    ctx.lineTo(c.x + c.w / 2 + 6, by + bh - 1);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#1f2937";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, c.x + c.w / 2, by + bh / 2 + 1);

    ctx.restore();
  }

  function draw() {
    var t = time;

    drawSky(t);
    drawHills();
    drawCurb();
    drawTrees(t);
    drawRoad();
    drawForeground();

    /* Затемняем землю ночью (но не машины) */
    drawNightOverlay();

    /* Огоньки на ёлках — поверх затемнённых деревьев */
    drawFirLights(t);

    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li];
      for (var i = 0; i < cars.length; i++) {
        if (cars[i].lane === lane) drawCar(cars[i], t);
      }
    }

    drawAllHeadlights();
    drawSnowfall(t);
  }

  /* ============================================================
     Звук
     ============================================================ */

  function ensureAudio() {
    if (audio) return audio;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audio = new AC();
    return audio;
  }

  function ensureMusic() {
    if (music) return music;

    music = new Audio(MUSIC_SRC);
    music.loop = true;
    music.preload = "auto";
    music.volume = 0;
    music.setAttribute("playsinline", "");

    music.addEventListener("error", function () {
      musicPlaying = false;
    });

    return music;
  }

  function fadeMusic(to, duration) {
    var el = ensureMusic();
    if (!el) return;

    clearInterval(musicFadeTimer);

    var from = el.volume;
    var start = Date.now();

    musicFadeTimer = setInterval(function () {
      var p = Math.min(1, (Date.now() - start) / duration);
      el.volume = Math.max(0, Math.min(1, from + (to - from) * p));

      if (p >= 1) {
        clearInterval(musicFadeTimer);
        musicFadeTimer = 0;
      }
    }, 40);
  }

  function startMusic() {
    if (muted || musicPlaying) return;

    var el = ensureMusic();
    if (!el) return;

    musicPlaying = true;
    clearTimeout(musicPauseTimer);

    var played = el.play();

    if (played && played.then) {
      played.then(function () {
        if (musicPlaying) fadeMusic(MUSIC_VOLUME, 1800);
      }).catch(function () {
        musicPlaying = false;
        el.volume = 0;
      });
    } else {
      fadeMusic(MUSIC_VOLUME, 1800);
    }
  }

  function stopMusic() {
    musicPlaying = false;

    if (!music) return;

    fadeMusic(0, 500);

    clearTimeout(musicPauseTimer);
    musicPauseTimer = setTimeout(function () {
      if (!musicPlaying && music) music.pause();
    }, 550);
  }

  function honk() {
    if (muted) return;

    var ac = ensureAudio();
    if (!ac) return;
    if (ac.state === "suspended") ac.resume();

    var t0 = ac.currentTime;
    var base = 360 + Math.random() * 70;
    var gain = ac.createGain();

    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.085, t0 + 0.015);
    gain.gain.setValueAtTime(0.085, t0 + 0.16);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.3);
    gain.connect(ac.destination);

    [1, 1.26].forEach(function (mult, idx) {
      var osc = ac.createOscillator();
      osc.type = idx ? "triangle" : "square";
      osc.frequency.setValueAtTime(base * mult, t0);
      osc.connect(gain);
      osc.start(t0);
      osc.stop(t0 + 0.32);
    });
  }

  /* ============================================================
     Ввод
     ============================================================ */

  function carAt(x, y) {
    /* Ближняя полоса перекрывает дальнюю — проверяем её первой */
    for (var li = lanes.length - 1; li >= 0; li--) {
      var lane = lanes[li];
      for (var i = cars.length - 1; i >= 0; i--) {
        var c = cars[i];
        if (c.lane !== lane || !c.box) continue;
        var b = c.box;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return c;
      }
    }
    return null;
  }

  canvas.addEventListener("pointerdown", function (e) {
    var rect = canvas.getBoundingClientRect();
    var car = carAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!car) return;

    car.bounce = 0.55;
    car.bubble = 0.9;
    honk();
  });

  /* ============================================================
     Управление
     ============================================================ */

  function startLoop() {
    if (raf) return;
    lastTs = 0;
    raf = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function frame(ts) {
    if (!running) {
      raf = 0;
      return;
    }

    if (!lastTs) lastTs = ts;
    var dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    update(dt);
    draw();

    raf = requestAnimationFrame(frame);
  }

  pauseBtn.addEventListener("click", function () {
    running = !running;

    if (running) {
      pauseBtn.textContent = "⏸";
      pauseBtn.setAttribute("aria-label", "Пауза");
      pauseBtn.title = "Пауза";
      startLoop();
    } else {
      pauseBtn.textContent = "▶";
      pauseBtn.setAttribute("aria-label", "Продолжить");
      pauseBtn.title = "Продолжить";
      stopLoop();
      draw();
    }
  });

  soundBtn.addEventListener("click", function () {
    muted = !muted;
    soundBtn.textContent = muted ? "🔇" : "🔊";
    soundBtn.setAttribute("aria-pressed", String(!muted));
    soundBtn.setAttribute("aria-label", muted ? "Включить звук" : "Выключить звук");

    if (muted) {
      stopMusic();
    } else {
      honk();
      startMusic();
    }
  });

  /* Браузер разрешает звук только после действия пользователя */
  function unlockAudio() {
    if (!muted) startMusic();
  }

  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.addEventListener("keydown", unlockAudio, { once: true });

  speedInput.addEventListener("input", function () {
    speedMul = parseFloat(speedInput.value) || 1;
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopLoop();
      if (musicPlaying) stopMusic();
    } else {
      if (running) startLoop();
      refreshLibrary();
      if (!muted) startMusic();
    }
  });

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  /* ============================================================
     Старт
     ============================================================ */

  resize();

  loadLibrary(true).then(function () {
    updateHint();

    /* Первые машины — сразу на дороге, чтобы сцена не была пустой */
    if (library.length) {
      var starts = [0.18, 0.62];
      for (var li = 0; li < lanes.length; li++) {
        for (var si = 0; si < starts.length; si++) {
          if (!spawn(lanes[li])) break;
          var car = cars[cars.length - 1];
          car.x = W * starts[si] - car.w / 2;
        }
      }
    }

    startLoop();

    setInterval(refreshLibrary, 30000);

    setTimeout(function () {
      hintEl.classList.add("is-hidden");
    }, 8000);
  });

  /* Отладочный доступ к состоянию сцены */
  window.__road = {
    get cars() { return cars; },
    get lanes() { return lanes; },
    get library() { return library; },
    get audioState() {
      return {
        context: audio ? audio.state : "none",
        music: musicPlaying,
        muted: muted,
        volume: music ? Math.round(music.volume * 1000) / 1000 : 0,
        paused: music ? music.paused : true,
        time: music ? Math.round(music.currentTime * 10) / 10 : 0
      };
    },
    get timeOfDay() {
      return {
        phase: Math.round(dayPhase * 1000) / 1000,
        day: Math.round((1 - night) * 1000) / 1000,
        night: Math.round(night * 1000) / 1000
      };
    },
    refresh: refreshLibrary,
    load: loadLibrary
  };
})();
