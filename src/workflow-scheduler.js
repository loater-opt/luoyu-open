/**
 * workflow-scheduler.js — 全局工作流定时调度器
 * 在 App.vue 后台运行（无需打开工作流页面），App 在后台/前台都能定时触发。
 *
 * 支持的触发配置（两套格式统一处理）：
 * - 标准：schedule_type = interval / specific_time / cron
 *  - 落雨旧格式：kind = fixed / datetime / loop
 *
 * 与页面共用全局执行锁 getApp().globalData._wfRunning，避免重复/并发执行。
 */
import engine from './workflow-engine.js'
import runner from './workflow-runner.js'

function loadList() {
  var raw = uni.getStorageSync('workflow_list')
  var arr = []
  if (raw) { try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw } catch(e) {} }
  return Array.isArray(arr) ? arr : []
}

function saveList(arr) {
  uni.setStorageSync('workflow_list', JSON.stringify(arr))
}

function loadObj(key) {
  var raw = uni.getStorageSync(key)
  if (!raw) return {}
  try {
    var o = typeof raw === 'string' ? JSON.parse(raw) : raw
    return o && typeof o === 'object' ? o : {}
  } catch(e) { return {} }
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function todayStr() {
  var d = new Date()
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

function nowHm() {
  var d = new Date()
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function parseTimeToMs(t) {
  var m = String(t || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$/)
  if (!m) return NaN
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0).getTime()
}

// 触发器是否关闭（triggerConfig.enabled = 'false'）
function isTriggerDisabled(cfg) {
  return cfg.enabled === 'false' || cfg.enabled === false
}

// 检查所有启用工作流的定时触发，返回到期列表 [{ wf, triggerNodeId }]，并持久化调度状态
function pickDueWorkflows() {
  var list = loadList()
  if (!list.length) return []
  var schedLast = loadObj('workflow_sched_last')
  var schedDate = loadObj('workflow_sched_date')
  var due = []
  var changed = false
  var now = Date.now()

  list.forEach(function(wf) {
    if (!wf || wf.enabled === false) return
    var trig = null
    ;(wf.nodes || []).forEach(function(n) {
      if (n && n.type === 'trigger' && n.triggerType === 'schedule') trig = n
    })
    if (!trig) return
    var cfg = (trig.triggerConfig || {})
    if (isTriggerDisabled(cfg)) return
    var key = wf.id || 'wf'

 // ===== 标准格式 =====
    var st = cfg.schedule_type
    if (st === 'interval' || st === 'specific_time' || st === 'cron') {
      if (st === 'interval') {
        var ms = parseInt(cfg.interval_ms, 10) || 900000
        var last = schedLast[key] || 0
        var repeat = cfg.repeat !== 'false' && cfg.repeat !== false
        if (!repeat && schedLast[key + '_once']) return
        if (now - last >= ms) {
          if (repeat) schedLast[key] = now
          else schedLast[key + '_once'] = now
          changed = true
          due.push({ wf: wf, triggerNodeId: trig.id })
        }
        return
      }
      if (st === 'specific_time') {
        var dt = cfg.specific_time || ''
        if (!dt || schedDate[key]) return
        var t = parseTimeToMs(dt)
        if (!isNaN(t) && now >= t) {
          schedDate[key] = dt
          changed = true
          due.push({ wf: wf, triggerNodeId: trig.id })
        }
        return
      }
      // cron（简化）：兼容 6 字段 "秒 分 时 日 月 周" 与 5 字段 "分 时 日 月 周"，每天定点；"* * ..." 每分钟
      var tokens = String(cfg.cron_expression || '').trim().split(/\s+/)
      if (tokens.length >= 2) {
        // 6 字段（带秒）：分=tokens[1]、时=tokens[2]；5 字段及更短：分=tokens[0]、时=tokens[1]
        var mi = tokens.length >= 6 ? 1 : 0
        var hi = tokens.length >= 6 ? 2 : 1
        if (tokens[mi] === '*' && tokens[hi] === '*') {
          var lastMin = schedLast[key] || 0
          if (now - lastMin >= 60000) {
            schedLast[key] = now
            changed = true
            due.push({ wf: wf, triggerNodeId: trig.id })
          }
          return
        }
        var min = pad2(parseInt(tokens[mi], 10) || 0)
        var hour = pad2(parseInt(tokens[hi], 10) || 0)
        if (nowHm() === hour + ':' + min && schedDate[key] !== todayStr()) {
          schedDate[key] = todayStr()
          changed = true
          due.push({ wf: wf, triggerNodeId: trig.id })
        }
      }
      return
    }

    // ===== 落雨旧格式（kind / type） =====
    var kind = cfg.kind || (cfg.type === 'time' ? 'loop' : 'fixed')
    if (kind === 'fixed') {
      var val = parseInt(cfg.fixedValue || cfg.intervalMin || 30, 10) || 30
      var unitMin = cfg.fixedUnit === 'day' ? 1440 : (cfg.fixedUnit === 'hour' ? 60 : 1)
      var last2 = schedLast[key] || 0
      if (now - last2 >= val * unitMin * 60000) {
        schedLast[key] = now
        changed = true
        due.push({ wf: wf, triggerNodeId: trig.id })
      }
      return
    }
    if (kind === 'datetime') {
      var d2 = cfg.dateTime || ''
      if (!d2 || schedDate[key]) return
      var t2 = parseTimeToMs(d2)
      if (!isNaN(t2) && now >= t2) {
        schedDate[key] = d2
        changed = true
        due.push({ wf: wf, triggerNodeId: trig.id })
      }
      return
    }
    if (kind === 'loop') {
      if (cfg.loopEnabled === false) return
      if (cfg.loopEvery === 'min') {
        var last3 = schedLast[key] || 0
        if (now - last3 >= 60000) {
          schedLast[key] = now
          changed = true
          due.push({ wf: wf, triggerNodeId: trig.id })
        }
        return
      }
      if (cfg.loopEvery === 'hour') {
        var last4 = schedLast[key] || 0
        if (now - last4 >= 3600000) {
          schedLast[key] = now
          changed = true
          due.push({ wf: wf, triggerNodeId: trig.id })
        }
        return
      }
      if (cfg.loopTime === nowHm() && schedDate[key] !== todayStr()) {
        schedDate[key] = todayStr()
        changed = true
        due.push({ wf: wf, triggerNodeId: trig.id })
      }
    }
  })

  if (changed) {
    uni.setStorageSync('workflow_sched_last', JSON.stringify(schedLast))
    uni.setStorageSync('workflow_sched_date', JSON.stringify(schedDate))
  }
  return due
}

// 执行单个工作流（带全局锁 + 统计写回）。锁被占用时返回 { skipped: true }
function runWorkflow(wf, triggerNodeId) {
  var gs = getApp().globalData
  if (gs._wfRunning) {
    return Promise.resolve({ success: false, skipped: true, message: '已有工作流正在执行' })
  }
  gs._wfRunning = true
  var stepRunner = runner.buildStepRunner()
  return engine.executeWorkflow(wf, {
    triggerNodeId: triggerNodeId || null,
    stepRunner: stepRunner
  }).then(function(result) {
    wf.stats = wf.stats || {}
    wf.stats.total = (wf.stats.total || 0) + 1
    if (result.success) {
      wf.stats.success = (wf.stats.success || 0) + 1
      wf.stats.lastStatus = 'success'
    } else {
      wf.stats.failed = (wf.stats.failed || 0) + 1
      wf.stats.lastStatus = 'failed'
    }
    wf.stats.lastTime = Date.now()
    var list = loadList()
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === wf.id) { list[i] = wf; break }
    }
    saveList(list)
    return result
  }).then(function(result) {
    gs._wfRunning = false
    return result
  }).catch(function(e) {
    gs._wfRunning = false
    return { success: false, message: String((e && e.message) || e) }
  })
}

// 检查并执行所有到期工作流（App 定时器 / 页面 onShow 共用）
function runDue() {
  var due = pickDueWorkflows()
  if (!due.length) return Promise.resolve([])
  var jobs = []
  due.forEach(function(d) {
    jobs.push(runWorkflow(d.wf, d.triggerNodeId))
  })
  return Promise.all(jobs)
}

export default {
  pickDueWorkflows: pickDueWorkflows,
  runWorkflow: runWorkflow,
  runDue: runDue
}
