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
    'storage_items', 'anniversaries', 'habits', 'habit_logs', 'task_logs'];

  // ---------- localStorage 读写 ----------
  function loadTable(name) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + name);
      if (!raw) return [];
      const rows = JSON.parse(raw);
      // 日记图片归一化：兼容字符串(JSON)或数组；引用统一指向缩略图
      if (name === 'diaries' && Array.isArray(rows)) {
        rows.forEach(d => {
          if (typeof d.images === 'string') {
            try { d.images = JSON.parse(d.images); } catch (e) { d.images = []; }
          }
          if (!Array.isArray(d.images)) d.images = [];
          d.images = d.images.map(u => {
            if (u && typeof u === 'object') u = u.url || '';
            if (typeof u !== 'string') return u;
            // 统一指向缩略图名：原图 xxx.jpg → xxx_thumb.jpg；
            // 历史数据可能被反复归一化叠加成 _thumb_thumb_thumb.jpg，这里合并去重，避免引用无限膨胀后失效
            let s = u.replace(/\.(jpg|jpeg|png|webp)$/i, '_thumb.jpg');
            return s.replace(/(_thumb)+\.jpg$/i, '_thumb.jpg');
          });
        });
      }
      return rows;
    } catch (e) {
      // 数据损坏：先备份原始字符串（存到 _corrupt 键），避免后续保存用 [] 覆盖造成永久丢失
      try {
        const raw = localStorage.getItem(LS_PREFIX + name);
        if (raw) localStorage.setItem(LS_PREFIX + name + '_corrupt', raw);
      } catch (e2) { /* ignore */ }
      return [];
    }
  }
  function saveTable(name, rows) {
    try {
      localStorage.setItem(LS_PREFIX + name, JSON.stringify(rows));
    } catch (e) {
      // 配额超限等异常：提示用户备份，避免静默丢失
      if (e && e.name === 'QuotaExceededError') {
        try { alert('⚠️ 手机存储空间不足，保存失败！请点「💾 一键备份」保存数据后，清理浏览器缓存再试。'); } catch (e2) {}
      } else {
        try { alert('⚠️ 保存失败：' + (e && e.message ? e.message : '未知错误')); } catch (e2) {}
      }
    }
  }
  function nextId(name) {
    const rows = loadTable(name);
    return rows.length ? Math.max(...rows.map(r => r.id || 0)) + 1 : 1;
  }
  function nowIso() {
    // 用本地时间生成 "YYYY-MM-DD HH:MM:SS.mmm"，避免 UTC 与北京时间差 8 小时
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
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
    // 展开基准 = repeat_start（重复任务的起点）。不能直接用 due_date，
    // 因为完成后 due_date 会滚动到未来，导致历史月份（如1月）被"早退"逻辑吞掉。
    const startStr = t.repeat_start || t.due_date;
    const base = startStr ? new Date(startStr + 'T00:00:00') : new Date();
    const lastDay = new Date(year, month, 0).getDate();
    const out = [];
    // 目标月早于起始月：不产生任何记录（避免"幽灵已完成项"）
    const baseYear = base.getFullYear(), baseMonth = base.getMonth() + 1;
    if (year < baseYear || (year === baseYear && month < baseMonth)) return out;
    // 统一从目标月正向枚举，并用 dt >= base 过滤掉起始点之前的"幽灵日期"
    if (r === 'custom' && t.repeat_days) {
      const days = new Set(String(t.repeat_days).split(',').map(x => parseInt(x)).filter(x => !isNaN(x)));
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(year, month - 1, d);
        if (dt >= base && days.has(dt.getDay() === 0 ? 6 : dt.getDay() - 1)) out.push(dt);
      }
    } else if (r === 'weekly') {
      // 目标月内与 base 同星期几的所有日期（从月初正向枚举）
      const baseDow = base.getDay();
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(year, month - 1, d);
        if (dt >= base && dt.getDay() === baseDow) out.push(dt);
      }
    } else if (r === 'monthly') {
      // 每月：目标月内与 base 同日（月末 clamp）
      const baseDay = base.getDate();
      const day = Math.min(baseDay, lastDay);
      out.push(new Date(year, month - 1, day));
    } else if (r === 'daily') {
      // 每天：目标月内从起始点起的所有日期（修复：旧逻辑只认锚定月，后续月份全部消失）
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(year, month - 1, d);
        if (dt >= base) out.push(dt);
      }
    } else if (r === 'weekdays') {
      // 工作日：目标月内从起始点起的所有周一到周五
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(year, month - 1, d);
        if (dt >= base && dt.getDay() >= 1 && dt.getDay() <= 5) out.push(dt);
      }
    }
    return out.map(d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  // ---------- 训练动作文本解析（与原后端 parse_exercise_line 一致） ----------
  // "卧推 50kg 3x10" / "阿诺德推肩12*2.5kg" / "跑步 30min" / "游泳 1km" / "前束3轮"
  function parseExerciseLine(text) {
    text = String(text || '').trim();
    if (!text) return null;
    const result = { name: '', sets: 0, reps: 0, weight: 0.0, weight_unit: 'kg', duration: 0, distance: 0.0, notes: '', sort_order: 0 };

    // 名称：第一个数字前是动作名
    const numMatch = text.search(/\d/);
    let namePart, paramPart;
    if (numMatch >= 0) {
      namePart = text.slice(0, numMatch).trim();
      paramPart = text.slice(numMatch);
    } else {
      namePart = text.trim();
      paramPart = '';
    }
    result.name = namePart.replace(/[\s,，、。.·\-—:：()（）\[\]【】]+$/g, '').trim() || '未知动作';
    if (!paramPart) return result;

    // 次数×重量 "12*2.5kg" "20x7.5kg"
    let m = paramPart.match(/(\d+)\s*[xX×*]\s*(\d+\.?\d*)\s*(kg|公斤|斤|磅|lb|KG|LB)/);
    if (m) {
      result.reps = parseInt(m[1]);
      let w = parseFloat(m[2]);
      const unit = m[3].toLowerCase();
      if (unit === '斤') w = w / 2;
      else if (unit === '磅' || unit === 'lb') w = w * 0.4536;
      result.weight = Math.round(w * 100) / 100;
      result.weight_unit = (unit === '斤' || unit === '磅' || unit === 'lb') ? 'kg' : m[3];
      paramPart = paramPart.replace(m[0], '');
    }

    // 组×次 "3x10" "5组5次" "4*8"
    if (!result.reps) {
      m = paramPart.match(/(\d+)\s*[xX×*组]\s*(\d+)\s*(?:次|个|下)?/);
      if (m) {
        result.sets = parseInt(m[1]);
        result.reps = parseInt(m[2]);
        paramPart = paramPart.replace(m[0], '');
      }
    }

    // 孤立重量 "50kg" "20公斤"（组次之后残留的重量数字）
    if (!result.weight) {
      m = paramPart.match(/(\d+\.?\d*)\s*(kg|公斤|斤|磅|lb|KG|LB)/);
      if (m) {
        let w = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        if (unit === '斤') w = w / 2;
        else if (unit === '磅' || unit === 'lb') w = w * 0.4536;
        result.weight = Math.round(w * 100) / 100;
        result.weight_unit = (unit === '斤' || unit === '磅' || unit === 'lb') ? 'kg' : m[2];
        paramPart = paramPart.replace(m[0], '');
      }
    }

    // 仅组数 "3轮" "4组"
    if (!result.sets) {
      m = paramPart.match(/(\d+)\s*(?:轮|组|R|r|set|sets)/);
      if (m) { result.sets = parseInt(m[1]); paramPart = paramPart.replace(m[0], ''); }
    }

    // 时长 "30min" "1小时"
    m = paramPart.match(/(\d+\.?\d*)\s*(min|分钟|小时|h)/i);
    if (m) {
      let dur = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      if (unit === '小时' || unit === 'h') dur *= 60;
      result.duration = Math.round(dur);
      paramPart = paramPart.replace(m[0], '');
    }

    // 距离 "1km" "500m"
    m = paramPart.match(/(\d+\.?\d*)\s*(?:km|公里|m|米)/i);
    if (m) {
      let dist = parseFloat(m[1]);
      if (m[2] === 'm' || m[2] === '米') dist = dist / 1000;
      result.distance = Math.round(dist * 1000) / 1000;
      paramPart = paramPart.replace(m[0], '');
    }

    // 次数 "500个" "20下"
    if (!result.reps) {
      m = paramPart.match(/(\d+)\s*(?:个|下|次)/);
      if (m) { result.reps = parseInt(m[1]); paramPart = paramPart.replace(m[0], ''); }
    }

    // 剩余文本作为备注
    result.notes = paramPart.trim();
    return result;
  }

  function parseExercisesText(text) {
    return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
      const p = parseExerciseLine(line) || {};
      p.sort_order = i;
      return p;
    });
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

    // 通用 CRUD：URL 资源名(连字符) → 表名(下划线) 映射
    // 之前只处理了 habit-logs，漏了 body-metrics/fitness-goals/storage，
    // 导致这些接口全部返回 null（体重记录/弹窗打不开、存储物品失效）
    const RESOURCE_TABLE = {
      'body-metrics': 'body_metrics',
      'fitness-goals': 'fitness_goals',
      'habit-logs': 'habit_logs',
      'storage': 'storage_items',
      'workout-exercises': 'workout_exercises',
      'task-logs': 'task_logs',
    };
    const table = RESOURCE_TABLE[resource] || resource;
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
      // 训练记录：解析 exercises_raw → workout_exercises
      if (table === 'workouts' && row.exercises_raw) {
        const parsed = parseExercisesText(row.exercises_raw);
        if (parsed.length) {
          const exRows = loadTable('workout_exercises');
          // 循环外先算出起始 id 并递增，避免 nextId 每次都从 localStorage 读旧数据导致 id 重复
          let exId = exRows.length ? Math.max(...exRows.map(r => r.id || 0)) : 0;
          parsed.forEach((ex, i) => {
            exRows.push(Object.assign({}, ex, { id: ++exId, workout_id: row.id, created_at: nowIso() }));
          });
          saveTable('workout_exercises', exRows);
        }
      }
      return row;
    }

    if (method === 'PUT') {
      const idx = rows.findIndex(r => r.id === id);
      if (idx < 0) return null;
      // date 是日历补记的控制字段（标记"补的是哪一天"），绝不能写进任务行污染数据
      const bodyClean = Object.assign({}, body);
      if (table === 'tasks') delete bodyClean.date;
      const updated = Object.assign({}, rows[idx], bodyClean, { updated_at: nowIso() });
      // === 待办状态变更：完成(done) / 跳过(skipped)，二者互斥 ===
      if (table === 'tasks') {
        const logDate = body.date || updated.due_date;
        const isRepeat = updated.repeat && updated.repeat !== 'none';
        const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
        if (logDate > todayStr) {
          console.warn('[localdb] 拒绝写入未来日志:', logDate);
          rows[idx] = updated;
          saveTable(table, rows);
          return updated;
        }

        // 处理"跳过/没去"：写 task_logs(status='skipped')，不滚动模板指针
        if (body && 'skipped' in body) {
          const logs = loadTable('task_logs');
          if (body.skipped) {
            // 标记跳过：清除该天已有的日志（完成或跳过），写入跳过日志
            const filtered = logs.filter(l => !(l.task_id === id && l.date === logDate));
            filtered.push({ id: nextId('task_logs'), task_id: id, date: logDate, status: 'skipped', created_at: nowIso() });
            saveTable('task_logs', filtered);
            if (!isRepeat) { updated.skipped = true; updated.completed = false; }
          } else {
            // 取消跳过：删除该天的跳过日志
            saveTable('task_logs', logs.filter(l => !(l.task_id === id && l.date === logDate && (l.status || 'done') === 'skipped')));
            if (!isRepeat) { updated.skipped = false; }
          }
        }

        // 处理"完成"（重复任务：写日志+滚动指针；非重复任务：直接标记+清除跳过）
        if (body && 'completed' in body) {
          if (isRepeat) {
            if (body.completed) {
              const logs = loadTable('task_logs');
              // 完成时清除该天已有的跳过日志（互斥），写入完成日志
              const filtered = logs.filter(l => !(l.task_id === id && l.date === logDate));
              filtered.push({ id: nextId('task_logs'), task_id: id, date: logDate, status: 'done', created_at: nowIso() });
              saveTable('task_logs', filtered);
              if (!body.date || body.date >= updated.due_date) {
                const next = nextRepeatDate(updated);
                if (next) { updated.due_date = next; updated.completed = false; updated.last_completed_at = nowIso(); }
              } else {
                updated.completed = false;
                updated.last_completed_at = nowIso();
              }
            } else {
              // 取消完成：删除该日期的完成日志
              saveTable('task_logs', loadTable('task_logs').filter(l => !(l.task_id === id && l.date === logDate)));
              updated.last_completed_at = null;
            }
          } else {
            // 非重复任务完成时清除跳过标记
            if (body.completed) updated.skipped = false;
          }
        }
      }
      rows[idx] = updated;
      saveTable(table, rows);
      return updated;
    }

    if (method === 'DELETE') {
      rows = rows.filter(r => r.id !== id);
      saveTable(table, rows);
      // 删除训练时级联删除动作明细
      if (table === 'workouts') {
        const ex = loadTable('workout_exercises').filter(e => e.workout_id !== id);
        saveTable('workout_exercises', ex);
      }
      // 删除待办时级联删除完成日志
      if (table === 'tasks') {
        saveTable('task_logs', loadTable('task_logs').filter(l => l.task_id !== id));
      }
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
    else if (r === 'monthly') {
      // 下月同日：锚定 repeat_start 的日号（避免 1/31→2/28→3/28 的 clamp 漂移与日历展开不一致）
      const anchorDay = t.repeat_start ? parseInt(String(t.repeat_start).slice(8, 10)) : NaN;
      const dayNum = isNaN(anchorDay) ? d.getDate() : anchorDay;
      const y2 = d.getFullYear(), m2 = d.getMonth() + 1;
      const ny = m2 === 12 ? y2 + 1 : y2, nm = m2 === 12 ? 1 : m2 + 1;
      const last = new Date(ny, nm, 0).getDate();
      d.setFullYear(ny, nm - 1, Math.min(dayNum, last));
    }
    else if (r === 'custom') {
      const days = new Set(String(t.repeat_days || '').split(',').map(x => parseInt(x)).filter(x => !isNaN(x)));
      if (days.size === 0) {
        d.setDate(d.getDate() + 7); // 无有效星期配置，按周兜底，避免空循环滚到 15 天后
      } else {
        for (let i = 0; i < 15; i++) {
          d.setDate(d.getDate() + 1);
          const wd = d.getDay() === 0 ? 6 : d.getDay() - 1;
          if (days.has(wd)) break;
        }
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
              // 查状态日志：done→打钩灰色划线，skipped→红色打叉划线
              const logs = loadTable('task_logs').filter(l => l.task_id === t.id);
              const logMap = {};
              logs.forEach(l => { logMap[l.date] = l.status || 'done'; });
              occ.forEach(od => {
                const copy = Object.assign({}, t);
                copy.due_date = od;
                copy.completed = logMap[od] === 'done';
                copy.skipped = logMap[od] === 'skipped';
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
    const habits = loadTable('habits');
    const habitLogs = loadTable('habit_logs');
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
      habit_total: habits.length,
      habit_done_today: habitLogs.filter(l => l.date === todayStr).length,
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
      // 只存一份原图；thumb 直接复用（避免体积翻倍）
      await imgPut(key, dataURL);
      const thumb = key.replace('.jpg', '_thumb.jpg');
      IMG_CACHE[thumb] = dataURL;
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
  // 说明：日记引用可能是 _thumb.jpg（新图缩略名）或历史叠加的 _thumb_thumb.jpg，
  // IndexedDB 里可能存的是原图 key 或种子图 key(_thumb.jpg)。
  // 因此逐层回退尝试：原 key → 去一层 _thumb → ... 直到命中或没有 _thumb。
  async function resolveImg(url) {
    if (!url || !url.startsWith('/uploads/')) return url;
    let key = url.replace('/uploads/', '');
    while (key) {
      const d = await imgGet(key);
      if (d) return d;
      if (key.endsWith('_thumb.jpg')) key = key.replace('_thumb.jpg', '.jpg');
      else break;
    }
    return '';
  }
  // 同步版：从内存缓存取（预加载后可用）；未命中返回透明占位图避免破图
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  function resolveImgSync(url) {
    if (!url || !url.startsWith('/uploads/')) return url;
    let key = url.replace('/uploads/', '');
    while (key) {
      if (IMG_CACHE[key]) return IMG_CACHE[key];
      if (key.endsWith('_thumb.jpg')) key = key.replace('_thumb.jpg', '.jpg');
      else break;
    }
    return PLACEHOLDER;
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
  // 安全策略：只填充"空的表"，绝不覆盖任何已有数据。
  // 即使 _seeded 标记丢失（浏览器清缓存/换入口打开），用户真实数据也不会被演示数据冲掉。
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
            const existing = loadTable(table);
            if (!existing.length) saveTable(table, rows);
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

  // ---------- 启动自清理：删除未来日期的错误日志、清理重复任务模板 ----------
  function selfHeal() {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    // 清理未来 task_logs（不可能已经完成/跳过了未来的任务）
    const logs = loadTable('task_logs');
    const cleanLogs = logs.filter(l => (l.date || '') <= todayStr);
    if (cleanLogs.length !== logs.length) {
      console.warn('[localdb] self-heal: 删除', logs.length - cleanLogs.length, '条未来日志');
      saveTable('task_logs', cleanLogs);
    }
    // 清理重复任务模板上的非规范字段（这些字段只该出现在非重复任务上）
    const tasks = loadTable('tasks');
    let dirty = false;
    tasks.forEach(t => {
      if (t.repeat && t.repeat !== 'none') {
        if ('skipped' in t) { delete t.skipped; dirty = true; }
        if ('date' in t) { delete t.date; dirty = true; }
        if (t.completed === true) { t.completed = false; dirty = true; }
      }
    });
    if (dirty) {
      console.warn('[localdb] self-heal: 清理重复任务模板');
      saveTable('tasks', tasks);
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
      if (Array.isArray(payload.tables[t])) {
        // 备份中的日记图片同样归一化
        if (t === 'diaries') {
          payload.tables[t].forEach(d => {
            if (typeof d.images === 'string') {
              try { d.images = JSON.parse(d.images); } catch (e) { d.images = []; }
            }
            if (!Array.isArray(d.images)) d.images = [];
          });
        }
        saveTable(t, payload.tables[t]);
      }
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

  // ---------- 图片健康检查 ----------
  // 统计日记里引用了但 IndexedDB 中已无数据的照片张数（浏览器清理缓存会导致丢失）
  // 判定规则与 resolveImg 一致：逐层去掉 _thumb 回退，所有候选 key 都没有才算缺失
  async function countMissingImages() {
    try {
      const diaries = loadTable('diaries');
      const refs = [];
      diaries.forEach(d => {
        (d.images || []).forEach(u => {
          const s = (typeof u === 'object' && u) ? (u.url || '') : u;
          if (typeof s === 'string' && s.startsWith('/uploads/')) refs.push(s.replace('/uploads/', ''));
        });
      });
      if (!refs.length) return 0;
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').getAll();
        req.onsuccess = () => {
          const have = new Set((req.result || []).map(r => r.key));
          let missing = 0;
          refs.forEach(r => {
            let k = r, ok = false;
            while (k) {
              if (have.has(k)) { ok = true; break; }
              if (k.endsWith('_thumb.jpg')) k = k.replace('_thumb.jpg', '.jpg');
              else break;
            }
            if (!ok) missing++;
          });
          resolve(missing);
        };
        req.onerror = reject;
      });
    } catch (e) {
      return 0;
    }
  }

  // ---------- 导出 ----------
  window.LocalDB = {
    resolveImg, resolveImgSync, loadAllImagesToCache, imgPut, imgGet,
    handle, loadTable, saveTable, expandRepeatInMonth, seedIfNeeded,
    exportBackupData, importBackupData, countMissingImages,
  };

  // 启动时：先导入 seed，再预加载图片
  function boot() {
    seedIfNeeded().then(() => { selfHeal(); loadAllImagesToCache(); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
