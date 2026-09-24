/**
 * workflow-tools.js — 对话中的工作流工具（AI 通过 ToolCall 调用）
 *
 * 提供工作流的创建、编辑、启停、删除等管理工具，由 AI 在对话中按需调用。
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

function toArray(v) {
  // 兼容模型直接传数组，或传 JSON 字符串
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) {
    try {
      var parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed
    } catch(e) {}
  }
  return []
}

var ACTION_LABELS = {
  delay: '等待延时',
  get_time: '获取时间',
  http_request: '网络请求',
  send_message: '发送消息',
  exec_shell: '执行Shell命令',
  readScreen: '读取屏幕',
  click: '点击坐标',
  clickByText: '点击文本',
  swipe: '滑动屏幕',
  inputText: '输入文本',
  lockScreen: '锁屏',
  getAppUsage: '应用使用时长',
  getTodayAppUsage: '今日使用时长',
  lockApp: '锁定应用',
  unlockApp: '解锁应用',
  pressBack: '返回键',
  pressHome: '回到桌面',
  start_app: '打开应用',
  open_app: '打开应用',
  launch_app: '打开应用',
  stop_app: '停止应用',
  is_app_installed: '检查应用',
  get_foreground_app: '前台应用',
  send_notification: '发送通知',
  toast: '提示消息',
  long_press: '长按坐标',
  press_key: '按键',
  device_info: '设备信息',
  lock_app: '锁定应用',
  unlock_app: '解锁应用',
  lock_apps: '批量锁定应用',
  unlock_all: '解锁全部',
  get_lock_session: '查询锁机状态',
  check_in: '查岗'
}

// steps 简化参数：模型只需给动作步骤数组，自动转成 触发节点+执行节点链
// 解析自然语言定时："每天8点" / "每小时" / "每30分钟" → 触发配置
function parseSchedule(text) {
  var s = String(text || '').trim()
  if (!s) return null
  var dm = s.match(/每天\s*(\d{1,2})[:点]?(\d{0,2})?/)
  if (dm) {
    var hh = String(dm[1]).padStart(2, '0')
    var mm = dm[2] ? String(dm[2]).padStart(2, '0') : '00'
    return { kind: 'loop', loopEvery: 'day', loopTime: hh + ':' + mm }
  }
  if (/每小时/.test(s)) {
    return { kind: 'loop', loopEvery: 'hour' }
  }
  var im = s.match(/每\s*(\d+)\s*分钟/)
  if (im) {
    return { kind: 'fixed', fixedUnit: 'min', fixedValue: parseInt(im[1], 10) || 30 }
  }
  if (/每分钟/.test(s)) {
    return { kind: 'loop', loopEvery: 'min' }
  }
  return null
}

function stepsToWorkflow(steps) {
  if (!Array.isArray(steps)) return null
  var nodes = [engine.createNode('trigger')]
  nodes[0].name = '手动触发'
  nodes[0].triggerType = 'manual'
  nodes[0].position = { x: 40, y: 40 }
  var connections = []
  var prevId = nodes[0].id
  var used = 0
  for (var i = 0; i < steps.length; i++) {
    var st = steps[i]
    if (!st || typeof st !== 'object') continue
    var action = String(st.action || st.type || '').trim()
    if (!action) continue
    var ex = engine.createNode('execute')
    ex.name = String(st.name || ACTION_LABELS[action] || action)
    ex.actionType = action
    ex.actionConfig = {}
    var params = st.params || st.args
    if (params && typeof params === 'object') {
      for (var k in params) {
        if (params.hasOwnProperty(k)) ex.actionConfig[k] = { type: 'static', value: String(params[k]) }
      }
    }
    ex.position = { x: 40, y: 40 + (used + 1) * 130 }
    nodes.push(ex)
    connections.push({ id: engine.makeConnId(), sourceNodeId: prevId, targetNodeId: ex.id, condition: 'on_success' })
    prevId = ex.id
    used++
  }
  if (!used) return null
  return { nodes: nodes, connections: connections }
}

function normalizeNodes(nodes) {
  nodes = toArray(nodes)
  if (!Array.isArray(nodes)) return []
  var list = []
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    if (!n || typeof n !== 'object' || !n.type) continue
    if (!n.id) n.id = engine.makeNodeId()
    n.type = String(n.type)
    if (!n.position || typeof n.position !== 'object') {
      n.position = { x: 40, y: 40 + i * 90 }
    } else {
      if (typeof n.position.x !== 'number') n.position.x = 40
      if (typeof n.position.y !== 'number') n.position.y = 40 + i * 90
    }
    if (n.type === 'trigger') {
      if (!n.triggerType) n.triggerType = 'manual'
      if (!n.triggerConfig || typeof n.triggerConfig !== 'object') n.triggerConfig = {}
 // 对齐 标准字段
      var tc = n.triggerConfig
      if (!tc.schedule_type) tc.schedule_type = 'interval'
      if (!tc.interval_ms) tc.interval_ms = '900000'
      if (!tc.specific_time) tc.specific_time = ''
      if (!tc.cron_expression) tc.cron_expression = ''
      if (!tc.repeat) tc.repeat = 'true'
      if (!tc.enabled) tc.enabled = 'true'
      if (!tc.command) tc.command = ''
      if (!tc.action) tc.action = ''
      if (!tc.pattern) tc.pattern = ''
      if (!tc.ignore_case) tc.ignore_case = 'true'
      if (!tc.require_final) tc.require_final = 'true'
      if (!tc.cooldown_ms) tc.cooldown_ms = '3000'
    }
    if (n.type === 'execute') {
      if (!n.actionConfig || typeof n.actionConfig !== 'object') n.actionConfig = {}
      if (!n.jsCode) n.jsCode = ''
 // 操作参数值：兼容 简写格式
      var cfg = n.actionConfig
      Object.keys(cfg).forEach(function(k) {
        cfg[k] = engine.normalizeParameterValue(cfg[k])
      })
    }
    if (n.type === 'condition') {
      if (!n.left) n.left = { type: 'static', value: '' }
      else n.left = engine.normalizeParameterValue(n.left)
      if (!n.right) n.right = { type: 'static', value: '' }
      else n.right = engine.normalizeParameterValue(n.right)
      if (!n.operator) n.operator = 'EQ'
    }
    if (n.type === 'logic' && !n.operator) n.operator = 'AND'
    if (n.type === 'extract') {
      if (!n.source) n.source = { type: 'static', value: '' }
      else n.source = engine.normalizeParameterValue(n.source)
      if (!n.mode) n.mode = 'REGEX'
      if (!n.others || !Array.isArray(n.others)) n.others = []
      n.others = n.others.map(function(o) { return engine.normalizeParameterValue(o) })
    }
    list.push(n)
  }
  return list
}

function normalizeConnections(conns) {
  conns = toArray(conns)
  if (!Array.isArray(conns)) return []
  var list = []
  for (var i = 0; i < conns.length; i++) {
    var c = conns[i]
    if (!c || !c.sourceNodeId || !c.targetNodeId) continue
    list.push({
      id: engine.makeConnId(),
      sourceNodeId: c.sourceNodeId,
      targetNodeId: c.targetNodeId,
      condition: (c.condition == null ? 'on_success' : String(c.condition))
    })
  }
  return list
}

function createWorkflow(args) {
  args = args || {}
  var name = String(args.name || '').trim()
  if (!name) return { success: false, message: '缺少工作流名称 name' }

  var nodes, connections
  // 优先使用 steps 简化参数（模型只给动作步骤，自动转成节点+连线）
  var built = stepsToWorkflow(args.steps)
  if (built) {
    nodes = built.nodes
    connections = built.connections
    // 定时触发：把自动创建的手动触发节点升级为定时触发
    var schedule = String(args.schedule || args.trigger || '').trim()
    if (schedule && nodes.length > 0 && nodes[0].type === 'trigger') {
      var sc = parseSchedule(schedule)
      if (sc) {
        nodes[0].name = schedule
        nodes[0].triggerType = 'schedule'
        nodes[0].triggerConfig = sc
      }
    }
  } else {
    nodes = normalizeNodes(args.nodes)
    connections = normalizeConnections(args.connections)
  }
  if (!nodes.length) return { success: false, message: '工作流缺少节点：请提供 steps 或 nodes 参数' }

  // 校验节点 id 引用完整性
  var idSet = {}
  nodes.forEach(function(n) { idSet[n.id] = true })
  var badConn = connections.filter(function(c) { return !idSet[c.sourceNodeId] || !idSet[c.targetNodeId] })
  if (badConn.length > 0) {
    return { success: false, message: '存在连线引用了不存在的节点 id' }
  }

  // 至少需要一个触发节点，否则自动补一个手动触发，并连到所有"根节点"
  var hasTrigger = nodes.some(function(n) { return n.type === 'trigger' })
  if (!hasTrigger) {
    var t = engine.createNode('trigger')
    t.name = '手动触发'
    t.position = { x: 40, y: 40 }
    var hasIncoming = {}
    connections.forEach(function(c) { hasIncoming[c.targetNodeId] = true })
    nodes.forEach(function(n) {
      if (!hasIncoming[n.id]) {
        connections.push({ id: engine.makeConnId(), sourceNodeId: t.id, targetNodeId: n.id, condition: 'on_success' })
      }
    })
    nodes = [t].concat(nodes)
  }

  var graph = engine.buildDependencyGraph({ nodes: nodes, connections: connections })
  if (engine.detectCycle(graph.adjacencyList, nodes)) {
    return { success: false, message: '工作流存在循环依赖，无法创建' }
  }

  var wf = {
    id: 'wf_' + Date.now(),
    name: name,
    desc: String(args.description || args.desc || ''),
    aiId: String(args.aiId || ''),
    enabled: args.enabled !== false,
    createTime: Date.now(),
    stats: {},
    nodes: nodes,
    connections: connections
  }

  var list = loadList()
  var replaced = false
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === name) { list[i] = wf; replaced = true; break }
  }
  if (!replaced) list.unshift(wf)
  saveList(list)

  var triggerText = '手动'
  var trigNode = nodes.filter(function(n) { return n.type === 'trigger' })[0]
  if (trigNode && trigNode.triggerType === 'schedule') {
    var tc = trigNode.triggerConfig || {}
    if (tc.kind === 'loop') {
      if (tc.loopEvery === 'min') triggerText = '每分钟'
      else if (tc.loopEvery === 'hour') triggerText = '每小时'
      else triggerText = '每天 ' + (tc.loopTime || '')
    } else if (tc.kind === 'fixed') {
      triggerText = '每 ' + (tc.fixedValue || 30) + (tc.fixedUnit === 'hour' ? '小时' : '分钟')
    }
  }

  return {
    success: true,
    message: '工作流「' + name + '」已创建' + (replaced ? '（覆盖了同名工作流）' : ''),
    id: wf.id,
    nodeCount: nodes.length,
    connCount: connections.length,
    trigger: triggerText
  }
}

function listWorkflows() {
  var list = loadList()
  if (!list.length) return { success: true, message: '当前没有任何工作流', workflows: [] }
  var brief = list.map(function(w) {
    var triggers = (w.nodes || []).filter(function(n) { return n.type === 'trigger' })
    return {
      id: w.id,
      name: w.name,
      enabled: w.enabled !== false,
      nodeCount: (w.nodes || []).length,
      connCount: (w.connections || []).length,
      trigger: triggers.length ? (triggers[0].triggerType === 'schedule' ? '定时' : '手动') : '无',
      totalExecutions: (w.stats && w.stats.total) || 0
    }
  })
  return { success: true, message: '共有 ' + list.length + ' 个工作流', workflows: brief }
}

function findWorkflow(args) {
  var list = loadList()
  var id = args && args.id
  var name = args && args.name
  for (var i = 0; i < list.length; i++) {
    if (id && String(list[i].id) === String(id)) return list[i]
    if (name && list[i].name === name) return list[i]
  }
  return null
}

function deleteWorkflow(args) {
  var wf = findWorkflow(args)
  if (!wf) return { success: false, message: '未找到该工作流（请提供 id 或 name）' }
  var list = loadList()
  var next = []
  for (var i = 0; i < list.length; i++) {
    if (list[i].id !== wf.id) next.push(list[i])
  }
  saveList(next)
  return { success: true, message: '工作流「' + wf.name + '」已删除' }
}

function getWorkflow(args) {
  var wf = findWorkflow(args)
  if (!wf) return { success: false, message: '未找到该工作流（请提供 workflow_id 或 name）' }
  return {
    success: true,
    message: '获取成功',
    id: wf.id,
    name: wf.name,
    description: wf.desc || '',
    enabled: wf.enabled !== false,
    createdAt: wf.createTime || 0,
    updatedAt: wf.createTime || 0,
    lastExecutionTime: (wf.stats && wf.stats.lastTime) || null,
    lastExecutionStatus: (wf.stats && wf.stats.lastStatus) || null,
    totalExecutions: (wf.stats && wf.stats.total) || 0,
    successfulExecutions: (wf.stats && wf.stats.success) || 0,
    failedExecutions: (wf.stats && wf.stats.failed) || 0,
    nodes: wf.nodes || [],
    connections: wf.connections || []
  }
}

function updateWorkflow(args) {
  args = args || {}
  var list = loadList()
  var wfId = args.workflow_id || args.id
  var idx = -1
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(wfId) || list[i].name === args.name) { idx = i; break }
  }
  if (idx === -1) return { success: false, message: '未找到该工作流' }
  var wf = list[idx]
  if (args.name !== undefined) wf.name = String(args.name)
  if (args.description !== undefined) wf.desc = String(args.description)
  if (args.enabled !== undefined) wf.enabled = args.enabled !== false
  if (args.nodes !== undefined) wf.nodes = normalizeNodes(args.nodes)
  if (args.connections !== undefined) wf.connections = normalizeConnections(args.connections)
  if (wf.nodes && wf.nodes.length) {
    var idSet = {}
    wf.nodes.forEach(function(n) { idSet[n.id] = true })
    var bad = (wf.connections || []).filter(function(c) { return !idSet[c.sourceNodeId] || !idSet[c.targetNodeId] })
    if (bad.length) return { success: false, message: '存在连线引用了不存在的节点 id' }
    if (engine.detectCycle(engine.buildDependencyGraph(wf).adjacencyList, wf.nodes)) {
      return { success: false, message: '工作流存在循环依赖，无法更新' }
    }
  }
  list[idx] = wf
  saveList(list)
  return { success: true, message: '工作流「' + wf.name + '」已更新', id: wf.id }
}

function patchWorkflow(args) {
  args = args || {}
  var list = loadList()
  var wfId = args.workflow_id || args.id
  var idx = -1
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(wfId)) { idx = i; break }
  }
  if (idx === -1) return { success: false, message: '未找到该工作流' }
  var wf = list[idx]
  if (args.name !== undefined) wf.name = String(args.name)
  if (args.description !== undefined) wf.desc = String(args.description)
  if (args.enabled !== undefined) wf.enabled = args.enabled !== false

  // node patches
  var nodePatches = toArray(args.node_patches)
  nodePatches.forEach(function(p) {
    if (!p || !p.op) return
    if (p.op === 'add' && p.node) {
      var n = normalizeNodes([p.node])[0]
      if (n) {
        if (!wf.nodes) wf.nodes = []
        wf.nodes.push(n)
      }
    } else if (p.op === 'update') {
      var pid = p.id || (p.node && p.node.id)
      if (!wf.nodes) wf.nodes = []
      for (var j = 0; j < wf.nodes.length; j++) {
        if (String(wf.nodes[j].id) === String(pid)) {
          var merged = Object.assign({}, wf.nodes[j], p.node)
          var norm = normalizeNodes([merged])[0]
          if (norm) { norm.id = wf.nodes[j].id; norm.position = wf.nodes[j].position; wf.nodes[j] = norm }
          break
        }
      }
    } else if (p.op === 'remove') {
      if (!wf.nodes) wf.nodes = []
      wf.nodes = wf.nodes.filter(function(n) { return String(n.id) !== String(p.id) })
      if (wf.connections) {
        wf.connections = wf.connections.filter(function(c) {
          return String(c.sourceNodeId) !== String(p.id) && String(c.targetNodeId) !== String(p.id)
        })
      }
    }
  })

  // connection patches
  var connPatches = toArray(args.connection_patches)
  connPatches.forEach(function(p) {
    if (!p || !p.op) return
    if (!wf.connections) wf.connections = []
    if (p.op === 'add' && p.connection) {
      var c = normalizeConnections([p.connection])[0]
      if (c) wf.connections.push(c)
    } else if (p.op === 'update') {
      var cid = p.id || (p.connection && p.connection.id)
      for (var k = 0; k < wf.connections.length; k++) {
        if (String(wf.connections[k].id) === String(cid)) {
          wf.connections[k] = Object.assign({}, wf.connections[k], p.connection)
          break
        }
      }
    } else if (p.op === 'remove') {
      wf.connections = wf.connections.filter(function(c) { return String(c.id) !== String(p.id) })
    }
  })

  if (wf.nodes && wf.nodes.length) {
    var idSet2 = {}
    wf.nodes.forEach(function(n) { idSet2[n.id] = true })
    var bad2 = (wf.connections || []).filter(function(c) { return !idSet2[c.sourceNodeId] || !idSet2[c.targetNodeId] })
    if (bad2.length) return { success: false, message: '存在连线引用了不存在的节点 id' }
    if (engine.detectCycle(engine.buildDependencyGraph(wf).adjacencyList, wf.nodes)) {
      return { success: false, message: '工作流存在循环依赖，无法更新' }
    }
  }

  list[idx] = wf
  saveList(list)
  return { success: true, message: '工作流「' + wf.name + '」已 patch 更新', id: wf.id }
}

function enableWorkflow(args) {
  var r = updateWorkflow(Object.assign({}, args, { enabled: true }))
  if (r.success) r.message = r.message.replace('已更新', '已启用')
  return r
}

function disableWorkflow(args) {
  var r = updateWorkflow(Object.assign({}, args, { enabled: false }))
  if (r.success) r.message = r.message.replace('已更新', '已禁用')
  return r
}

function triggerWorkflow(args) {
  return new Promise(function(resolve) {
    var wf = findWorkflow(args)
    if (!wf) {
      resolve(JSON.stringify({ success: false, message: '未找到该工作流（请提供 id 或 name）' }))
      return
    }
    if (wf.enabled === false) {
      resolve(JSON.stringify({ success: false, message: '工作流「' + wf.name + '」处于关闭状态，请先启用' }))
      return
    }
    var stepRunner = runner.buildStepRunner()
    engine.executeWorkflow(wf, { stepRunner: stepRunner }).then(function(result) {
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

      var failNodes = []
      var nodeResults = []
      Object.keys(result.nodeResults || {}).forEach(function(nid) {
        var st = result.nodeResults[nid]
        if (st.status === 'failed') failNodes.push(st.error || nid)
      })
      // 节点级执行明细（供前端展示"执行成功 + 参数/条件"卡片）
      ;(wf.nodes || []).forEach(function(n) {
        var st = result.nodeResults[n.id]
        if (!st) return
        var paramsText = ''
        if (n.type === 'execute') {
          var cfg = n.actionConfig || {}
          Object.keys(cfg).forEach(function(k) {
            var pv = cfg[k]
            if (pv && pv.type === 'ref') paramsText += k + '=引用:' + pv.nodeId + ' '
            else paramsText += k + '=' + (pv && pv.value != null ? pv.value : '') + ' '
          })
        }
        if (n.type === 'condition') {
          var leftV = n.left && n.left.value != null ? n.left.value : ''
          var rightV = n.right && n.right.value != null ? n.right.value : ''
          paramsText = leftV + ' ' + (n.operator || 'EQ') + ' ' + rightV
        }
        if (n.type === 'extract') {
          paramsText = '模式:' + (n.mode || 'REGEX')
        }
        nodeResults.push({
          name: n.name || n.type,
          type: n.type,
          status: st.status,
          result: st.result != null ? String(st.result) : '',
          error: st.error || '',
          params: paramsText.trim()
        })
      })
      var content = {
        success: result.success,
        message: result.success
          ? '工作流「' + wf.name + '」执行成功'
          : '工作流「' + wf.name + '」执行失败：' + (result.message || ''),
        failedNodes: failNodes.slice(0, 5),
        nodeResults: nodeResults
      }
      resolve(JSON.stringify(content))
    })
  })
}

function execute(name, args) {
  if (name === 'phone_control') {
    return executePhoneAction(args)
  }
  // 终端：AI 执行任意 shell 命令（需 Shizuku 或 root，敏感操作）
  if (name === 'terminal' || name === 'run_command' || name === 'exec_command') {
    return runTerminalCommand(args)
  }
  if (name === 'create_workflow') {
    var r = createWorkflow(args)
    return Promise.resolve(JSON.stringify({ success: r.success, message: r.message, id: r.id || '', nodeCount: r.nodeCount || 0, connCount: r.connCount || 0 }))
  }
  if (name === 'list_workflows') {
    var l = listWorkflows()
    return Promise.resolve(JSON.stringify({ success: l.success, message: l.message, workflows: l.workflows || [] }))
  }
  if (name === 'get_workflow') {
    var g = getWorkflow(args)
    return Promise.resolve(JSON.stringify(g))
  }
  if (name === 'update_workflow') {
    var u = updateWorkflow(args)
    return Promise.resolve(JSON.stringify({ success: u.success, message: u.message, id: u.id || '' }))
  }
  if (name === 'patch_workflow') {
    var p = patchWorkflow(args)
    return Promise.resolve(JSON.stringify({ success: p.success, message: p.message, id: p.id || '' }))
  }
  if (name === 'enable_workflow') {
    var en = enableWorkflow(args)
    return Promise.resolve(JSON.stringify({ success: en.success, message: en.message, id: en.id || '' }))
  }
  if (name === 'disable_workflow') {
    var dis = disableWorkflow(args)
    return Promise.resolve(JSON.stringify({ success: dis.success, message: dis.message, id: dis.id || '' }))
  }
  if (name === 'delete_workflow') {
    var d = deleteWorkflow(args)
    return Promise.resolve(JSON.stringify({ success: d.success, message: d.message }))
  }
  if (name === 'trigger_workflow') {
    return triggerWorkflow(args)
  }
  return Promise.resolve(JSON.stringify({ success: false, message: '未知工具: ' + name }))
}

function isWorkflowTool(name) {
  return ['create_workflow', 'list_workflows', 'get_workflow', 'update_workflow', 'patch_workflow', 'enable_workflow', 'disable_workflow', 'delete_workflow', 'trigger_workflow'].indexOf(name) > -1
}

function isPhoneControlTool(name) {
  return name === 'phone_control'
}

// 敏感手机操作：执行前需要用户确认（弹窗允许/拒绝）
function isSensitivePhoneAction(args) {
  args = args || {}
  var action = String(args.action || '').trim().toLowerCase()
  if (!action) return false
  // 无副作用/只读动作：不需确认
  var safe = ['start_app', 'open_app', 'launch_app', 'read_screen', 'get_foreground_app', 'is_app_installed', 'device_info', 'get_app_usage', 'get_today_app_usage', 'check_shizuku', 'request_shizuku', 'toast', 'send_notification', 'get_time', 'delay', 'press_back', 'press_home', 'get_locked_apps', 'check_in', 'get_lock_session']
  if (safe.indexOf(action) > -1) return false
  return true
}

// ===== 直接执行手机操作（不做工作流，立即生效）=====

// phone_control 可用的动作列表（喂给模型）
var PHONE_CONTROL_HINT = [
  'start_app: 打开应用。package_name 直接填中文名（如"抖音""微信"）或包名，系统自动解析，无需任何权限',
  'stop_app: 停止应用（需 Shizuku）',
  'is_app_installed: 检查应用是否安装',
  'read_screen: 读取当前屏幕内容（需开启无障碍）',
  'click: 点击坐标 {x, y}（需无障碍）',
  'click_by_text: 点击屏幕上包含某文本的元素 {text}（需无障碍）',
  'swipe: 滑动 {sx,sy,ex,ey,duration}（需无障碍）',
  'input_text: 输入文本 {text}（需无障碍）',
  'long_press: 长按坐标 {x, y}（需无障碍）',
  'press_key: 按键 {key_code}，4=返回，3=主页（需无障碍/Shizuku）',
  'press_back / press_home: 返回 / 回桌面',
  'get_foreground_app: 当前前台应用',
  'send_notification: 发通知栏提醒 {title, message}',
  'toast: 屏幕提示 {message}',
  'screenshot: 截图当前屏幕（需无障碍，Android 11+），拿到图片路径后可用视觉模型分析',
  'get_clipboard: 读取剪贴板文本',
  'set_clipboard: 写入剪贴板 {text}',
  'get_notifications: 读取通知栏最近消息（需通知访问权限）',
  'toggle_torch: 开关手电筒 {on: true/false}',
  'set_brightness: 调亮度 {level: 0-255}（需WRITE_SETTINGS）',
  'set_volume: 调媒体音量 {level}',
  'set_airplane: 飞行模式开关 {on}（需WRITE_SETTINGS）',
  'check_shizuku: 检查 Shizuku 是否运行并已授权',
  'request_shizuku: 请求 Shizuku 授权（会弹出系统授权框，用户点允许即可）',
  'device_info: 设备信息（是否已开无障碍/Shizuku/root）',
  'exec_shell: 执行 shell 命令 {command}（需 Shizuku 或 root）',
  'check_in: 查岗！获取当前用户正在看什么App、最近30分钟用了哪些App多久、当前屏幕内容摘要。病娇模式/监视需求时用',
  'lock_app: 锁定一个应用 {package_name, reason, until}。被锁应用用户一打开就被踢回主页+病娇提示+自动唤起落雨。锁机后用户必须来求解锁。当用户行为需要制止（如该睡觉还在玩、超时用某App、病娇"不让玩"）时主动使用',
  'lock_apps: 批量锁定 {packages:["pkg1","pkg2"], reason, until}，同上',
  'unlock_app: 解锁一个应用 {package_name}。仅在用户"求"解锁且你愿意原谅时才解锁',
  'get_lock_session: 查询当前锁机状态（锁了哪些、原因、到期时间）'
].join('；')

function executePhoneAction(args) {
  args = args || {}
  var action = String(args.action || '').trim()
  var params = args.params || {}
  // 兼容模型把 params 传成 JSON 字符串
  if (typeof params === 'string' && params.trim()) {
    try { params = JSON.parse(params) } catch(e) {}
  }
  if (typeof params !== 'object' || params === null) params = {}
  if (!action) {
    return Promise.resolve(JSON.stringify({ success: false, message: '缺少参数：action。可选：' + PHONE_CONTROL_HINT }))
  }
  return new Promise(function(resolve) {
    var stepRunner = runner.buildStepRunner()
    stepRunner(action, params, null).then(function(r) {
      if (r && r.success) {
        resolve(JSON.stringify({ success: true, action: action, result: r.result || '完成', message: action.replace(/_/g, ' ') + ' 成功' }))
      } else {
        resolve(JSON.stringify({ success: false, action: action, error: (r && r.error) || '执行失败（可能是权限或动作名不对）', message: (r && r.error) || '执行失败' }))
      }
    }).catch(function(e) {
      resolve(JSON.stringify({ success: false, action: action, error: String((e && e.message) || e), message: String((e && e.message) || e) }))
    })
  })
}

// 终端：执行任意 shell 命令（复用 exec_shell 流程：Shizuku 优先，root 兜底）
// AI 用 terminal(command/cmd) 调用，用户可在对话里直接下 shell 指令
function runTerminalCommand(args) {
  args = args || {}
  var cmd = String(args.command != null ? args.command : args.cmd != null ? args.cmd : '').trim()
  if (!cmd) {
    return Promise.resolve(JSON.stringify({ success: false, message: '缺少要执行的命令 command' }))
  }
  return new Promise(function(resolve) {
    var stepRunner = runner.buildStepRunner()
    stepRunner('exec_shell', { cmd: cmd, command: cmd }, null).then(function(r) {
      if (r && r.success) {
        resolve(JSON.stringify({ success: true, command: cmd, result: r.result || '执行成功', message: '执行成功' }))
      } else {
        resolve(JSON.stringify({ success: false, command: cmd, error: (r && r.error) || '执行失败', message: (r && r.error) || '执行失败' }))
      }
    }).catch(function(e) {
      resolve(JSON.stringify({ success: false, command: cmd, error: String((e && e.message) || e), message: String((e && e.message) || e) }))
    })
  })
}

// ===== 工具定义（喂给模型的 schema） =====

var ACTION_HINT = [
  'delay(毫秒ms)、get_time(当前时间)、http_request(url,method,body)',
  'send_message(text消息内容, prompt可选:填了就用AI按提示词生成内容再发送, aiName可填: 接收AI的识别码(8位数字,在该AI的聊天设置页可复制)。注意: 若用户要求"让某AI发消息给另一AI"，必须去查该AI的识别码填入aiName，绝对不能留空或随机)',
  'readScreen(读取屏幕)、click(x,y)、clickByText(text)、swipe(sx,sy,ex,ey,duration)、inputText(text)、long_press(x,y)、press_key(key_code:4返回/3主页)',
  'lockScreen、getAppUsage(ms)、getTodayAppUsage、lockApp(pkg)、unlockApp(pkg)、pressBack、pressHome',
  'start_app(package_name,activity可选): 打开应用，无需任何权限！package_name 可直接填中文名如"抖音""微信"，系统会自动解析为包名',
  'stop_app(package_name): 停止应用(需Shizuku)、is_app_installed(package_name)、get_foreground_app(当前前台应用)',
  'send_notification(title,message): 发通知栏提醒、toast(message): 屏幕提示、device_info(设备信息)',
  'exec_shell(cmd): 通过 Shizuku 或 root 执行 shell 命令，如 pm suspend 包名 锁定应用。注意：打开App严禁用 exec_shell/am start，必须用 start_app(免权限)'
].join('；')

var NODE_SCHEMA_HINT = [
  'nodes 是节点数组，每项形如:',
  '{id:"唯一id", type:"trigger|execute|condition|logic|extract", name:"名称", position:{x,y}, 及类型特有字段}',
  'trigger: {type:"trigger", triggerType:"manual"}',
  'execute: {type:"execute", actionType:"动作名", actionConfig:{参数名:{type:"static",value:"值"}或{type:"ref",nodeId:"节点id"}}}',
  'condition: {type:"condition", left:{type:"static",value:"值"}, operator:"EQ|NE|GT|GTE|LT|LTE|CONTAINS|NOT_CONTAINS|IN|NOT_IN", right:{...}}',
  'logic: {type:"logic", operator:"AND|OR"}',
  'extract: {type:"extract", source:{...}, mode:"REGEX|JSON|SUB|CONCAT|RANDOM_INT|RANDOM_STRING", expression:"正则或JSON路径", group:0, defaultValue:""}',
  'connections 是连线数组: {sourceNodeId, targetNodeId, condition:"on_success|on_error|true|false|正则"}',
  '每个 execute 节点需要 actionConfig 参数，参数名见动作列表；要引用某节点输出用 {type:"ref",nodeId:"该节点id"}'
].join('\n')

var TOOL_DEFINITIONS = [
  {
    name: 'terminal',
    description: '终端执行器：在手机上执行任意 shell 命令（需要 Shizuku 或 root 授权）。适合用户要求"执行xx命令/终端/改系统设置/查目录文件"时使用。参数 command（或 cmd）为要执行的命令字符串。注意：打开 App 请用 phone_control 的 start_app，不要用 am start。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令，如 ls、dumpsys battery、pm list packages 等' },
        cmd: { type: 'string', description: '同 command，二者任填其一' }
      },
      required: ['command']
    }
  },
  {
    name: 'phone_control',
    description: '直接执行一次手机操作，立即生效，不需要创建/保存工作流。用户要求打开某个App、读取屏幕、点击、滑动、输入、发通知等一次性操作时，一律优先调用本工具直接完成，绝对不要为一次性操作创建 workflow。可用 action: ' + PHONE_CONTROL_HINT + '。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '要执行的动作名，如 start_app / read_screen / click / swipe / input_text / send_notification / toast 等' },
        params: { type: 'object', description: '动作参数对象：{参数名: 值}。如 start_app 传 {package_name: "抖音"}；click 传 {x: 500, y: 800}；send_notification 传 {title: "标题", message: "内容"}' }
      },
      required: ['action']
    }
  },
  {
    name: 'create_workflow',
    description: '创建一个自动化工作流（仅当用户明确要求"创建/保存/设置一个自动化、定时任务、多步骤流程"时才用；一次性操作如打开App、读取屏幕、点击等请用 phone_control 直接执行，不要创建 workflow）。必须调用本工具才能真正创建工作流，绝对不能只在回复里说"已创建"而不调用本工具；只有本工具返回成功后工作流才算真的创建好。推荐用 steps 简化参数（见 steps 说明），无需生成复杂的节点 JSON。可用动作: ' + ACTION_HINT + '。若用高级模式 nodes/connections，' + NODE_SCHEMA_HINT + '。至少包含一个 trigger 节点。创建本身不需要任何权限：原生动作（readScreen/click 等）执行时若缺少权限会自动失败并返回具体错误，因此不要向用户询问"是否可以使用权限"，直接调用本工具创建即可。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工作流名称，简短清晰' },
        description: { type: 'string', description: '工作流用途说明' },
        steps: {
          type: 'array',
          description: '简化步骤（推荐）：按执行顺序排列的动作数组，每项 {action: 动作名, name?: 步骤名, params?: {参数名: 值}}。示例：[{action:"delay",params:{ms:"1000"}},{action:"get_time"}]。提供 steps 时无需再传 nodes/connections。',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: '动作名' },
              name: { type: 'string', description: '步骤显示名（可选）' },
              params: { type: 'object', description: '动作参数：{参数名: 值}' }
            },
            required: ['action']
          }
        },
        nodes: { type: 'array', description: '高级模式：完整节点数组（见工具描述中的节点格式）' },
        connections: { type: 'array', description: '高级模式：完整连线数组' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' }
      },
      required: ['name']
    }
  },
  {
    name: 'list_workflows',
    description: '列出所有工作流，返回名称、启停状态、节点数、执行次数。用户询问有哪些工作流时使用。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'trigger_workflow',
    description: '立即执行一个已存在的工作流。用户要求执行某个工作流时使用。执行本身不需要询问权限，执行结果会返回每个节点的状态；原生动作若缺权限会自动失败并返回具体错误。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流 id' },
        name: { type: 'string', description: '工作流名称' }
      },
      required: []
    }
  },
  {
    name: 'delete_workflow',
    description: '删除一个工作流。用户要求删除某个工作流时使用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流 id' },
        name: { type: 'string', description: '工作流名称' }
      },
      required: []
    }
  },
  {
    name: 'get_workflow',
    description: '获取单个工作流的完整详情（包含 nodes/connections 与执行统计）。用户需要查看工作流结构、统计信息或需要后续修改时使用。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '工作流 id' },
        name: { type: 'string', description: '工作流名称（与 workflow_id 二选一）' }
      },
      required: []
    }
  },
  {
    name: 'update_workflow',
    description: '整体覆盖更新一个工作流（覆盖 name/description/enabled/nodes/connections）。会做循环依赖与节点引用校验，不通过则失败。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '要更新的工作流 id（必填）' },
        name: { type: 'string', description: '新的工作流名称（可选）' },
        description: { type: 'string', description: '新的描述（可选）' },
        enabled: { type: 'boolean', description: '启用/停用（可选）' },
        nodes: { type: 'array', description: '完整节点数组（见 create_workflow 描述中的节点 schema）' },
        connections: { type: 'array', description: '完整连线数组' }
      },
      required: ['workflow_id']
    }
  },
  {
    name: 'patch_workflow',
    description: '增量更新工作流：通过 add/update/remove 操作对 nodes/connections 进行部分变更，无需重传完整数据。每次操作后会校验循环依赖。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '要 patch 的工作流 id（必填）' },
        name: { type: 'string', description: '新的名称（可选）' },
        description: { type: 'string', description: '新的描述（可选）' },
        enabled: { type: 'boolean', description: '启用/停用（可选）' },
        node_patches: {
          type: 'array',
          description: '节点变更列表。每项形如 {op:"add|update|remove", id?"节点id", node?"完整节点对象"}。add 必须带 node，update 需要 id 或 node.id，remove 需要 id。',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', description: 'add/update/remove' },
              id: { type: 'string', description: '操作的节点 id（update/remove 用，add 不需要）' },
              node: { type: 'object', description: '节点对象（add/update 用，schema 见 create_workflow）' }
            },
            required: ['op']
          }
        },
        connection_patches: {
          type: 'array',
          description: '连线变更列表。每项形如 {op:"add|update|remove", id?"连线id", connection?"完整连线对象"}。',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', description: 'add/update/remove' },
              id: { type: 'string', description: '连线 id（update/remove 用）' },
              connection: { type: 'object', description: '连线对象：{sourceNodeId,targetNodeId,condition?}' }
            },
            required: ['op']
          }
        }
      },
      required: ['workflow_id']
    }
  },
  {
    name: 'enable_workflow',
    description: '启用一个工作流（设置 enabled=true）。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '工作流 id' },
        name: { type: 'string', description: '工作流名称（与 workflow_id 二选一）' }
      },
      required: []
    }
  },
  {
    name: 'disable_workflow',
    description: '停用一个工作流（设置 enabled=false）。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '工作流 id' },
        name: { type: 'string', description: '工作流名称（与 workflow_id 二选一）' }
      },
      required: []
    }
  }
]

export default {
  TOOL_DEFINITIONS: TOOL_DEFINITIONS,
  isWorkflowTool: isWorkflowTool,
  isPhoneControlTool: isPhoneControlTool,
  isSensitivePhoneAction: isSensitivePhoneAction,
  execute: execute,
  runTerminalCommand: runTerminalCommand,
  createWorkflow: createWorkflow,
  listWorkflows: listWorkflows,
  getWorkflow: getWorkflow,
  updateWorkflow: updateWorkflow,
  patchWorkflow: patchWorkflow,
  enableWorkflow: enableWorkflow,
  disableWorkflow: disableWorkflow,
  deleteWorkflow: deleteWorkflow,
  triggerWorkflow: triggerWorkflow
}
