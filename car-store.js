(function (global) {
  "use strict";

  /* Локальные машины хранятся в IndexedDB: рисунков может быть много,
     и лимит localStorage в 5 МБ быстро заканчивается. */

  var DB_NAME = "road-cars";
  var DB_VERSION = 1;
  var STORE = "cars";

  var dbPromise = null;
  var unsupported = !global.indexedDB;

  function openDb() {
    if (unsupported) {
      return Promise.reject(new Error("IndexedDB недоступен в этом браузере"));
    }

    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };

      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = function () {
        reject(req.error || new Error("Не удалось открыть IndexedDB"));
      };
    });

    return dbPromise;
  }

  function withStore(mode, work) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var value;

        try {
          value = work(store);
        } catch (e) {
          reject(e);
          return;
        }

        tx.oncomplete = function () {
          resolve(value);
        };
        tx.onerror = function () {
          reject(tx.error || new Error("Ошибка IndexedDB"));
        };
        tx.onabort = function () {
          reject(tx.error || new Error("Операция IndexedDB отменена"));
        };
      });
    });
  }

  function getAll() {
    return withStore("readonly", function (store) {
      var out = [];
      var req = store.openCursor();

      req.onsuccess = function () {
        var cursor = req.result;
        if (!cursor) return;
        out.push(cursor.value);
        cursor.continue();
      };

      return out;
    }).catch(function () {
      return [];
    });
  }

  function put(record) {
    return withStore("readwrite", function (store) {
      store.put(record);
      return record;
    });
  }

  function putMany(records) {
    return withStore("readwrite", function (store) {
      records.forEach(function (record) {
        store.put(record);
      });
      return records;
    });
  }

  function remove(id) {
    return withStore("readwrite", function (store) {
      store.delete(id);
      return id;
    });
  }

  function clearAll() {
    return withStore("readwrite", function (store) {
      store.clear();
      return true;
    });
  }

  function makeId(seed) {
    return "local-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 7) + "-" + seed;
  }

  function cleanName(value, fallback) {
    var s = String(value || "").replace(/\s+/g, " ").trim();
    return (s || fallback || "Машина").slice(0, 40);
  }

  function imageOf(obj) {
    if (!obj) return "";
    var candidates = [
      obj.image,
      obj.dataUrl,
      obj.dataURL,
      obj.data,
      obj.imageData,
      obj.imageUrl,
      obj.src,
      obj.url,
      obj.file,
      obj.img,
      obj.base64,
      obj.content,
      obj.source,
      obj.result && obj.result.dataUrl,
      obj.result && obj.result.image
    ];

    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (typeof v === "string" && /^data:image\//i.test(v)) return v;
    }
    return "";
  }

  function normalize(value, key, index, fallbackName) {
    if (typeof value === "string") {
      if (!/^data:image\//i.test(value)) return null;
      return {
        id: makeId(index),
        name: fallbackName || "Машина",
        facing: "right",
        image: value,
        source: null,
        juice: 50,
        tolerance: 50,
        createdAt: Date.now(),
        legacy: true
      };
    }

    if (!value || typeof value !== "object") return null;

    var image = imageOf(value);
    if (!image) return null;

    var source = value.source || value.original || value.originalImage || "";

    return {
      id: value.id && /^(local|legacy)-/.test(String(value.id))
        ? String(value.id)
        : "legacy-" + String(key).replace(/[^a-z0-9_-]/gi, "").slice(0, 24) + "-" + index,
      name: cleanName(value.name || value.title || value.label, fallbackName),
      facing: value.facing === "left" ? "left" : "right",
      image: image,
      source: typeof source === "string" && /^data:image\//i.test(source) ? source : null,
      juice: typeof value.juice === "number" ? value.juice : 50,
      tolerance: typeof value.tolerance === "number" ? value.tolerance : 50,
      createdAt: value.createdAt || Date.now(),
      legacy: true
    };
  }

  function carsFromValue(value, key) {
    var list = null;

    if (Array.isArray(value)) {
      list = value;
    } else if (value && typeof value === "object") {
      var keys = ["cars", "items", "machines", "photos", "list"];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(value[keys[i]])) {
          list = value[keys[i]];
          break;
        }
      }

      /* Старое хранилище могло быть объектом-словарём: id → машина */
      if (!list) {
        var nested = [];
        Object.keys(value).forEach(function (k) {
          if (value[k] && typeof value[k] === "object" && imageOf(value[k])) {
            nested.push(value[k]);
          }
        });
        if (nested.length) list = nested;
      }

      if (!list) list = [value];
    }

    if (!list) return null;

    var out = [];
    for (var j = 0; j < list.length; j++) {
      var item = normalize(list[j], key, j, "Машина " + (j + 1));
      if (item) out.push(item);
    }

    return out.length ? out : null;
  }

  /* Переносит машины из старого localStorage. Ищем либо известные ключи,
     либо любой массив с картинками в формате data:image/… */
  function migrateFromLocalStorage() {
    var storage;

    try {
      storage = global.localStorage;
      if (!storage) return Promise.resolve(0);
    } catch (e) {
      return Promise.resolve(0);
    }

    var priorities = [
      "road-cars",
      "roadCars",
      "road-cars-v1",
      "roadCarsV1",
      "road-uploaded-cars",
      "uploadedCars",
      "uploaded-cars",
      "localCars",
      "local-cars",
      "cars"
    ];

    var keys = [];
    var i;

    try {
      for (i = 0; i < storage.length; i++) {
        var k = storage.key(i);
        if (k && priorities.indexOf(k) === -1) keys.push(k);
      }
    } catch (e) {
      return Promise.resolve(0);
    }

    priorities.forEach(function (k) {
      try {
        if (storage.getItem(k) !== null && keys.indexOf(k) === -1) keys.unshift(k);
      } catch (e) { /* ignore */ }
    });

    var migrated = [];
    var usedKeys = [];
    var seen = {};

    keys.forEach(function (key) {
      var raw;

      try {
        raw = storage.getItem(key);
      } catch (e) {
        return;
      }

      if (!raw) return;

      var trimmed = raw.trim();
      if (trimmed.charAt(0) !== "[" && trimmed.charAt(0) !== "{") return;

      var parsed;

      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        return;
      }

      var records = carsFromValue(parsed, key);
      if (!records) return;

      var useful = [];

      records.forEach(function (record) {
        var fingerprint = record.image.length + ":" + record.image.slice(0, 96);
        if (seen[fingerprint]) return;
        seen[fingerprint] = 1;
        useful.push(record);
      });

      if (!useful.length) return;

      migrated = migrated.concat(useful);
      usedKeys.push(key);
    });

    if (!migrated.length) return Promise.resolve(0);

    return getAll().then(function (existing) {
      var ids = {};
      existing.forEach(function (record) { ids[record.id] = 1; });

      var fresh = [];
      migrated.forEach(function (record) {
        while (ids[record.id]) {
          record.id = makeId("m");
        }
        ids[record.id] = 1;
        fresh.push(record);
      });

      return putMany(fresh).then(function () {
        usedKeys.forEach(function (key) {
          try {
            storage.removeItem(key);
          } catch (e) { /* ignore */ }
        });
        return fresh.length;
      });
    }).catch(function () {
      /* Если база недоступна или переполнена, старые данные не удаляем. */
      return 0;
    });
  }

  global.RoadDB = {
    init: openDb,
    getAll: getAll,
    put: put,
    putMany: putMany,
    remove: remove,
    clearAll: clearAll,
    migrateFromLocalStorage: migrateFromLocalStorage,
    isSupported: function () { return !unsupported; }
  };
})(window);
