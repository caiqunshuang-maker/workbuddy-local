/* ============================================================
 * localdb.js — 御前指挥部 手机本地版数据层
 * 用 localStorage(结构化数据) + IndexedDB(图片) 模拟全部后端 API
 * 前端通过覆盖 fetch 无缝接入，无需改业务代码
 * ============================================================ */

(function () {
  const LS_PREFIX = 'workbuddy_';

  // ---------- 表定义 ----------
  const TABLES = ['tasks', 'notes', 'schedules', 'workouts', 'body_metrics',
    'fitness_goals', 'workout_exercises', 'diaries', 'transactions',
    'storage_items', 'anniversaries'];

  // ---------- localStorage 读写 ----------
  function loadTable(name) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + name);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveTable(name, rows) {
    localStorage.setItem(LS_PREFIX + name, JSON.stringify(rows));
  }
  function nextId(name) {
    const rows = loadTable(name);
    return rows.length ? Math.max(...rows.map(r => r.id || 0)) + 1 : 1;
  }
  function nowIso() {
    return new Date().toISOString().replace('T', ' ').slice(0, 23);
  }

  // ---------- IndexedDB 图片存储 ----------
  let _imgDB = null;
  const IMG_CACHE = {}; // key -> dataURL
  function openDB() {
    return new Promise((resolve, reject) => {
      if (_imgDB) return resolve(_imgDB);
      const req = indexedDB.open('workbuddy_images', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { _imgDB = e.target.result; resolve(_imgDB); };
      req.onerror = (e) => reject(e);
    });
  }
  async function imgPut(key, dataURL) {
    const db = await openDB();
    IMG_CACHE[key] = dataURL;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put({ key, data: dataURL });
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  }
  async function imgGet(key) {
    if (IMG_CACHE[key]) return IMG_CACHE[key];
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readonly');
      const req = tx.objectStore('images').get(key);
      req.onsuccess = () => {
        if (req.result) { IMG_CACHE[key] = req.result.data; resolve(req.result.data); }
        else resolve(null);
      };
      req.onerror = reject;
    });
  }
  async function loadAllImagesToCache() {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').getAll();
        req.onsuccess = () => {
          (req.result || []).forEach(r => { IMG_CACHE[r.key] = r.data; });
          resolve();
        };
        req.onerror = reject;
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- 重复待办展开（与原后端一致） ----------
  function expandRepeatInMonth(t, year, month) {
    const r = t.repeat || 'none';
    if (r === 'none') return null;
    const base = t.due_date ? new Date(t.due_date + 'T00:00:00') : new Date();
    const lastDay = new Date(year, month, 0).getDate();
    const out = [];
    if (r === 'custom' && t.repeat_days) {
      const days = new Set(String(t.repeat_days).split(',').map(x => parseInt(x)).filter(x => !isNaN(x)));
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(year, month - 1, d);
        if (days.has(dt.getDay() === 0 ? 6 : dt.getDay() - 1)) out.push(dt);
      }
    } else if (r === 'weekly') {
      let d0 = new Date(base);
      while (d0 > new Date(year, month - 1, 1)) d0.setDate(d0.getDate() - 7);
      while (d0.getFullYear() === year && d0.getMonth() === month - 1 && d0.getDate() <= lastDay) {
        out.push(new Date(d0));
        d0.setDate(d0.getDate() + 7);
      }
    } else if (r === 'daily') {
      let d0 = new Date(base);
      if (d0 < new Date(year, month - 1, 1)) d0 = new Date(year, month - 1, 1);
      while (d0.getFullYear() === year && d0.getMonth() === month - 1 && d0.getDate() <= lastDay) {
        out.push(new Date(d0));
        d0.setDate(d0.getDate() + 1);
      }
    } else if (r === 'weekdays') {
      let d0 = new Date(base);
      if (d0 < new Date(year, month - 1, 1)) d0 = new Date(year, month - 1, 1);
      while (d0.getFullYear() === year && d0.getMonth() === month - 1 && d0.getDate() <= lastDay) {
        if (d0.getDay() >= 1 && d0.getDay() <= 5) out.push(new Date(d0));
        d0.setDate(d0.getDate() + 1);
      }
    }
    return out.map(d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  // ---------- 模拟 API 处理 ----------
  function handle(path, opts) {
    const method = (opts && opts.method) || 'GET';
    let body = null;
    if (opts && opts.body) {
      try { body = JSON.parse(opts.body); } catch (e) { body = {}; }
    }
    // 解析路径 /api/xxx/:id/yyy
    const parts = path.replace(/^\/api\//, '').split('?')[0].split('/');
    const qs = {};
    const qidx = path.indexOf('?');
    if (qidx >= 0) {
      new URLSearchParams(path.slice(qidx + 1)).forEach((v, k) => { qs[k] = v; });
    }
    const resource = parts[0];
    const id = parts[1] ? parseInt(parts[1]) : null;
    const sub = parts[2] || null;

    // ---- 特殊：stats / uploads ----
    if (resource === 'stats' && method === 'GET') return statsData();
    if (resource === 'upload') return handleUpload(opts && opts.body);

    if (method === 'GET' && resource === 'diaries' && parts[1] === 'date' && parts[2]) {
      return loadTable('diaries').find(d => d.date === parts[2]) || null;
    }
    if (method === 'GET' && resource === 'transactions' && parts[1] === 'stats') {
      return txnStats(parseInt(qs.year) || new Date().getFullYear(), parseInt(qs.month) || new Date().getMonth() + 1);
    }

    // 通用 CRUD
    const table = resource;
    if (!TABLES.includes(table)) return null;
    let rows = loadTable(table);

    if (method === 'GET') {
      if (id) {
        const found = rows.find(r => r.id === id);
        if (resource === 'workouts' && found) {
          found.exercises = loadTable('workout_exercises').filter(e => e.workout_id === id);
        }
        return found || null;
      }
      return filterRows(table, rows, qs);
    }

    if (method === 'POST') {
      const row = Object.assign({}, body, { id: nextId(table), created_at: nowIso() });
      if (!row.updated_at) row.updated_at = row.created_at;
      rows.push(row);
      saveTable(table, rows);
      return row;
    }

    if (method === 'PUT') {
      const idx = rows.findIndex(r => r.id === id);
      if (idx < 0) return null;
      const updated = Object.assign({}, rows[idx], body, { updated_at: nowIso() });
      // 重复待办完成滚动（与原后端一致）
      if (table === 'tasks' && body && 'completed' in body && body.completed && updated.repeat && updated.repeat !== 'none') {
        const next = nextRepeatDate(updated);
        if (next) { updated.due_date = next; updated.completed = false; updated.last_completed_at = nowIso(); }
      }
      rows[idx] = updated;
      saveTable(table, rows);
      return updated;
    }

    if (method === 'DELETE') {
      rows = rows.filter(r => r.id !== id);
      saveTable(table, rows);
      return { message: '已删除' };
    }
    return null;
  }

  function nextRepeatDate(t) {
    const base = t.due_date ? new Date(t.due_date + 'T00:00:00') : new Date();
    const r = t.repeat;
    const d = new Date(base);
    if (r === 'daily') d.setDate(d.getDate() + 1);
    else if (r === 'weekdays') {
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
    } else if (r === 'weekly') d.setDate(d.getDate() + 7);
    else if (r === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (r === 'custom' && t.repeat_days) {
      const days = new Set(String(t.repeat_days).split(',').map(x => parseInt(x)).filter(x => !isNaN(x)));
      for (let i = 0; i < 15; i++) {
        d.setDate(d.getDate() + 1);
        const wd = d.getDay() === 0 ? 6 : d.getDay() - 1;
        if (days.has(wd)) break;
      }
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function filterRows(table, rows, qs) {
    // tasks: status / year / month / category
    if (table === 'tasks') {
      let out = rows;
      if (qs.status === 'active') out = out.filter(t => !t.completed);
      if (qs.status === 'completed') out = out.filter(t => t.completed);
      if (qs.category && qs.category !== 'all') out = out.filter(t => t.category === qs.category);
      if (qs.year && qs.month) {
        const y = parseInt(qs.year), m = parseInt(qs.month);
        const result = [];
        out.forEach(t => {
          if (t.repeat && t.repeat !== 'none') {
            const occ = expandRepeatInMonth(t, y, m);
            if (occ) {
              const baseDate = t.due_date;
              occ.forEach(od => {
                const copy = Object.assign({}, t);
                copy.due_date = od;
                if (baseDate && od < baseDate) copy.completed = true;
                result.push(copy);
              });
              return;
            }
          }
          if (t.due_date && t.due_date.startsWith(`${qs.year}-${String(m).padStart(2, '0')}`)) result.push(t);
        });
        return result;
      }
      return out;
    }
    if (table === 'schedules' || table === 'workouts') {
      if (qs.year && qs.month) {
        return rows.filter(r => r.date && r.date.startsWith(`${qs.year}-${String(parseInt(qs.month)).padStart(2, '0')}`));
      }
      return rows;
    }
    if (table === 'body_metrics') {
      let out = rows.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      if (qs.limit) out = out.slice(0, parseInt(qs.limit));
      return out;
    }
    if (table === 'diaries') {
      if (qs.year && qs.month) {
        return rows.filter(d => d.date && d.date.startsWith(`${qs.year}-${String(parseInt(qs.month)).padStart(2, '0')}`));
      }
      return rows;
    }
    if (table === 'transactions') {
      if (qs.year && qs.month) {
        return rows.filter(t => t.date && t.date.startsWith(`${qs.year}-${String(parseInt(qs.month)).padStart(2, '0')}`));
      }
      return rows;
    }
    if (table === 'storage_items') {
      if (qs.category && qs.category !== 'all') return rows.filter(r => r.category === qs.category);
      return rows;
    }
    return rows;
  }

  function txnStats(year, month) {
    const rows = loadTable('transactions').filter(t => t.date && t.date.startsWith(`${year}-${String(month).padStart(2, '0')}`));
    let income = 0, expense = 0;
    const expense_by_cat = {}, income_by_cat = {}, daily = {};
    rows.forEach(t => {
      const d = t.date;
      if (!daily[d]) daily[d] = { income: 0, expense: 0 };
      if (t.txn_type === 'income') {
        income += t.amount; daily[d].income += t.amount;
        income_by_cat[t.category] = (income_by_cat[t.category] || 0) + t.amount;
      } else {
        expense += t.amount; daily[d].expense += t.amount;
        expense_by_cat[t.category] = (expense_by_cat[t.category] || 0) + t.amount;
      }
    });
    return {
      year, month,
      income: Math.round(income * 100) / 100,
      expense: Math.round(expense * 100) / 100,
      balance: Math.round((income - expense) * 100) / 100,
      count: rows.length,
      expense_by_cat, income_by_cat, daily,
    };
  }

  function statsData() {
    const tasks = loadTable('tasks');
    const notes = loadTable('notes');
    const workouts = loadTable('workouts');
    const metrics = loadTable('body_metrics');
    const goals = loadTable('fitness_goals');
    const txns = loadTable('transactions');
    const schedules = loadTable('schedules');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const month = now.getMonth() + 1, year = now.getFullYear();
    const monthTxns = txns.filter(t => t.date && t.date.startsWith(`${year}-${String(month).padStart(2, '0')}`));
    const income = monthTxns.filter(t => t.txn_type === 'income').reduce((s, t) => s + t.amount, 0);
    const expense = monthTxns.filter(t => t.txn_type !== 'income').reduce((s, t) => s + t.amount, 0);
    const todayWorkout = workouts.find(w => w.date === todayStr);
    const todaySchedules = schedules.filter(s => s.date === todayStr);
    const sortedMetrics = metrics.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return {
      total_tasks: tasks.length,
      pending_tasks: tasks.filter(t => !t.completed).length,
      today_tasks: tasks.filter(t => t.due_date === todayStr && !t.completed).length,
      overdue_tasks: tasks.filter(t => t.due_date && t.due_date < todayStr && !t.completed).length,
      notes_count: notes.length,
      workouts_this_week: workouts.filter(w => {
        const d = w.date ? new Date(w.date + 'T00:00:00') : null;
        return d && d >= weekStart;
      }).length,
      latest_weight: sortedMetrics.length ? sortedMetrics[0].weight : null,
      active_goals: goals.filter(g => !g.achieved).length,
      month_income: Math.round(income * 100) / 100,
      month_expense: Math.round(expense * 100) / 100,
      month_balance: Math.round((income - expense) * 100) / 100,
      today_schedules: todaySchedules.length,
      today_workout_type: todayWorkout ? todayWorkout.workout_type : null,
      has_today_workout: !!todayWorkout,
    };
  }

  // ---------- 图片上传（本地 base64 存储） ----------
  async function handleUpload(formBody) {
    try {
      // FormData 中取 file
      let file = null;
      if (formBody instanceof FormData) {
        file = formBody.get('file');
      } else if (formBody && formBody.fd instanceof FormData) {
        file = formBody.fd.get('file');
      }
      if (!file) return { error: '没有文件' };
      const buf = await file.arrayBuffer();
      const blob = new Blob([buf], { type: file.type || 'image/jpeg' });
      const dataURL = await blobToDataURL(blob);
      // 生成文件名
      const key = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg';
      await imgPut(key, dataURL);
      const thumb = key.replace('.jpg', '_thumb.jpg');
      await imgPut(thumb, dataURL); // 缩略图同图（本地无需额外压缩）
      return { url: '/uploads/' + key, thumb: '/uploads/' + thumb };
    } catch (e) {
      return { error: '图片处理失败: ' + e.message };
    }
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ---------- 图片 URL → dataURL（渲染用） ----------
  async function resolveImg(url) {
    if (!url || !url.startsWith('/uploads/')) return url;
    const key = url.replace('/uploads/', '');
    const d = await imgGet(key);
    return d || '';
  }
  // 同步版：从内存缓存取（预加载后可用）
  function resolveImgSync(url) {
    if (!url || !url.startsWith('/uploads/')) return url;
    const key = url.replace('/uploads/', '');
    return IMG_CACHE[key] || '';
  }

  // ---------- 覆盖 fetch ----------
  const _origFetch = window.fetch;
  window.fetch = function (path, opts) {
    if (typeof path === 'string' && path.startsWith('/api/')) {
      const data = handle(path, opts);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
      });
    }
    return _origFetch(path, opts);
  };

  // ---------- 首次启动导入 seed 数据 ----------
  async function seedIfNeeded() {
    try {
      if (localStorage.getItem(LS_PREFIX + '_seeded')) return;
      // 导入结构数据
      const resp = await fetch('seed_data.json');
      if (resp.ok) {
        const seed = await resp.json();
        for (const table of TABLES) {
          const rows = seed[table];
          if (Array.isArray(rows) && rows.length) {
            saveTable(table, rows);
          }
        }
      }
      // 导入缩略图到 IndexedDB
      if (window.SEED_IMAGES) {
        for (const key of Object.keys(window.SEED_IMAGES)) {
          await imgPut(key, 'data:image/jpeg;base64,' + window.SEED_IMAGES[key]);
        }
      }
      localStorage.setItem(LS_PREFIX + '_seeded', '1');
      console.log('[localdb] 已导入初始数据');
    } catch (e) {
      console.warn('[localdb] seed 导入跳过:', e.message);
    }
  }

  // ---------- 一键备份 / 恢复 ----------
  async function exportBackupData() {
    const payload = {
      version: 1,
      exported_at: nowIso(),
      tables: {},
      images: {},
    };
    TABLES.forEach(t => { payload.tables[t] = loadTable(t); });
    // 从 IndexedDB 导出图片（dataURL）
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').getAll();
        req.onsuccess = () => {
          (req.result || []).forEach(r => { payload.images[r.key] = r.data; });
          resolve();
        };
        req.onerror = reject;
      });
    } catch (e) { /* 无图片可忽略 */ }
    return payload;
  }

  async function importBackupData(payload) {
    if (!payload || !payload.tables) throw new Error('备份文件格式不正确');
    TABLES.forEach(t => {
      if (Array.isArray(payload.tables[t])) saveTable(t, payload.tables[t]);
    });
    if (payload.images && typeof payload.images === 'object') {
      for (const key of Object.keys(payload.images)) {
        await imgPut(key, payload.images[key]);
      }
      // 刷新内存缓存
      Object.keys(IMG_CACHE).forEach(k => delete IMG_CACHE[k]);
      await loadAllImagesToCache();
    }
    localStorage.setItem(LS_PREFIX + '_seeded', '1');
  }

  // ---------- 导出 ----------
  window.LocalDB = {
    resolveImg, resolveImgSync, loadAllImagesToCache, imgPut, imgGet,
    handle, loadTable, saveTable, expandRepeatInMonth, seedIfNeeded,
    exportBackupData, importBackupData,
  };

  // 启动时：先导入 seed，再预加载图片
  function boot() {
    seedIfNeeded().then(() => loadAllImagesToCache());
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
