// 模拟用户手机上的真实场景：老数据 + v8 修复逻辑
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.window = global;
global.document = { createElement: () => ({ style: {} }), };
global.indexedDB = undefined;
global.fetch = () => Promise.resolve({ ok: false });

// 用户手机现状：
// - 跳舞任务存在，是旧版创建的：repeat='weekly'，due_date 已滚动到 2026-08-19，无 repeat_start
// - 旧标记 _dance_task_created 已设置，新标记 _dance_task_fixed 不存在
store['workbuddy_tasks'] = JSON.stringify([
  { id: 3, title: '跳舞', description: '', priority: 2, category: '生活', completed: false, due_date: '2026-08-19', repeat: 'weekly', repeat_days: '', last_completed_at: '2026-08-12T10:00:00', created_at: '2026-08-07 12:15:17' },
  { id: 7, title: '买牛奶', description: '', priority: 1, category: '生活', completed: false, due_date: '2026-08-12', repeat: 'none', repeat_days: '', created_at: '2026-08-01 09:00:00' },
]);
store['workbuddy_task_logs'] = JSON.stringify([
  { id: 1, task_id: 3, date: '2026-08-05', created_at: '2026-08-05T20:00:00' },
  { id: 2, task_id: 3, date: '2026-08-12', created_at: '2026-08-12T10:00:00' },
]);
store['_dance_task_created'] = '1';
// 模拟 _dance_task_fixed 不存在

const src = require('fs').readFileSync('localdb.js', 'utf8');
eval(src);
const db = window.LocalDB;

(async () => {
  // 1. 模拟前端 initDanceTask 的修复逻辑
  const tasks = await db.handle('/api/tasks');
  const dances = tasks.filter(t => t.title === '跳舞' && (t.repeat === 'weekly' || t.repeat === 'custom'));
  console.log('1) 找到跳舞任务:', dances.length, '条');
  const keep = dances.slice().sort((a, b) => (a.id || 0) - (b.id || 0))[0];
  if (!keep.repeat_start) {
    await db.handle(`/api/tasks/${keep.id}`, { method: 'PUT', body: JSON.stringify({ repeat_start: '2026-01-07' }) });
    console.log('   已补 repeat_start = 2026-01-07');
  } else {
    console.log('   repeat_start 已存在 =', keep.repeat_start);
  }

  // 2. 展开 2026年1月
  const jan = await db.handle('/api/tasks?year=2026&month=1');
  const janDance = jan.filter(t => t.title === '跳舞').map(t => t.due_date + (t.completed ? '[完成]' : '[待办]'));
  console.log('2) 2026年1月跳舞展开:', JSON.stringify(janDance), '(期望 4个周三)');

  // 3. 展开 2026年8月
  const aug = await db.handle('/api/tasks?year=2026&month=8');
  const augDance = aug.filter(t => t.title === '跳舞').map(t => t.due_date + (t.completed ? '[完成]' : '[待办]'));
  console.log('3) 2026年8月跳舞展开:', JSON.stringify(augDance), '(期望 8/5[完成] 8/12[完成] 8/19[待办] 8/26[待办])');

  console.log(janDance.length === 4 ? 'TEST PASSED' : 'TEST FAILED');
})().catch(e => { console.error('TEST FAIL:', e); process.exit(1); });
