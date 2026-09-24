/**
 * workflow-engine.js — 工作流 DAG 执行引擎
 *
 * 节点类型：
 *   trigger  触发节点（manual / schedule）
 *   execute  执行节点（actionType + actionConfig，参数支持静态值或节点引用）
 *   condition 条件节点（left/operator/right 比较，输出 true/false）
 *   logic    逻辑节点（AND/OR 合并多个输入）
 *   extract  提取节点（REGEX/JSON/SUB/CONCAT/RANDOM_INT/RANDOM_STRING）
 *
 * 连线条件（字符串关键字）：
 *   '' 或 on_success 成功才走；on_error/error/failed 失败才走；
 *   true/false 按布尔值匹配；其他字符串按正则匹配。
 *
 * 参数值结构：{ type: 'static', value } 静态值 | { type: 'ref', nodeId } 引用节点输出
 * 引用关系会自动加入依赖图（隐式数据流）。
 */

var NODE_TYPES = {
  TRIGGER: 'trigger',
  EXECUTE: 'execute',
  CONDITION: 'condition',
  LOGIC: 'logic',
  EXTRACT: 'extract'
}

var CONDITION_OPERATORS = ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'CONTAINS', 'NOT_CONTAINS', 'IN', 'NOT_IN']
var LOGIC_OPERATORS = ['AND', 'OR']
var EXTRACT_MODES = ['REGEX', 'JSON', 'SUB', 'CONCAT', 'RANDOM_INT', 'RANDOM_STRING']
var TRIGGER_TYPES = ['manual', 'schedule']

function makeNodeId() {
  return 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function makeConnId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/**
 * 创建指定类型的默认节点
 */
function createNode(type) {
  var base = {
    id: makeNodeId(),
    type: type,
    name: '',
    description: '',
    position: { x: 40, y: 120 }
  }
  switch (type) {
    case NODE_TYPES.TRIGGER:
      return Object.assign(base, {
        triggerType: 'manual',
        triggerConfig: {
          schedule_type: 'interval',
          interval_ms: '900000',
          specific_time: '',
          cron_expression: '',
          repeat: 'true',
          enabled: 'true',
          command: '',
          action: '',
          pattern: '',
          ignore_case: 'true',
          require_final: 'true',
          cooldown_ms: '3000'
        }
      })
    case NODE_TYPES.EXECUTE:
      return Object.assign(base, { actionType: '', actionConfig: {}, jsCode: '' })
    case NODE_TYPES.CONDITION:
      return Object.assign(base, { left: { type: 'static', value: '' }, operator: 'EQ', right: { type: 'static', value: '' } })
    case NODE_TYPES.LOGIC:
      return Object.assign(base, { operator: 'AND' })
    case NODE_TYPES.EXTRACT:
      return Object.assign(base, {
        source: { type: 'static', value: '' },
        mode: 'REGEX',
        expression: '',
        group: 0,
        defaultValue: '',
        others: [],
        startIndex: 0,
        length: -1,
        randomMin: 0,
        randomMax: 100,
        randomStringLength: 8,
        randomStringCharset: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        useFixed: false,
        fixedValue: ''
      })
  }
  return null
}

// ===== 参数引用兼容：支持多种简写格式 =====
function normalizeParameterValue(pv) {
  if (pv === null || pv === undefined) return { type: 'static', value: '' }
  // 已经是标准格式
  if (typeof pv === 'object' && pv.type) return pv
  // 简写格式：{ nodeId: 'xxx' } 或 { ref: 'xxx' } 或 { refNodeId: 'xxx' }
  if (typeof pv === 'object') {
    var nid = pv.nodeId || pv.ref || pv.refNodeId
    if (nid) return { type: 'ref', nodeId: String(nid) }
    if (pv.value !== undefined) return { type: 'static', value: String(pv.value) }
    return { type: 'static', value: '' }
  }
  // 字符串/数字/布尔直接当作静态值
  return { type: 'static', value: String(pv) }
}

// ===== 参数与比较 =====

function resolveParameterValue(pv, nodeResults) {
  var n = normalizeParameterValue(pv)
  if (n.type === 'ref') {
    var st = nodeResults[n.nodeId]
    if (!st) throw new Error('引用的节点尚未执行: ' + n.nodeId)
    if (st.status === 'success') return st.result == null ? '' : String(st.result)
    if (st.status === 'skipped') return ''
    if (st.status === 'failed') throw new Error('引用的节点执行失败: ' + (st.error || n.nodeId))
    throw new Error('引用的节点尚未完成: ' + n.nodeId)
  }
  return String(n.value == null ? '' : n.value)
}

function parseDoubleOrNull(v) {
  var t = String(v == null ? '' : v).trim()
  if (t === '') return null
  var n = Number(t)
  return isNaN(n) ? null : n
}

function compareValues(leftRaw, rightRaw, operator) {
  var left = String(leftRaw == null ? '' : leftRaw)
  var right = String(rightRaw == null ? '' : rightRaw)
  var ln = parseDoubleOrNull(left)
  var rn = parseDoubleOrNull(right)

  function mismatch() {
    throw new Error('条件两侧类型不一致: ' + left + ' vs ' + right)
  }

  switch (operator) {
    case 'EQ':
      if (ln !== null && rn !== null) return ln === rn
      if (ln !== null || rn !== null) mismatch()
      return left === right
    case 'NE':
      if (ln !== null && rn !== null) return ln !== rn
      if (ln !== null || rn !== null) mismatch()
      return left !== right
    case 'GT':
      if (ln !== null && rn !== null) return ln > rn
      mismatch()
      return left > right
    case 'GTE':
      if (ln !== null && rn !== null) return ln >= rn
      mismatch()
      return left >= right
    case 'LT':
      if (ln !== null && rn !== null) return ln < rn
      mismatch()
      return left < right
    case 'LTE':
      if (ln !== null && rn !== null) return ln <= rn
      mismatch()
      return left <= right
    case 'CONTAINS':
      return left.indexOf(right) > -1
    case 'NOT_CONTAINS':
      return left.indexOf(right) === -1
    case 'IN':
    case 'NOT_IN': {
      var items = []
      try {
        var arr = JSON.parse(right)
        if (Array.isArray(arr)) items = arr.map(function(x) { return String(x) })
      } catch (e) {}
      if (items.length === 0) items = right.split(',').map(function(s) { return s.trim() }).filter(function(s) { return s !== '' })
      var contains = false
      if (items.length > 0) {
        var leftNum = parseDoubleOrNull(left)
        var itemNums = items.map(function(it) { return parseDoubleOrNull(it) })
        var listAllNum = itemNums.every(function(nn) { return nn !== null })
        var listAllStr = itemNums.every(function(nn) { return nn === null })
        if (!listAllNum && !listAllStr) {
          throw new Error('条件 IN 列表元素类型不一致: ' + right)
        }
        if (listAllNum) {
          if (leftNum === null) throw new Error('条件两侧类型不一致: ' + left + ' vs ' + right)
          contains = itemNums.some(function(nn) { return nn === leftNum })
        } else {
          if (leftNum !== null) throw new Error('条件两侧类型不一致: ' + left + ' vs ' + right)
          contains = items.indexOf(left) > -1
        }
      }
      return operator === 'IN' ? contains : !contains
    }
  }
  return false
}

// ===== 提取节点 =====

function extractByRegex(source, pattern, group, defaultValue) {
  if (!pattern) return defaultValue
  try {
    var re = new RegExp(pattern)
    var m = re.exec(String(source))
    var g = parseInt(group, 10) || 0
    if (m && m[g] !== undefined) return m[g]
    return defaultValue
  } catch (e) {
    return defaultValue
  }
}

function extractByJsonPath(source, path, defaultValue) {
  if (!path) return defaultValue
  var root = null
  var trimmed = String(source).trim()
  if (!trimmed) return defaultValue
  try {
    root = JSON.parse(trimmed)
  } catch (e) {
    return defaultValue
  }

  function readIndexToken(token) {
    var name = token.split('[')[0] || ''
    var indexes = []
    var rest = token.slice(token.indexOf('['))
    var m
    var re = /\[(\d+)\]/g
    while ((m = re.exec(rest)) !== null) indexes.push(parseInt(m[1], 10))
    return { name: name, indexes: indexes }
  }

  function getChild(cur, name) {
    if (cur === null || typeof cur !== 'object') return null
    if (Array.isArray(cur)) return null
    if (name === '') return cur
    return cur[name] !== undefined ? cur[name] : null
  }

  function getIndex(cur, idx) {
    if (Array.isArray(cur) && idx >= 0 && idx < cur.length) return cur[idx]
    return null
  }

  var current = root
  var segments = path.split('.').map(function(s) { return s.trim() }).filter(function(s) { return s !== '' })
  for (var i = 0; i < segments.length; i++) {
    var tk = readIndexToken(segments[i])
    if (tk.name) current = getChild(current, tk.name)
    for (var j = 0; j < tk.indexes.length; j++) {
      current = getIndex(current, tk.indexes[j])
      if (current === null || current === undefined) return defaultValue
    }
    if (current === null || current === undefined) return defaultValue
  }
  if (current === null || current === undefined) return defaultValue
  return typeof current === 'object' ? JSON.stringify(current) : String(current)
}

function substringByIndex(source, startIndex, length, defaultValue) {
  var s = String(source == null ? '' : source)
  var start = parseInt(startIndex, 10) || 0
  var len = parseInt(length, 10)
  if (s === '') return defaultValue
  if (start < 0 || start > s.length) return defaultValue
  var end = (isNaN(len) || len < 0) ? s.length : Math.min(start + len, s.length)
  if (end < start) return defaultValue
  return s.slice(start, end)
}

function randomInt(minValue, maxValue) {
  var low = Math.min(minValue, maxValue)
  var high = Math.max(minValue, maxValue)
  if (low === high) return low
  return Math.floor(Math.random() * (high - low + 1)) + low
}

function randomString(length, charset) {
  var n = parseInt(length, 10) || 0
  if (n <= 0) return ''
  var cs = charset || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  var out = ''
  for (var i = 0; i < n; i++) out += cs.charAt(Math.floor(Math.random() * cs.length))
  return out
}

function runExtract(node, sourceText, nodeResults) {
  var defaultValue = node.defaultValue == null ? '' : String(node.defaultValue)
  switch (node.mode) {
    case 'REGEX':
      return extractByRegex(sourceText, node.expression, node.group, defaultValue)
    case 'JSON':
      return extractByJsonPath(sourceText, node.expression, defaultValue)
    case 'SUB':
      return substringByIndex(sourceText, node.startIndex, node.length, defaultValue)
    case 'CONCAT': {
      var parts = [sourceText]
      if (node.concatValue != null) parts.push(String(node.concatValue))
      ;(node.others || []).forEach(function(o) { parts.push(resolveParameterValue(o, nodeResults)) })
      return parts.join('')
    }
    case 'RANDOM_INT':
      if (node.useFixed) return String(node.fixedValue == null ? '' : node.fixedValue)
      return String(randomInt(parseInt(node.randomMin, 10) || 0, parseInt(node.randomMax, 10) || 100))
    case 'RANDOM_STRING':
      if (node.useFixed) return String(node.fixedValue == null ? '' : node.fixedValue)
      return randomString(node.randomStringLength, node.randomStringCharset)
  }
  return defaultValue
}

// ===== 依赖图 =====

function buildReferenceDependencies(workflow) {
  var nodeIdSet = {}
  workflow.nodes.forEach(function(n) { nodeIdSet[n.id] = true })
  var deps = []
  var seen = {}
  function addDep(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return
    if (!nodeIdSet[sourceId] || !nodeIdSet[targetId]) return
    var key = sourceId + '>' + targetId
    if (seen[key]) return
    seen[key] = true
    deps.push({ sourceNodeId: sourceId, targetNodeId: targetId })
  }
  workflow.nodes.forEach(function(node) {
    if (node.type === NODE_TYPES.EXECUTE) {
      var cfg = node.actionConfig || {}
      Object.keys(cfg).forEach(function(k) {
        var pv = normalizeParameterValue(cfg[k])
        if (pv.type === 'ref') addDep(pv.nodeId, node.id)
      })
    } else if (node.type === NODE_TYPES.CONDITION) {
      var ln = normalizeParameterValue(node.left)
      if (ln.type === 'ref') addDep(ln.nodeId, node.id)
      var rn = normalizeParameterValue(node.right)
      if (rn.type === 'ref') addDep(rn.nodeId, node.id)
    } else if (node.type === NODE_TYPES.EXTRACT) {
      var sn = normalizeParameterValue(node.source)
      if (sn.type === 'ref') addDep(sn.nodeId, node.id)
      ;(node.others || []).forEach(function(o) {
        var on = normalizeParameterValue(o)
        if (on.type === 'ref') addDep(on.nodeId, node.id)
      })
    }
  })
  return deps
}

function buildDependencyGraph(workflow) {
  var adjacencyList = {}
  var inDegree = {}
  workflow.nodes.forEach(function(n) {
    adjacencyList[n.id] = []
    inDegree[n.id] = 0
  })
  function addEdge(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return
    var targets = adjacencyList[sourceId]
    if (!targets) return
    if (targets.indexOf(targetId) > -1) return
    targets.push(targetId)
    if (inDegree[targetId] === undefined) inDegree[targetId] = 0
    inDegree[targetId]++
  }
  ;(workflow.connections || []).forEach(function(c) {
    addEdge(c.sourceNodeId, c.targetNodeId)
  })
  buildReferenceDependencies(workflow).forEach(function(d) {
    addEdge(d.sourceNodeId, d.targetNodeId)
  })
  return { adjacencyList: adjacencyList, inDegree: inDegree }
}

function detectCycle(adjacencyList, nodes) {
  var visitState = {}
  nodes.forEach(function(n) { visitState[n.id] = 0 })
  function dfs(nodeId) {
    visitState[nodeId] = 1
    var nexts = adjacencyList[nodeId] || []
    for (var i = 0; i < nexts.length; i++) {
      var next = nexts[i]
      if (visitState[next] === 1) return true
      if (visitState[next] === 0 && dfs(next)) return true
    }
    visitState[nodeId] = 2
    return false
  }
  for (var j = 0; j < nodes.length; j++) {
    if (visitState[nodes[j].id] === 0 && dfs(nodes[j].id)) return true
  }
  return false
}

function getReachableNodeIds(startNodeIds, adjacencyList) {
  var forward = {}
  var fq = []
  startNodeIds.forEach(function(id) {
    if (!forward[id]) { forward[id] = true; fq.push(id) }
  })
  while (fq.length) {
    var cur = fq.shift()
    ;(adjacencyList[cur] || []).forEach(function(nx) {
      if (!forward[nx]) { forward[nx] = true; fq.push(nx) }
    })
  }

  var reverse = {}
  Object.keys(adjacencyList).forEach(function(src) {
    ;(adjacencyList[src] || []).forEach(function(tgt) {
      if (!reverse[tgt]) reverse[tgt] = []
      reverse[tgt].push(src)
    })
  })

  var visited = Object.assign({}, forward)
  var q = []
  Object.keys(forward).forEach(function(id) { q.push(id) })
  while (q.length) {
    var c = q.shift()
    ;(reverse[c] || []).forEach(function(prev) {
      if (!visited[prev]) { visited[prev] = true; q.push(prev) }
    })
  }
  return Object.keys(visited)
}

// ===== 条件匹配（连线） =====

function isSkippedState(state) {
  return state && state.status === 'skipped'
}

function parseBooleanLike(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === 'off') return false
  return null
}

function connectionMatches(conn, sourceNode, sourceState, nodeResults) {
  if (isSkippedState(sourceState)) return false

  var raw = (conn.condition || '').trim()
  var effective = raw
  if (raw === '' && (sourceNode.type === NODE_TYPES.CONDITION || sourceNode.type === NODE_TYPES.LOGIC)) {
    effective = 'true'
  }
  var key = effective.trim().toLowerCase()
  if (key === 'error' || key === 'failed' || key === 'on_error') return sourceState.status === 'failed'
  if (key === 'success' || key === 'ok' || key === 'on_success') return sourceState.status === 'success'
  if (effective.trim() === '') return sourceState.status === 'success'

  var desired = parseBooleanLike(effective)
  if (desired !== null) {
    if (sourceState.status !== 'success') return false
    var actual = parseBooleanLike(sourceState.result)
    return actual !== null && actual === desired
  }

  if (sourceState.status !== 'success') return false
  try {
    var re = new RegExp(effective)
    return re.test(String(sourceState.result == null ? '' : sourceState.result))
  } catch (e) {
    return false
  }
}

// ===== 节点执行 =====

function executeConditionNode(node, nodeResults) {
  var left = resolveParameterValue(node.left, nodeResults)
  var right = resolveParameterValue(node.right, nodeResults)
  var ok = compareValues(left, right, node.operator)
  return String(ok)
}

function executeLogicNode(node, nodeResults, incomingConnections) {
  var inputs = []
  incomingConnections.forEach(function(conn) {
    var st = nodeResults[conn.sourceNodeId]
    if (!st || isSkippedState(st)) return
    if (st.status !== 'success') return
    var b = parseBooleanLike(st.result)
    if (b !== null) inputs.push(b)
  })
  var ok = node.operator === 'AND' ? (inputs.length > 0 && inputs.every(function(b) { return b })) : inputs.some(function(b) { return b })
  return String(ok)
}

function executeExtractNode(node, nodeResults, incomingConnections) {
  var sourceText = ''
  if (node.mode !== 'RANDOM_INT' && node.mode !== 'RANDOM_STRING') {
    sourceText = resolveParameterValue(node.source, nodeResults)
    if (sourceText === '' && node.source && node.source.type === 'static') {
      var first = incomingConnections[0]
      if (first) {
        var fst = nodeResults[first.sourceNodeId]
        if (fst && fst.status === 'success' && !isSkippedState(fst)) sourceText = String(fst.result == null ? '' : fst.result)
      }
    }
  }
  return runExtract(node, sourceText, nodeResults)
}

// ===== 默认步骤执行器（纯 JS 步骤） =====

var JS_ACTIONS = ['delay', 'http_request', 'get_time']

function defaultStepRunner(actionType, params) {
  return new Promise(function(resolve) {
    if (actionType === 'delay') {
      var ms = parseInt(params.ms, 10) || 0
      setTimeout(function() {
        resolve({ success: true, result: '延时 ' + ms + 'ms' })
      }, ms)
      return
    }
    if (actionType === 'get_time') {
      var d = new Date()
      var txt = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
        ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
      resolve({ success: true, result: txt })
      return
    }
    if (actionType === 'http_request') {
      var url = (params.url || '').trim()
      if (!url) { resolve({ success: false, error: '缺少 URL 参数' }); return }
      var method = (params.method || 'GET').toUpperCase()
      var header = { 'Content-Type': 'application/json' }
      var body = params.body || ''
      uni.request({
        url: url,
        method: method,
        header: header,
        data: body ? JSON.parse(body) : undefined,
        success: function(res) {
          var data = res.data
          var text = typeof data === 'string' ? data : JSON.stringify(data)
          resolve({ success: true, result: text })
        },
        fail: function(err) {
          resolve({ success: false, error: (err && err.errMsg) || '请求失败' })
        }
      })
      return
    }
    resolve({ success: false, error: '未知的 JS 动作: ' + actionType })
  })
}

// ===== 主执行入口 =====

/**
 * 执行工作流
 * @param workflow 工作流对象
 * @param options { triggerNodeId, triggerExtras, stepRunner(actionType, params, node), onNodeStateChange(nodeId, state) }
 * @returns Promise<{ success, message, nodeResults }>
 */
function executeWorkflow(workflow, options) {
  options = options || {}
  var stepRunner = options.stepRunner || defaultStepRunner
  var onNodeStateChange = options.onNodeStateChange || function() {}
  var triggerExtras = options.triggerExtras || {}
  var nodeResults = {}

  function setState(nodeId, state) {
    nodeResults[nodeId] = state
    try { onNodeStateChange(nodeId, state) } catch (e) {}
  }

  function fail(msg) {
    return { success: false, message: msg, nodeResults: nodeResults }
  }

  return new Promise(function(resolve) {
    try {
      var allTriggers = workflow.nodes.filter(function(n) { return n.type === NODE_TYPES.TRIGGER })
      if (allTriggers.length === 0) { resolve(fail('工作流没有触发节点，无法执行')); return }

      var triggers
      if (options.triggerNodeId) {
        var sp = allTriggers.filter(function(n) { return n.id === options.triggerNodeId })[0]
        if (!sp) { resolve(fail('指定的触发节点不存在')); return }
        triggers = [sp]
      } else {
        var manual = allTriggers.filter(function(n) { return n.triggerType === 'manual' })
        if (manual.length === 0) { resolve(fail('没有手动触发节点')); return }
        triggers = manual
      }

      var graph = buildDependencyGraph(workflow)
      if (detectCycle(graph.adjacencyList, workflow.nodes)) {
        resolve(fail('工作流存在循环依赖，无法执行'))
        return
      }

      triggers.forEach(function(t) {
        var payload = JSON.stringify(triggerExtras)
        setState(t.id, { status: 'success', result: payload })
      })

      executeTopologicalOrder(workflow, graph, triggers.map(function(t) { return t.id }), setState, stepRunner, nodeResults).then(function(ok) {
        if (!ok) {
          var unhandled = hasUnhandledFailure(workflow, nodeResults)
          resolve(fail(unhandled || '工作流执行失败'))
          return
        }
        resolve({ success: true, message: '工作流执行成功', nodeResults: nodeResults })
      }).catch(function(e) {
        resolve(fail('工作流执行异常: ' + e.message))
      })
    } catch (e) {
      resolve(fail('工作流执行异常: ' + e.message))
    }
  })
}

function hasUnhandledFailure(workflow, nodeResults) {
  var outgoing = {}
  ;(workflow.connections || []).forEach(function(c) {
    if (!outgoing[c.sourceNodeId]) outgoing[c.sourceNodeId] = []
    outgoing[c.sourceNodeId].push(c)
  })
  function isErrorCondition(cond) {
    var c = (cond || '').trim().toLowerCase()
    return c === 'error' || c === 'failed' || c === 'on_error'
  }
  var bad = []
  Object.keys(nodeResults).forEach(function(nodeId) {
    var st = nodeResults[nodeId]
    if (st.status !== 'failed') return
    var conns = outgoing[nodeId] || []
    var handled = conns.some(function(c) {
      return isErrorCondition(c.condition) && nodeResults[c.targetNodeId] && nodeResults[c.targetNodeId].status === 'success'
    })
    if (!handled) bad.push(nodeId)
  })
  if (bad.length === 0) return ''
  return '有失败节点未被 on_error 分支处理: ' + bad.join(', ')
}

async function executeTopologicalOrder(workflow, graph, startNodeIds, setState, stepRunner, nodeResults) {
  var adjacencyList = graph.adjacencyList
  var reachable = getReachableNodeIds(startNodeIds, adjacencyList)
  var nodeById = {}
  workflow.nodes.forEach(function(n) { nodeById[n.id] = n })
  var incomingByTarget = {}
  ;(workflow.connections || []).forEach(function(c) {
    if (!incomingByTarget[c.targetNodeId]) incomingByTarget[c.targetNodeId] = []
    incomingByTarget[c.targetNodeId].push(c)
  })
  var triggerIds = {}
  workflow.nodes.forEach(function(n) { if (n.type === NODE_TYPES.TRIGGER) triggerIds[n.id] = true })
  var startedTriggers = {}
  startNodeIds.forEach(function(id) { startedTriggers[id] = true })

  var currentInDegree = {}
  reachable.forEach(function(id) {
    if (triggerIds[id]) return
    currentInDegree[id] = 0
  })

  Object.keys(adjacencyList).forEach(function(src) {
    if (reachable.indexOf(src) === -1) return
    if (triggerIds[src]) return
    ;(adjacencyList[src] || []).forEach(function(tgt) {
      if (reachable.indexOf(tgt) === -1) return
      if (triggerIds[tgt]) return
      currentInDegree[tgt] = (currentInDegree[tgt] || 0) + 1
    })
  })

  var queue = []
  Object.keys(currentInDegree).forEach(function(id) {
    if (currentInDegree[id] === 0) queue.push(id)
  })

  var hasFailure = false

  while (queue.length > 0) {
    var currentNodeId = queue.shift()
    if (nodeResults[currentNodeId]) continue

    var node = nodeById[currentNodeId]
    if (!node) continue

    var incoming = (incomingByTarget[currentNodeId] || []).filter(function(conn) {
      if (reachable.indexOf(conn.sourceNodeId) === -1) return false
      if (triggerIds[conn.sourceNodeId] && !startedTriggers[conn.sourceNodeId]) return false
      return true
    })

    var shouldExecute
    if (incoming.length === 0) {
      shouldExecute = true
    } else {
      shouldExecute = incoming.some(function(conn) {
        var srcNode = nodeById[conn.sourceNodeId]
        var srcState = nodeResults[conn.sourceNodeId]
        if (!srcState) return false
        return connectionMatches(conn, srcNode, srcState, nodeResults)
      })
    }

    if (!shouldExecute) {
      setState(node.id, { status: 'skipped', result: '', reason: '条件不满足，已跳过' })
      decSuccessors(currentNodeId)
      continue
    }

    var ok = await executeNode(node, incoming, setState, stepRunner, nodeResults)
    if (!ok) hasFailure = true

    decSuccessors(currentNodeId)
  }

  function decSuccessors(nodeId) {
    ;(adjacencyList[nodeId] || []).forEach(function(next) {
      if (currentInDegree[next] === undefined) return
      currentInDegree[next]--
      if (currentInDegree[next] === 0) queue.push(next)
    })
  }

  if (!hasFailure) return true
  return !hasUnhandledFailure(workflow, nodeResults)
}

async function executeNode(node, incomingConnections, setState, stepRunner, nodeResults) {
  try {
    if (node.type === NODE_TYPES.TRIGGER) {
      setState(node.id, { status: 'success', result: '{}' })
      return true
    }

    setState(node.id, { status: 'running' })

    var result
    if (node.type === NODE_TYPES.CONDITION) {
      result = executeConditionNode(node, nodeResults)
      setState(node.id, { status: 'success', result: result })
      return true
    }
    if (node.type === NODE_TYPES.LOGIC) {
      result = executeLogicNode(node, nodeResults, incomingConnections)
      setState(node.id, { status: 'success', result: result })
      return true
    }
    if (node.type === NODE_TYPES.EXTRACT) {
      result = executeExtractNode(node, nodeResults, incomingConnections)
      setState(node.id, { status: 'success', result: result })
      return true
    }
    if (node.type === NODE_TYPES.EXECUTE) {
      if (!node.actionType) {
        setState(node.id, { status: 'failed', error: '执行节点未设置动作' })
        return false
      }
      var params = {}
      var cfg = node.actionConfig || {}
      Object.keys(cfg).forEach(function(k) {
        params[k] = resolveParameterValue(cfg[k], nodeResults)
      })
      var r = await stepRunner(node.actionType, params, node)
      if (r && r.success) {
        setState(node.id, { status: 'success', result: r.result == null ? '' : String(r.result) })
        return true
      }
      setState(node.id, { status: 'failed', error: (r && r.error) || '执行失败' })
      return false
    }

    setState(node.id, { status: 'skipped', result: '', reason: '未知节点类型' })
    return true
  } catch (e) {
    setState(node.id, { status: 'failed', error: e.message })
    return false
  }
}

export default {
  NODE_TYPES: NODE_TYPES,
  CONDITION_OPERATORS: CONDITION_OPERATORS,
  LOGIC_OPERATORS: LOGIC_OPERATORS,
  EXTRACT_MODES: EXTRACT_MODES,
  TRIGGER_TYPES: TRIGGER_TYPES,
  JS_ACTIONS: JS_ACTIONS,
  makeNodeId: makeNodeId,
  makeConnId: makeConnId,
  createNode: createNode,
  executeWorkflow: executeWorkflow,
  buildDependencyGraph: buildDependencyGraph,
  detectCycle: detectCycle,
  defaultStepRunner: defaultStepRunner,
  compareValues: compareValues,
  resolveParameterValue: resolveParameterValue,
  connectionMatches: connectionMatches,
  normalizeParameterValue: normalizeParameterValue
}
