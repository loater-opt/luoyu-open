/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * 本文件由工程内源码同步而来（同步工具：build-open-package.js），
 * 只改写了模块引用路径，未改动任何业务逻辑。
 */
// =====================================================================
// 一、对外枚举（取值就是数据格式，不可改）
// =====================================================================

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
var JS_ACTIONS = ['delay', 'http_request', 'get_time']

// =====================================================================
// 二、通用小工具
// =====================================================================

function noop() {}

/** 只认自有属性：避免 'constructor' / 'toString' 这类键命中 Object 原型 */
function own(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key)
}

function pick(table, key) {
  return own(table, key) ? table[key] : null
}

/**
 * 用节点 id 当 key 的表一律用无原型对象建：id 是外部数据里的字符串，万一有人把节点命名成
 * 'constructor' / 'toString'，普通对象会从 Object.prototype 上"继承"出一个真值，把不存在的
 * 节点当成存在的。
 */
function idMap() {
  return Object.create(null)
}

/** 邻接表取值：只认真正的数组（同上，避免拿到原型上的函数当孩子列表） */
function childrenOf(adjacencyList, nodeId) {
  var children = adjacencyList ? adjacencyList[nodeId] : null
  return Array.isArray(children) ? children : []
}

/** 统一的字符串化：null / undefined 一律当空串；对象与数组转 JSON 而不是 "[object Object]" */
function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch (e) { return '' }
  }
  return String(value)
}

/** 数字探测：空串与空白视为「不是数字」而不是 0，这样条件比较才能区分"空"和"零" */
function numberOrNull(value) {
  var text = textOf(value).trim()
  if (text === '') return null
  var parsed = Number(text)
  return isNaN(parsed) ? null : parsed
}

function pad2(value) {
  return ('0' + value).slice(-2)
}

function describeType(value) {
  if (Array.isArray(value)) return '数组'
  if (value === null) return 'null'
  return typeof value === 'object' ? '对象' : typeof value
}

var ID_SERIAL = 0

/** id 前缀沿用历史格式（n_ / c_ 开头），额外加进程内序号，同一毫秒批量创建也不会撞 */
function mintId(prefix) {
  ID_SERIAL = (ID_SERIAL + 1) % 100000000
  return prefix + Date.now().toString(36) + ID_SERIAL.toString(36) + Math.random().toString(36).slice(2, 6)
}

function makeNodeId() {
  return mintId('n_')
}

function makeConnId() {
  return mintId('c_')
}

// =====================================================================
// 三、格式适配：外部数据形态 → 内部形态
// =====================================================================

function staticParam(value) {
  return { type: 'static', value: value }
}

function refParam(nodeId) {
  return { type: 'ref', nodeId: nodeId }
}

/**
 * 参数归一化。除标准形态外还要容忍几种简写写法（都是历史上出现过、可能已经存在用户设备里的）：
 *   { nodeId } / { ref } / { refNodeId } → 引用上游；{ value } → 静态值；标量 → 静态值。
 * 已经带 type 的对象原样返回（调用方可能持有同一个对象做别的事）。
 */
function coerceParameter(raw) {
  if (raw === null || raw === undefined) return staticParam('')
  if (typeof raw === 'object' && raw.type) return raw
  if (typeof raw === 'object') {
    var refId = raw.nodeId || raw.ref || raw.refNodeId
    if (refId) return refParam(String(refId))
    // 注意：{value:null} 与直接给 null 都要当空串（以前一个变字符串 'null'、一个变空串）
    if (raw.value !== undefined) return staticParam(textOf(raw.value))
    return staticParam('')
  }
  return staticParam(textOf(raw))
}

/**
 * 取参数的实际文本。引用上游时按上游终态决定：
 *   成功 → 输出文本；跳过 → 空串（跳过是正常分支，不该让下游炸）；失败 → 明确抛错；
 *   还没跑完 / 不存在 → 抛错（宁可让这个节点失败，也不要静默算出一个错的值）。
 */
function readParameter(raw, states) {
  var param = coerceParameter(raw)
  if (param.type === 'ref') {
    var state = states[param.nodeId] // states 缺失时这里直接抛（调用方必须给状态表）
    if (!state || !own(states, param.nodeId)) throw new Error('引用的节点尚未执行: ' + param.nodeId)
    if (state.status === 'success') return textOf(state.result)
    if (state.status === 'skipped') return ''
    if (state.status === 'failed') throw new Error('引用的节点执行失败: ' + (state.error || param.nodeId))
    throw new Error('引用的节点尚未完成: ' + param.nodeId)
  }
  return textOf(param.value)
}

var ERROR_KEYWORDS = new Set(['error', 'failed', 'on_error'])
var SUCCESS_KEYWORDS = new Set(['success', 'ok', 'on_success'])
var TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on'])
var FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off'])

/** 真假文本识别（大小写不敏感）；识别不了返回 null，交给正则分支 */
function booleanOf(value) {
  var word = textOf(value).trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return null
}

/**
 * 开关字段的真假判定。
 * 为什么不能直接 `if (node.useFixed)`：节点数据是从本地存储读回来的，
 * 早期写入的可能是字符串 'false' —— 字符串非空即为真，会被误判成"开了"。
 */
function truthy(value) {
  var parsed = booleanOf(value)
  if (parsed !== null) return parsed
  return !!value
}

/** 取整数：只有"没给值"或"解析不出数字"才回落默认值（0 是有效值，不能被 || 吃掉） */
function intOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  var n = parseInt(value, 10)
  return isNaN(n) ? fallback : n
}

function isSkipped(state) {
  return !!state && state.status === 'skipped'
}

/**
 * 读连线条件。
 * 数值型条件是编辑器会写出来的形态：0/NaN 这类假值与"没填条件"等价，
 * 其余数字按字符串条件参与判定（1 会自然落进布尔关键字分支）。
 * 别的一律是坏数据：给一句能读懂的中文错误，别抛 TypeError 让人看不懂。
 * （历史问题：旧实现直接 (condition || '').trim()，数字条件会让整个工作流以
 *  「执行异常」告终，真正的执行结果一个都拿不到。）
 */
function readLinkCondition(raw) {
  if (typeof raw === 'number') return raw ? String(raw) : ''
  var text = raw || ''
  if (typeof text !== 'string') throw new Error('连线条件类型不支持: ' + describeType(text))
  return text.trim()
}

// =====================================================================
// 四、节点工厂
// =====================================================================

function makeTriggerConfig() {
  return {
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
}

/**
 * 默认随机字符集：小写字母 + 大写字母 + 数字，按 ASCII 区间拼出来（顺序固定，
 * 与历史默认值逐字符一致，但不再是一段写死的魔字符串）。
 */
function buildDefaultAlphabet() {
  var chars = []
  var ranges = [[97, 122], [65, 90], [48, 57]]
  for (var r = 0; r < ranges.length; r++) {
    for (var code = ranges[r][0]; code <= ranges[r][1]; code++) chars.push(String.fromCharCode(code))
  }
  return chars.join('')
}

var DEFAULT_ALPHABET = buildDefaultAlphabet()

function makeExtractDefaults() {
  return {
    source: staticParam(''),
    mode: 'REGEX',
    expression: '',
    group: 0,
    defaultValue: '',
    others: [],
    startIndex: 0,
    length: -1,
    // 拼接内容：CONCAT 模式专用的追加片段。
    // 编辑器里有「拼接内容」输入框绑定这个字段，但默认节点一直没有它，
    // 导致界面上建的 CONCAT 节点永远拼不上第二段（2026-10-01 修复）。
    concatValue: '',
    randomMin: 0,
    randomMax: 100,
    randomStringLength: 8,
    randomStringCharset: DEFAULT_ALPHABET,
    useFixed: false,
    fixedValue: ''
  }
}

var NODE_BLUEPRINTS = {
  trigger: function (base) {
    return Object.assign(base, { triggerType: 'manual', triggerConfig: makeTriggerConfig() })
  },
  execute: function (base) {
    return Object.assign(base, { actionType: '', actionConfig: {}, jsCode: '' })
  },
  condition: function (base) {
    return Object.assign(base, { left: staticParam(''), operator: 'EQ', right: staticParam('') })
  },
  logic: function (base) {
    return Object.assign(base, { operator: 'AND' })
  },
  extract: function (base) {
    return Object.assign(base, makeExtractDefaults())
  }
}

/** 创建指定类型的默认节点；类型不认识（含大小写不符）返回 null */
function createNode(type) {
  var blueprint = pick(NODE_BLUEPRINTS, type)
  if (!blueprint) return null
  return blueprint({ id: makeNodeId(), type: type, name: '', description: '', position: { x: 40, y: 120 } })
}

// =====================================================================
// 五、条件比较策略表
// =====================================================================

/** 比较前统一成 { text, num }：num 为 null 表示"这一侧不是数字" */
function operandOf(raw) {
  return { text: textOf(raw), num: numberOrNull(raw) }
}

function typeClash(left, right) {
  throw new Error('条件两侧类型不一致: ' + left.text + ' vs ' + right.text)
}

function bothNumbers(left, right) {
  return left.num !== null && right.num !== null
}

function dependsOnNumbers(test) {
  return function (left, right) {
    if (!bothNumbers(left, right)) typeClash(left, right)
    return test(left.num, right.num)
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

/**
 * 右侧候选集合：能解析成「非空」JSON 数组就用它，否则把原文按逗号切（元素去空白、丢空项）。
 * 两个容易踩的边界，都是既有语义，别"顺手优化"：
 *   '[]' / '[ ]' 解析出来是空数组 → 继续走逗号分支 → 候选是 ['[]'] 这一个字符串元素；
 *   数组元素用 String() 而不是空值转空串 → [null] 的候选是 'null'，不是 ''。
 */
function listItemsOf(text) {
  var parsed = tryParseJson(text)
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed.map(function (item) { return String(item) })
  }
  return text.split(',').map(function (item) { return item.trim() }).filter(function (item) { return item !== '' })
}

function membershipRule(positive) {
  return function (left, right) {
    var items = listItemsOf(right.text)
    var hit = false
    if (items.length > 0) {
      var itemNumbers = items.map(numberOrNull)
      var allNumbers = itemNumbers.every(function (n) { return n !== null })
      var allTexts = itemNumbers.every(function (n) { return n === null })
      if (!allNumbers && !allTexts) throw new Error('条件 IN 列表元素类型不一致: ' + right.text)
      if (allNumbers) {
        if (left.num === null) typeClash(left, right)
        hit = itemNumbers.some(function (n) { return n === left.num })
      } else {
        if (left.num !== null) typeClash(left, right)
        hit = items.indexOf(left.text) > -1
      }
    }
    return positive ? hit : !hit
  }
}

function equalOperands(left, right) {
  if (bothNumbers(left, right)) return left.num === right.num
  if (left.num === null && right.num === null) return left.text === right.text
  return typeClash(left, right)
}

var COMPARATORS = {
  EQ: equalOperands,
  NE: function (left, right) { return !equalOperands(left, right) },
  GT: dependsOnNumbers(function (left, right) { return left > right }),
  GTE: dependsOnNumbers(function (left, right) { return left >= right }),
  LT: dependsOnNumbers(function (left, right) { return left < right }),
  LTE: dependsOnNumbers(function (left, right) { return left <= right }),
  CONTAINS: function (left, right) { return left.text.indexOf(right.text) > -1 },
  NOT_CONTAINS: function (left, right) { return left.text.indexOf(right.text) === -1 },
  IN: membershipRule(true),
  NOT_IN: membershipRule(false)
}

function compareValues(leftRaw, rightRaw, operator) {
  var rule = pick(COMPARATORS, operator)
  if (!rule) return false
  return rule(operandOf(leftRaw), operandOf(rightRaw))
}

// =====================================================================
// 六、提取策略表
// =====================================================================

var SELF_SOURCED_MODES = new Set(['RANDOM_INT', 'RANDOM_STRING'])

function regexGroupOf(source, pattern, group) {
  if (!pattern) return null
  var re = null
  try {
    re = new RegExp(pattern)
  } catch (e) {
    return null
  }
  var matched = re.exec(String(source))
  if (!matched) return null
  var picked = matched[parseInt(group, 10) || 0]
  return picked === undefined ? null : picked
}

/** 把 "a.b[1][2]" 一次扫描切成路径段：段名 + 该段上的全部下标 */
function segmentOf(chunk) {
  var key = ''
  var at = 0
  while (at < chunk.length && chunk.charAt(at) !== '[') {
    key += chunk.charAt(at)
    at++
  }
  var indexes = []
  while (at < chunk.length) {
    if (chunk.charAt(at) !== '[') { at++; continue }
    var from = at + 1
    var to = from
    while (to < chunk.length && chunk.charAt(to) >= '0' && chunk.charAt(to) <= '9') to++
    if (to > from && chunk.charAt(to) === ']') {
      indexes.push(Number(chunk.slice(from, to)))
      at = to + 1
    } else {
      at++ // 未闭合的 '[' 或下标不是数字：忽略，继续往后扫
    }
  }
  return { key: key, indexes: indexes }
}

function pathOf(expression) {
  var parts = textOf(expression).split('.')
  var segments = []
  for (var i = 0; i < parts.length; i++) {
    var chunk = parts[i].trim()
    if (chunk !== '') segments.push(segmentOf(chunk))
  }
  return segments
}

function fieldOf(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  var found = value[key]
  return found === undefined ? null : found
}

function elementOf(value, index) {
  if (!Array.isArray(value)) return null
  return index >= 0 && index < value.length ? value[index] : null
}

function walkPath(root, segments) {
  var current = root
  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i]
    if (segment.key !== '') current = fieldOf(current, segment.key)
    for (var j = 0; j < segment.indexes.length; j++) {
      current = elementOf(current, segment.indexes[j])
      if (current === null || current === undefined) return null
    }
    if (current === null || current === undefined) return null
  }
  return current
}

function jsonPathValue(source, expression) {
  if (!expression) return null
  var raw = textOf(source).trim()
  if (raw === '') return null
  var root = null
  try {
    root = JSON.parse(raw)
  } catch (e) {
    return null
  }
  var found = walkPath(root, pathOf(expression))
  if (found === null || found === undefined) return null
  return typeof found === 'object' ? JSON.stringify(found) : String(found)
}

function sliceText(source, startIndex, length) {
  var text = textOf(source)
  if (text === '') return null
  var start = parseInt(startIndex, 10) || 0
  var size = parseInt(length, 10)
  if (start < 0 || start > text.length) return null
  var end = (isNaN(size) || size < 0) ? text.length : Math.min(start + size, text.length)
  if (end < start) return null
  return text.slice(start, end)
}

function fixedOutputOf(node) {
  return node.fixedValue === null || node.fixedValue === undefined ? '' : String(node.fixedValue)
}

function pickInteger(lowRaw, highRaw) {
  var low = Math.min(lowRaw, highRaw)
  var high = Math.max(lowRaw, highRaw)
  if (low === high) return low
  return Math.floor(Math.random() * (high - low + 1)) + low
}

function makeRandomString(length, charset) {
  var size = parseInt(length, 10) || 0
  if (size <= 0) return ''
  var pool = charset || DEFAULT_ALPHABET
  var out = ''
  for (var i = 0; i < size; i++) out += pool.charAt(Math.floor(Math.random() * pool.length))
  return out
}

// 每个提取器返回「字符串」或 null；null 表示没提到东西，由调用方回退默认值。
// 注意空串是合法结果（正则匹配到空分组），不能当失败。
var EXTRACTORS = {
  REGEX: function (node, source) {
    return regexGroupOf(source, node.expression, node.group)
  },
  JSON: function (node, source) {
    return jsonPathValue(source, node.expression)
  },
  SUB: function (node, source) {
    return sliceText(source, node.startIndex, node.length)
  },
  CONCAT: function (node, source, shared) {
    var out = textOf(source)
    if (node.concatValue !== null && node.concatValue !== undefined) out += textOf(node.concatValue)
    var others = node.others || []
    others.forEach(function (item) { out += shared.readParameter(item) })
    return out
  },
  RANDOM_INT: function (node) {
    if (truthy(node.useFixed)) return fixedOutputOf(node)
    // 注意：这里不能用 `parseInt(x) || 默认值` —— 那样 randomMax 填 0 会被悄悄改成 100。
    // 只有"根本没给值"或"解析不出数字"才回落默认值。
    return String(pickInteger(intOr(node.randomMin, 0), intOr(node.randomMax, 100)))
  },
  RANDOM_STRING: function (node) {
    if (truthy(node.useFixed)) return fixedOutputOf(node)
    return makeRandomString(node.randomStringLength, node.randomStringCharset)
  }
}

function extractValue(node, sourceText, shared) {
  var fallback = node.defaultValue === null || node.defaultValue === undefined ? '' : String(node.defaultValue)
  var extractor = pick(EXTRACTORS, node.mode)
  if (!extractor) return fallback
  var out = extractor(node, sourceText, shared)
  return out === null || out === undefined ? fallback : out
}

/**
 * 提取节点的入参来源：RANDOM_* 不看来源；其余模式取 source 参数。
 * 兼容「只连了线、没显式配 source」的老数据：source 是空静态值时，回退用第一条入边的输出。
 */
function extractFromNode(node, incoming, shared) {
  var sourceText = ''
  if (!SELF_SOURCED_MODES.has(node.mode)) {
    sourceText = shared.readParameter(node.source)
    // 空静态来源 + 没有被显式配置 → 用第一条入边的输出兜底（老数据只连线、不填来源）
    var wantsEdgeFallback = sourceText === '' && !!node.source && node.source.type === 'static'
    if (wantsEdgeFallback) sourceText = firstUpstreamResult(incoming, shared.states)
  }
  return extractValue(node, sourceText, shared)
}

function firstUpstreamResult(incoming, states) {
  if (!incoming || incoming.length === 0) return ''
  var sourceId = incoming[0].sourceNodeId
  if (!own(states, sourceId)) return ''
  var state = states[sourceId]
  if (!state || state.status !== 'success') return ''
  return textOf(state.result)
}

// =====================================================================
// 七、节点处理器注册表
// =====================================================================

function conditionResult(ok) {
  return { status: 'success', result: String(ok) }
}

var NODE_HANDLERS = {
  // 触发节点的状态在启动阶段就带着 triggerExtras 预置好了，正常流程走不到这里；
  // 留着是为了让类型表完整（真走到这里说明有人把触发节点当普通节点手工接了线）。
  trigger: function () {
    return { status: 'success', result: '{}' }
  },
  execute: function (node, incoming, shared) {
    if (!node.actionType) return { status: 'failed', error: '执行节点未设置动作' }
    var params = {}
    var config = node.actionConfig || {}
    Object.keys(config).forEach(function (key) {
      params[key] = shared.readParameter(config[key])
    })
    return Promise.resolve(shared.runStep(node.actionType, params, node)).then(function (outcome) {
      if (outcome && outcome.success) return { status: 'success', result: textOf(outcome.result) }
      return { status: 'failed', error: (outcome && outcome.error) || '执行失败' }
    })
  },
  condition: function (node, incoming, shared) {
    var left = shared.readParameter(node.left)
    var right = shared.readParameter(node.right)
    return conditionResult(compareValues(left, right, node.operator))
  },
  logic: function (node, incoming, shared) {
    var flags = []
    incoming.forEach(function (conn) {
      var state = shared.states[conn.sourceNodeId]
      if (!state || state.status !== 'success') return
      var flag = booleanOf(state.result)
      if (flag !== null) flags.push(flag)
    })
    var ok = node.operator === 'AND'
      ? (flags.length > 0 && flags.every(Boolean))
      : flags.some(Boolean)
    return conditionResult(ok)
  },
  extract: function (node, incoming, shared) {
    return { status: 'success', result: extractFromNode(node, incoming, shared) }
  }
}

// =====================================================================
// 八、连线条件匹配
// =====================================================================

function patternHit(pattern, value) {
  try {
    return new RegExp(pattern).test(textOf(value))
  } catch (e) {
    return false
  }
}

/**
 * 一条连线是否放行：看上游状态 + 条件文本。
 *   跳过的上游永远不放行（跳过要顺着往下传播）；
 *   on_error 系关键字只看上游是否失败，哪怕失败也放行（错误分支）；
 *   condition / logic 上游的空条件默认要求输出 true（它们本来就是布尔节点）；
 *   其余空条件只要求成功；真假字面量比对输出；最后兜底当正则用。
 * 前置条件：调用方必须先确认上游有状态（有状态就说明节点存在），否则 sourceNode 为空会抛错。
 */
function matchConnection(conn, sourceNode, sourceState) {
  if (isSkipped(sourceState)) return false
  var condition = readLinkCondition(conn.condition)
  var keyword = condition.toLowerCase()
  if (ERROR_KEYWORDS.has(keyword)) return sourceState.status === 'failed'
  if (SUCCESS_KEYWORDS.has(keyword)) return sourceState.status === 'success'
  var gate = condition
  if (gate === '' && (sourceNode.type === NODE_TYPES.CONDITION || sourceNode.type === NODE_TYPES.LOGIC)) {
    gate = 'true'
  }
  if (gate === '') return sourceState.status === 'success'
  if (sourceState.status !== 'success') return false
  var wanted = booleanOf(gate)
  if (wanted !== null) {
    var actual = booleanOf(sourceState.result)
    return actual !== null && actual === wanted
  }
  return patternHit(gate, sourceState.result)
}

// 以上是内部实现用的名字；下面三个是对外 API（名字与签名是别的模块在调的，不能改）。
// 第 4 个参数是历史遗留的位置参数，内部判定用不到，保留签名以免改动调用点。

function normalizeParameterValue(parameterValue) {
  return coerceParameter(parameterValue)
}

function resolveParameterValue(parameterValue, nodeResults) {
  return readParameter(parameterValue, nodeResults)
}

function connectionMatches(conn, sourceNode, sourceState, nodeResults) {
  return matchConnection(conn, sourceNode, sourceState)
}

// =====================================================================
// 九、依赖图、环检测、执行作用域
// =====================================================================

/**
 * 每种节点里"可能是引用"的参数位置。kind：
 *   one  —— 单个参数值；map —— 键值袋子（execute 的 actionConfig）；list —— 参数数组（extract 的 others）
 * 表里的字段名是外部数据格式，顺序决定了隐式依赖的先后，改动会影响邻接表里的边顺序。
 */
var REFERENCE_SLOTS = {
  execute: [{ field: 'actionConfig', kind: 'map' }],
  condition: [{ field: 'left', kind: 'one' }, { field: 'right', kind: 'one' }],
  extract: [{ field: 'source', kind: 'one' }, { field: 'others', kind: 'list' }]
}

function collectRefs(value, into) {
  var param = coerceParameter(value)
  if (param.type === 'ref') into.push(param.nodeId)
}

/** 节点里所有隐式数据依赖（参数引用上游），按节点声明的参数顺序 */
function referencedNodeIds(node) {
  var refs = []
  var slots = node ? pick(REFERENCE_SLOTS, node.type) : null
  if (!slots) return refs
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i]
    if (slot.kind === 'map') {
      var bag = node[slot.field] || {}
      Object.keys(bag).forEach(function (key) { collectRefs(bag[key], refs) })
    } else if (slot.kind === 'list') {
      var list = node[slot.field] || []
      list.forEach(function (item) { collectRefs(item, refs) })
    } else {
      collectRefs(node[slot.field], refs)
    }
  }
  return refs
}

/** 引用依赖去重后转成 上游 → 下游 的边（源和目标都必须是存在的节点，自引用丢弃） */
function collectImplicitEdges(nodes) {
  var known = idMap()
  nodes.forEach(function (node) { known[node.id] = true })
  var seen = idMap()
  var edges = []
  nodes.forEach(function (node) {
    referencedNodeIds(node).forEach(function (refId) {
      if (!refId || refId === node.id) return
      if (!known[refId] || !known[node.id]) return
      if (seen[refId + '>' + node.id]) return
      seen[refId + '>' + node.id] = true
      edges.push({ from: refId, to: node.id })
    })
  })
  return edges
}

/** 返回 { adjacencyList, inDegree } —— 邻接表 = 显式连线 + 隐式引用依赖，重复边只留一条 */
function buildDependencyGraph(workflow) {
  var nodes = workflow.nodes
  var adjacencyList = idMap()
  var inDegree = idMap()
  nodes.forEach(function (node) {
    adjacencyList[node.id] = []
    inDegree[node.id] = 0
  })
  function link(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return
    var targets = adjacencyList[sourceId]
    if (!Array.isArray(targets) || targets.indexOf(targetId) > -1) return
    targets.push(targetId)
    inDegree[targetId] = (inDegree[targetId] === undefined ? 0 : inDegree[targetId]) + 1
  }
  var connections = workflow.connections || []
  connections.forEach(function (conn) { link(conn.sourceNodeId, conn.targetNodeId) })
  collectImplicitEdges(nodes).forEach(function (edge) { link(edge.from, edge.to) })
  return { adjacencyList: adjacencyList, inDegree: inDegree }
}

function invertEdges(adjacencyList) {
  var parents = idMap()
  Object.keys(adjacencyList).forEach(function (sourceId) {
    var targets = childrenOf(adjacencyList, sourceId)
    for (var i = 0; i < targets.length; i++) {
      var targetId = targets[i]
      if (!parents[targetId]) parents[targetId] = []
      parents[targetId].push(sourceId)
    }
  })
  return parents
}

function hasSelfEdge(adjacencyList, nodeId) {
  return childrenOf(adjacencyList, nodeId).indexOf(nodeId) > -1
}

/**
 * Tarjan 求强连通分量，返回第一个环的节点集合：简单环按环的走向排列，环里还有多余连线时
 * 只保证集合正确、顺序不保证是严格的一次环游。无环返回 null。
 * 只看 nodes 里出现过的 id（邻接表里指向不存在节点的边忽略）。
 */
function findCycleRing(adjacencyList, nodes) {
  var ids = []
  var known = idMap()
  ;(nodes || []).forEach(function (item) {
    var id = item && typeof item === 'object' ? item.id : item
    if (id === null || id === undefined || known[id]) return
    known[id] = true
    ids.push(id)
  })

  var order = idMap()
  var low = idMap()
  var onStack = idMap()
  var stack = []
  var counter = 0
  var ring = null

  function strongConnect(start) {
    order[start] = counter
    low[start] = counter
    counter++
    stack.push(start)
    onStack[start] = true
    var nexts = childrenOf(adjacencyList, start)
    for (var i = 0; i < nexts.length; i++) {
      var next = nexts[i]
      if (!known[next]) continue
      if (order[next] === undefined) {
        strongConnect(next)
        if (low[next] < low[start]) low[start] = low[next]
      } else if (onStack[next]) {
        if (order[next] < low[start]) low[start] = order[next]
      }
      if (ring) return
    }
    if (low[start] !== order[start]) return
    var component = []
    var member
    do {
      member = stack.pop()
      onStack[member] = false
      component.push(member)
    } while (member !== start)
    if (component.length > 1) {
      component.reverse() // 出栈顺序是环的逆序，反转后才是 a → b → a 这种可读顺序
      ring = component
    } else if (hasSelfEdge(adjacencyList, start)) {
      ring = component
    }
  }

  for (var i = 0; i < ids.length; i++) {
    if (order[ids[i]] === undefined) strongConnect(ids[i])
    if (ring) break
  }
  return ring
}

function detectCycle(adjacencyList, nodes) {
  return findCycleRing(adjacencyList || {}, nodes) !== null
}

/**
 * 本次执行的作用域 = 从启动的触发节点正向可达的节点，再并上所有能到达它们的祖先。
 * 祖先必须一起算：否则下游节点会因为"上游根本没求值"而读到空引用。
 */
function collectScope(startIds, adjacencyList, parents) {
  var inScope = idMap()
  var queue = []
  function add(id) {
    if (id === null || id === undefined || inScope[id]) return
    inScope[id] = true
    queue.push(id)
  }
  ;(startIds || []).forEach(add)
  for (var i = 0; i < queue.length; i++) {
    var nexts = childrenOf(adjacencyList, queue[i])
    for (var j = 0; j < nexts.length; j++) add(nexts[j])
  }
  for (var k = 0; k < queue.length; k++) {
    var prevs = parents[queue[k]] || []
    for (var m = 0; m < prevs.length; m++) add(prevs[m])
  }
  return Object.keys(inScope)
}

// =====================================================================
// 十、内置动作（纯 JS 步骤）
// =====================================================================

function describeTime(date) {
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日 ' +
    pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function responseText(data) {
  return typeof data === 'string' ? data : JSON.stringify(data)
}

// done 就是 Promise 的 resolve：动作既可以是同步完成（delay / get_time），
// 也可以是回调完成（http_request），统一由调用方包 Promise。
var STEP_ACTIONS = {
  delay: function (params, done) {
    var ms = parseInt(params.ms, 10) || 0
    setTimeout(function () { done({ success: true, result: '延时 ' + ms + 'ms' }) }, ms)
  },
  get_time: function (params, done) {
    done({ success: true, result: describeTime(new Date()) })
  },
  http_request: function (params, done) {
    var url = (params.url || '').trim()
    if (!url) {
      done({ success: false, error: '缺少 URL 参数' })
      return
    }
    uni.request({
      url: url,
      method: (params.method || 'GET').toUpperCase(),
      header: { 'Content-Type': 'application/json' },
      data: params.body ? JSON.parse(params.body) : undefined,
      success: function (res) {
        done({ success: true, result: responseText(res.data) })
      },
      fail: function (err) {
        done({ success: false, error: (err && err.errMsg) || '请求失败' })
      }
    })
  }
}

function defaultStepRunner(actionType, params) {
  return new Promise(function (resolve) {
    var action = pick(STEP_ACTIONS, actionType)
    if (!action) {
      resolve({ success: false, error: '未知的 JS 动作: ' + actionType })
      return
    }
    action(params, resolve)
  })
}

// =====================================================================
// 十一、执行调度：记忆化递归 + 信号闸
// =====================================================================

function publishState(states, notify, nodeId, state) {
  if (nodeId === '__proto__') {
    // 直接赋值会踩到 __proto__ 的 setter：状态不会成为自有属性，反而把整张状态表的本体换掉。
    // 用 defineProperty 建普通自有属性，属性描述符与普通赋值一致。
    Object.defineProperty(states, nodeId, { value: state, enumerable: true, writable: true, configurable: true })
  } else {
    states[nodeId] = state
  }
  try {
    notify(nodeId, state)
  } catch (e) {}
}

/** 信号闸：把并发到达的任务排成一队依次执行（前一个失败也要放行后一个） */
function createGate() {
  var tail = Promise.resolve()
  return function (job) {
    var outcome = tail.then(job)
    tail = outcome.then(noop, noop)
    return outcome
  }
}

/**
 * 等所有节点求值结束（成功失败都收），失败原因原样带出来。
 * 不用 Promise.allSettled：那是 ES2020 的 API，老机型 WebView 上可能没有，
 * 引擎要能在只有 ES6 的环境里跑。
 */
function settleAll(tasks) {
  return Promise.all(tasks.map(function (task) {
    return task.then(
      function (value) { return { failed: false, value: value } },
      function (reason) { return { failed: true, reason: reason } }
    )
  }))
}

/**
 * 返回 '' 表示失败都被 on_error 分支接住了；否则返回可直接给用户看的错误文案。
 * 「接住」的判定：失败节点的某条 on_error 出边指向了一个成功的节点。
 */
function describeUnhandledFailures(workflow, states) {
  var outgoing = idMap()
  ;(workflow.connections || []).forEach(function (conn) {
    if (!outgoing[conn.sourceNodeId]) outgoing[conn.sourceNodeId] = []
    outgoing[conn.sourceNodeId].push(conn)
  })
  var unhandled = []
  Object.keys(states).forEach(function (nodeId) {
    var state = states[nodeId]
    if (!state || state.status !== 'failed') return
    var rescued = (outgoing[nodeId] || []).some(function (conn) {
      if (!ERROR_KEYWORDS.has(readLinkCondition(conn.condition).toLowerCase())) return false
      return own(states, conn.targetNodeId) && states[conn.targetNodeId].status === 'success'
    })
    if (!rescued) unhandled.push(nodeId)
  })
  if (unhandled.length === 0) return ''
  return '有失败节点未被 on_error 分支处理: ' + unhandled.join(', ')
}

/**
 * 按依赖关系求值作用域内的所有节点。
 * 返回 Promise<{ ok: true } | { ok: false, message }>；判定阶段（读连线条件）出现的异常
 * 视为致命错误向上抛：这类问题说明工作流数据本身坏了，继续跑只会得到错的结果。
 */
function evaluateGraph(workflow, plan) {
  var adjacencyList = plan.adjacencyList
  var parents = invertEdges(adjacencyList) // 反查索引：等上游、过滤入边、算作用域都要用
  var states = plan.states
  var nodeById = idMap()
  workflow.nodes.forEach(function (node) { nodeById[node.id] = node })

  var startedSet = idMap()
  plan.startedIds.forEach(function (id) { startedSet[id] = true })

  var inScope = idMap()
  var scope = collectScope(plan.startedIds, adjacencyList, parents)
  scope.forEach(function (id) { inScope[id] = true })

  var incomingByTarget = idMap()
  ;(workflow.connections || []).forEach(function (conn) {
    if (!incomingByTarget[conn.targetNodeId]) incomingByTarget[conn.targetNodeId] = []
    incomingByTarget[conn.targetNodeId].push(conn)
  })

  // 未启动的触发节点既不产生状态、也不参与依赖和入边判断，它们的连线等于不存在
  function liveSource(id) {
    if (!inScope[id]) return false
    var node = nodeById[id]
    return !(node && node.type === NODE_TYPES.TRIGGER && !startedSet[id])
  }

  function incomingOf(id) {
    return (incomingByTarget[id] || []).filter(function (conn) { return liveSource(conn.sourceNodeId) })
  }

  var shared = {
    states: states,
    readParameter: function (raw) { return readParameter(raw, states) },
    runStep: plan.runStep
  }

  var memory = new Map()
  var gate = createGate()
  var fatal = null

  function publish(nodeId, state) {
    publishState(states, plan.notify, nodeId, state)
  }

  function runNodeBody(node, incoming) {
    publish(node.id, { status: 'running' })
    var handler = pick(NODE_HANDLERS, node.type)
    if (!handler) {
      publish(node.id, { status: 'skipped', result: '', reason: '未知节点类型' })
      return Promise.resolve()
    }
    return Promise.resolve()
      .then(function () { return handler(node, incoming, shared) })
      .then(function (state) {
        publish(node.id, state)
      }, function (e) {
        publish(node.id, { status: 'failed', error: e.message })
      })
  }

  function executeOnce(node) {
    if (fatal) return Promise.resolve() // 已经致命失败：剩下的节点保持无状态，不再触碰
    var incoming = incomingOf(node.id)
    var shouldRun
    try {
      shouldRun = incoming.length === 0 || incoming.some(function (conn) {
        if (!own(states, conn.sourceNodeId)) return false
        return matchConnection(conn, nodeById[conn.sourceNodeId], states[conn.sourceNodeId])
      })
    } catch (e) {
      fatal = e
      throw e
    }
    if (!shouldRun) {
      publish(node.id, { status: 'skipped', result: '', reason: '条件不满足，已跳过' })
      return Promise.resolve()
    }
    return runNodeBody(node, incoming)
  }

  function settle(nodeId) {
    var running = memory.get(nodeId)
    if (running) return running
    var task = evaluateNode(nodeId)
    memory.set(nodeId, task)
    return task
  }

  function evaluateNode(nodeId) {
    var node = nodeById[nodeId]
    if (!node) return Promise.resolve()
    if (own(states, nodeId)) return Promise.resolve() // 启动阶段已预置状态的触发节点
    if (node.type === NODE_TYPES.TRIGGER) return Promise.resolve() // 未启动的触发节点不执行
    // 先让出一个微任务再去找上游：作用域里的节点会在这之前全部挂号完毕，
    // 于是"同层节点"的排队顺序等于作用域顺序，不会因为下游提前递归唤醒上游而插队。
    // 基线的回调顺序断言（线性链 t→a1→a2）盯着这里：两级 .then 不能合成 async，
    // 也不能把 await 提前，否则同层节点的执行顺序会静默变化。
    return Promise.resolve().then(function () {
      var upstreams = (parents[nodeId] || []).filter(liveSource)
      var waiting = []
      for (var i = 0; i < upstreams.length; i++) {
        // 已经有状态的上游（启动阶段预置的触发节点）不必等：多等一次微任务同样会打乱排队顺序
        if (own(states, upstreams[i])) continue
        waiting.push(settle(upstreams[i]))
      }
      return Promise.all(waiting)
    }).then(function () {
      return gate(function () { return executeOnce(node) })
    })
  }

  var tasks = scope.map(function (id) { return settle(id) })
  return settleAll(tasks).then(function (results) {
    for (var i = 0; i < results.length; i++) {
      if (results[i].failed) return Promise.reject(results[i].reason)
    }
    if (fatal) return Promise.reject(fatal) // 兜底：正常路径下 fatal 必然已经让某个节点的 promise reject 并被上面捕获
    var hasFailure = Object.keys(states).some(function (id) {
      return states[id] && states[id].status === 'failed'
    })
    if (!hasFailure) return { ok: true }
    var unhandled = describeUnhandledFailures(workflow, states)
    return unhandled ? { ok: false, message: unhandled } : { ok: true }
  })
}

// =====================================================================
// 十二、对外执行入口
// =====================================================================

/**
 * 执行工作流
 * @param workflow 工作流对象 { nodes, connections }
 * @param options { triggerNodeId, triggerExtras, stepRunner(actionType, params, node),
 *                  onNodeStateChange(nodeId, state), onCycle(cycleNodeIds) }
 *   onCycle 是可选的：检测到循环依赖时把环上的节点交出来，便于界面指出问题在哪。
 *   它不影响返回值，回调里抛错也会被吞掉。
 * @returns Promise<{ success, message, nodeResults }>
 */
function executeWorkflow(workflow, options) {
  var opts = options || {}
  var runStep = opts.stepRunner || defaultStepRunner
  var notify = opts.onNodeStateChange || noop
  var extras = opts.triggerExtras || {}
  var states = {}

  function failure(message) {
    return { success: false, message: message, nodeResults: states }
  }

  return new Promise(function (resolve) {
    try {
      var triggers = workflow.nodes.filter(function (node) { return node.type === NODE_TYPES.TRIGGER })
      if (triggers.length === 0) {
        resolve(failure('这个工作流还没配触发节点，跑不起来'))
        return
      }

      var started = null
      if (opts.triggerNodeId) {
        started = triggers.filter(function (node) { return node.id === opts.triggerNodeId })
        if (started.length === 0) {
          resolve(failure('找不到你指定的那个触发节点'))
          return
        }
      } else {
        started = triggers.filter(function (node) { return node.triggerType === 'manual' })
        if (started.length === 0) {
          resolve(failure('没有手动触发节点'))
          return
        }
      }

      var graph = buildDependencyGraph(workflow)
      var ring = findCycleRing(graph.adjacencyList, workflow.nodes)
      if (ring) {
        // 报错文案保持简短可读；环上到底有哪些节点，另外通过 onCycle 回调交出去
        if (typeof opts.onCycle === 'function') {
          try { opts.onCycle(ring.slice()) } catch (e) {}
        }
        resolve(failure('节点连成了环，这个工作流没法跑'))
        return
      }

      var startedIds = started.map(function (node) { return node.id })
      var payload = JSON.stringify(extras)
      startedIds.forEach(function (id) {
        publishState(states, notify, id, { status: 'success', result: payload })
      })

      evaluateGraph(workflow, {
        adjacencyList: graph.adjacencyList,
        startedIds: startedIds,
        states: states,
        runStep: runStep,
        notify: notify
      }).then(function (outcome) {
        if (outcome.ok) {
          resolve({ success: true, message: '工作流执行成功', nodeResults: states })
          return
        }
        resolve(failure(outcome.message || '工作流执行失败'))
      }, function (err) {
        resolve(failure('工作流执行异常: ' + err.message))
      })
    } catch (e) {
      resolve(failure('工作流执行异常: ' + e.message))
    }
  })
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
