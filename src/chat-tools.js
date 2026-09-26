/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * chat-tools.js — 增强对话工具包（AI 通过 ToolCall 调用）
 *
 * 提供以下工具：
 *   list_chats / find_chat / read_messages / read_messages_range /
 *   rename_chat / delete_chat / chat_with_agent / agent_status / list_character_cards
 */

// ===== 存储层 =====

function loadAiList() {
  var raw = uni.getStorageSync('ai_list')
  var arr = []
  if (raw) { try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw } catch(e) {} }
  return Array.isArray(arr) ? arr : []
}

function saveAiList(arr) {
  uni.setStorageSync('ai_list', JSON.stringify(arr))
}

function loadMessages(aiId) {
  var d = uni.getStorageSync('chat_msgs_' + aiId)
  var arr = []
  if (d) { try { arr = typeof d === 'string' ? JSON.parse(d) : d } catch(e) {} }
  return Array.isArray(arr) ? arr : []
}

function saveMessages(aiId, arr) {
  uni.setStorageSync('chat_msgs_' + aiId, JSON.stringify(arr))
}

function roleName(role) {
  if (role === 'ai') return 'AI'
  if (role === 'user') return '用户'
  if (role === 'system') return '系统'
  return role || '消息'
}

function formatTime(ts) {
  if (!ts) return ''
  var d = new Date(ts)
  var pad = function(n) { return n < 10 ? '0' + n : n }
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function formatMessage(m) {
  if (!m) return ''
  var header = '[' + roleName(m.role) + ']'
  var t = formatTime(m.time)
  if (t) header = '[' + t + ' ' + roleName(m.role) + ']'
  var content = (m.content == null ? '' : String(m.content))
  if (m.type === 'image') content = '[图片] ' + content
  if (m.type === 'sticker' || m.type === 'emoji') content = '[表情] ' + content
  return header + ': ' + content
}

function toText(messages) {
  return messages.map(formatMessage).join('\n')
}

// ===== 会话定位 =====

function normalizeMatchMode(match) {
  var m = (match || '').trim().toLowerCase()
  if (m === 'exact' || m === 'regex' || m === 'contains') return m
  return 'contains'
}

function matchTitle(name, needle, mode) {
  name = String(name || '')
  needle = String(needle || '')
  if (!needle) return true
  if (mode === 'exact') return name === needle
  if (mode === 'regex') {
    try { return new RegExp(needle).test(name) } catch(e) { return name.indexOf(needle) > -1 }
  }
  return name.indexOf(needle) > -1
}

function findAi(list, query, mode, index) {
  var i = isNaN(index) ? 0 : index
  var hits = []
  for (var j = 0; j < list.length; j++) {
    if (matchTitle(list[j].name, query, mode)) hits.push(list[j])
  }
  return hits[i] || null
}

function resolveAi(args) {
  var list = loadAiList()
  var id = args && typeof args.chat_id === 'string' ? args.chat_id.trim() : ''
  if (id) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === id) return { ai: list[i], list: list }
    }
    return { error: '未找到 chat_id 为 ' + id + ' 的会话' }
  }
  var title = args && typeof args.chat_title === 'string' ? args.chat_title.trim() : ''
  var query = args && typeof args.chat_query === 'string' ? args.chat_query.trim() : ''
  var mode = normalizeMatchMode(args && args.match)
  var indexRaw = args && args.chat_index !== undefined ? Number(args.chat_index) : 0
  if (!title && !query) return { error: '缺少参数：chat_id 或 chat_title 至少提供一个' }
  var ai = findAi(list, title || query, title ? 'exact' : mode, indexRaw)
  if (!ai) return { error: '未找到名称为「' + (title || query) + '」的会话' }
  return { ai: ai, list: list }
}

// ===== 工具实现 =====

function listChats(args) {
  var list = loadAiList()
  var query = args && args.query ? String(args.query).trim() : ''
  var mode = normalizeMatchMode(args && args.match)
  var limitRaw = args && args.limit !== undefined ? Number(args.limit) : 50
  var limit = isNaN(limitRaw) ? 50 : limitRaw
  var sortBy = (args && args.sort_by) ? String(args.sort_by).trim() : 'updateTime'
  var sortOrder = (args && args.sort_order) ? String(args.sort_order).trim().toLowerCase() : 'desc'

  var result = []
  for (var i = 0; i < list.length; i++) {
    var ai = list[i]
    if (!matchTitle(ai.name, query, mode)) continue
    var msgs = loadMessages(ai.id)
    var lastTs = 0
    for (var j = 0; j < msgs.length; j++) {
      if (msgs[j].time && msgs[j].time > lastTs) lastTs = msgs[j].time
    }
    result.push({
      id: ai.id,
      title: ai.name || '',
      messageCount: msgs.length,
      createdAt: ai.createTime || 0,
      updatedAt: lastTs,
      relationship: ai.relationship || '',
      pinned: !!ai.pinned
    })
  }

  var key = sortBy
  if (key !== 'name' && key !== 'createdAt' && key !== 'updatedAt' && key !== 'messageCount') key = 'updatedAt'
  result.sort(function(a, b) {
    var va = a[key], vb = b[key]
    if (key === 'name') { va = String(a.title); vb = String(b.title) }
    if (typeof va === 'string') return sortOrder === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    return sortOrder === 'asc' ? (va - vb) : (vb - va)
  })
  if (result.length > limit) result = result.slice(0, limit)

  if (!result.length) return { success: true, message: '当前没有任何会话', chats: [], totalCount: 0 }
  return { success: true, message: '共有 ' + list.length + ' 个会话', totalCount: list.length, chats: result }
}

function findChat(args) {
  var query = args && args.query ? String(args.query).trim() : ''
  if (!query) return { success: false, message: '缺少参数：query' }
  var mode = normalizeMatchMode(args && args.match)
  var indexRaw = args && args.index !== undefined ? Number(args.index) : 0
  var list = loadAiList()
  var ai = findAi(list, query, mode, indexRaw)
  if (!ai) return { success: false, message: '未找到匹配的会话：' + query }
  var msgs = loadMessages(ai.id)
  return {
    success: true,
    message: '找到会话「' + ai.name + '」',
    chat: {
      id: ai.id,
      title: ai.name || '',
      messageCount: msgs.length,
      relationship: ai.relationship || ''
    }
  }
}

function readMessages(args) {
  var resolved = resolveAi(args)
  if (resolved.error) return { success: false, message: resolved.error }
  var msgs = loadMessages(resolved.ai.id)
  var order = (args && args.order) ? String(args.order).trim().toLowerCase() : 'desc'
  var limitRaw = args && args.limit !== undefined ? Number(args.limit) : 20
  var limit = isNaN(limitRaw) || limitRaw < 1 ? 20 : limitRaw
  if (order === 'asc') msgs = msgs.slice(-limit)
  else msgs = msgs.slice(-limit).reverse()
  if (!msgs.length) return { success: true, message: '会话「' + resolved.ai.name + '」还没有消息', messages: [], text: '' }
  var text = toText(msgs)
  return {
    success: true,
    message: '读取会话「' + resolved.ai.name + '」最近 ' + msgs.length + ' 条消息',
    chat_id: resolved.ai.id,
    messages: msgs.map(function(m) {
      return { role: roleName(m.role), content: (m.content == null ? '' : String(m.content)), time: m.time || 0 }
    }),
    text: text
  }
}

function readMessagesRange(args) {
  var resolved = resolveAi(args)
  if (resolved.error) return { success: false, message: resolved.error }
  var msgs = loadMessages(resolved.ai.id)
  var order = (args && args.order) ? String(args.order).trim().toLowerCase() : 'asc'
  var startRaw = args && args.start !== undefined ? Number(args.start) : NaN
  var endRaw = args && args.end !== undefined ? Number(args.end) : NaN
  if (isNaN(startRaw) || isNaN(endRaw)) return { success: false, message: '缺少参数：start 和 end 为必填' }
  var start = Math.floor(startRaw)
  var end = Math.floor(endRaw)
  if (start < 0 || end < start) return { success: false, message: '参数不合法：需要 0 <= start <= end' }
  var picked = []
  for (var i = start; i <= end && i < msgs.length; i++) picked.push(msgs[i])
  if (order === 'desc') picked = picked.reverse()
  if (!picked.length) return { success: true, message: '该区间没有消息', messages: [], text: '' }
  return {
    success: true,
    message: '读取会话「' + resolved.ai.name + '」第 ' + start + '-' + Math.min(end, msgs.length - 1) + ' 条消息',
    chat_id: resolved.ai.id,
    messages: picked.map(function(m) {
      return { role: roleName(m.role), content: (m.content == null ? '' : String(m.content)), time: m.time || 0 }
    }),
    text: toText(picked)
  }
}

function renameChat(args) {
  var newTitle = args && args.new_title ? String(args.new_title).trim() : ''
  if (!newTitle) return { success: false, message: '缺少参数：new_title' }
  var resolved = resolveAi(args)
  if (resolved.error) return { success: false, message: resolved.error }
  var oldName = resolved.ai.name
  resolved.ai.name = newTitle
  saveAiList(resolved.list)
  return { success: true, message: '已将「' + oldName + '」重命名为「' + newTitle + '」', chat_id: resolved.ai.id }
}

function deleteChat(args) {
  var resolved = resolveAi(args)
  if (resolved.error) return { success: false, message: resolved.error }
  var ai = resolved.ai
  var next = []
  for (var i = 0; i < resolved.list.length; i++) {
    if (resolved.list[i].id !== ai.id) next.push(resolved.list[i])
  }
  saveAiList(next)
  // 清理该角色相关存储
  var keys = [
    'chat_msgs_' + ai.id,
    'chat_settings_' + ai.id,
    'chat_bg_' + ai.id,
    'chat_persona_' + ai.id,
    'chat_daily_' + ai.id,
    'daily_summary_time_' + ai.id,
    'subconscious_' + ai.id,
    'aiyu_mem_' + ai.id,
    'avatar_cache_' + ai.id,
    'ai_stickers_' + ai.id,
    'custom_emoji_' + ai.id,
    'chat_memories_' + ai.id
  ]
  keys.forEach(function(k) { uni.removeStorageSync(k) })
  return { success: true, message: '已删除会话「' + ai.name + '」及其全部聊天记录与记忆', chat_id: ai.id }
}

function chatWithAgent(args) {
  var message = args && args.message ? String(args.message) : ''
  if (!message.trim()) return Promise.resolve(JSON.stringify({ success: false, message: '缺少参数：message' }))
  var characterName = args && args.character_card_name ? String(args.character_card_name).trim() : ''
  if (!characterName) return Promise.resolve(JSON.stringify({ success: false, message: '缺少参数：character_card_name' }))
  var list = loadAiList()
  var target = null
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].name).trim() === characterName) { target = list[i]; break }
  }
  if (!target) {
    return Promise.resolve(JSON.stringify({ success: false, message: '未找到角色「' + characterName + '」，可用 list_character_cards 查看所有角色' }))
  }
  var msgs = loadMessages(target.id)
  msgs.push({ id: 'm_' + Date.now() + '_' + Math.floor(Math.random() * 1000), role: 'user', content: message, type: 'text', time: Date.now() })
  if (msgs.length > 200) msgs = msgs.slice(-200)
  saveMessages(target.id, msgs)
  var recent = msgs.slice(-5).map(formatMessage).join('\n')
  return Promise.resolve(JSON.stringify({
    success: true,
    message: '已把这条消息投递给「' + characterName + '」的会话（她会在会话中看到）。对方最近的消息：\n' + (recent || '（暂无）')
  }))
}

function agentStatus(args) {
  var id = args && args.chat_id ? String(args.chat_id).trim() : ''
  if (!id) return { success: false, message: '缺少参数：chat_id' }
  var list = loadAiList()
  var ai = null
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id) === id) { ai = list[i]; break }
  }
  if (!ai) return { success: false, message: '未找到 chat_id 为 ' + id + ' 的会话' }
  var msgs = loadMessages(id)
  var lastTs = 0
  var lastRole = ''
  for (var j = 0; j < msgs.length; j++) {
    if (msgs[j].time && msgs[j].time > lastTs) { lastTs = msgs[j].time; lastRole = msgs[j].role }
  }
  return {
    success: true,
    message: '会话「' + ai.name + '」状态查询完成',
    chat: {
      id: ai.id,
      title: ai.name || '',
      messageCount: msgs.length,
      lastActiveTime: lastTs || 0,
      lastActiveAt: formatTime(lastTs),
      lastMessageFrom: lastRole ? roleName(lastRole) : ''
    }
  }
}

function listCharacterCards() {
  var list = loadAiList()
  if (!list.length) return { success: true, message: '当前没有任何角色', cards: [], totalCount: 0 }
  return {
    success: true,
    message: '共有 ' + list.length + ' 个角色',
    totalCount: list.length,
    cards: list.map(function(ai) {
      return { id: ai.id, name: ai.name || '', relationship: ai.relationship || '', type: ai.type || '' }
    })
  }
}

// ===== UI 控制工具（应用内操作）=====

var UI_CONTROL_HINT = [
  'toggle_glass: 切换玻璃模式（透明聊天气泡）',
  'set_theme: 切换主题 {theme: "light"|"dark"|"system"}',
  'set_chat_bg: 设置聊天背景 {bg: "default"|"bg1"|"bg2"|...}',
  'scroll_to_bottom: 滚动到最新消息',
  'scroll_to_top: 滚动到最早消息',
  'toggle_emoji_panel: 切换表情面板',
  'clear_chat: 清空当前对话消息'
].join('；')

function executeUiControl(args) {
  args = args || {}
  var action = String(args.action || '').trim()
  if (!action) {
    return Promise.resolve(JSON.stringify({ success: false, message: '缺少参数 action。可选：' + UI_CONTROL_HINT }))
  }
  var params = args.params || {}
  return new Promise(function(resolve) {
    try {
      switch (action) {
        case 'toggle_glass':
          uni.$emit('toggleGlass')
          resolve(JSON.stringify({ success: true, message: '已切换玻璃模式' }))
          break
        case 'set_theme':
          var theme = params.theme || 'system'
          if (['light', 'dark', 'system'].indexOf(theme) === -1) {
            resolve(JSON.stringify({ success: false, message: 'theme 必须是 light、dark 或 system' }))
            break
          }
          uni.setStorageSync('theme_mode', theme)
          uni.$emit('themeChanged', { theme: theme })
          resolve(JSON.stringify({ success: true, message: '已切换主题为 ' + theme }))
          break
        case 'set_chat_bg':
          var bg = params.bg || 'default'
          uni.$emit('setChatBg', { bg: bg })
          resolve(JSON.stringify({ success: true, message: '已设置聊天背景为 ' + bg }))
          break
        case 'scroll_to_bottom':
          uni.$emit('scrollToBottom')
          resolve(JSON.stringify({ success: true, message: '已滚动到底部' }))
          break
        case 'scroll_to_top':
          uni.$emit('scrollToTop')
          resolve(JSON.stringify({ success: true, message: '已滚动到顶部' }))
          break
        case 'toggle_emoji_panel':
          uni.$emit('toggleEmojiPanel')
          resolve(JSON.stringify({ success: true, message: '已切换表情面板' }))
          break
        case 'clear_chat':
          uni.$emit('clearChat')
          resolve(JSON.stringify({ success: true, message: '已清空对话消息' }))
          break
        default:
          resolve(JSON.stringify({ success: false, message: '未知 UI 动作: ' + action + '。可选：' + UI_CONTROL_HINT }))
      }
    } catch(e) {
      resolve(JSON.stringify({ success: false, message: '执行失败: ' + e.message }))
    }
  })
}

function isUiControlTool(name) {
  return name === 'ui_control'
}

// ===== 入口 =====

function execute(name, args) {
  args = args || {}
  var r
  switch (name) {
    case 'list_chats': r = listChats(args); break
    case 'find_chat': r = findChat(args); break
    case 'read_messages': r = readMessages(args); break
    case 'read_messages_range': r = readMessagesRange(args); break
    case 'rename_chat': r = renameChat(args); break
    case 'delete_chat': r = deleteChat(args); break
    case 'chat_with_agent': return chatWithAgent(args)
    case 'agent_status': r = agentStatus(args); break
    case 'list_character_cards': r = listCharacterCards(); break
    case 'ui_control': return executeUiControl(args)
    default: r = { success: false, message: '未知工具: ' + name }
  }
  return Promise.resolve(JSON.stringify(r))
}

function isChatTool(name) {
  return [
    'list_chats', 'find_chat', 'read_messages', 'read_messages_range',
    'rename_chat', 'delete_chat', 'chat_with_agent', 'agent_status', 'list_character_cards'
  ].indexOf(name) > -1
}

// ===== 工具定义（喂给模型的 schema） =====

var CHAT_LOCATE_HINT = [
  '所有工具均支持以下三种定位方式（任选其一）：',
  'chat_id 直接指定会话 id',
  'chat_title 指定 AI 名称（精确匹配）',
  'chat_query 指定名称关键字 + chat_index 选择第几个（默认0）'
].join('；')

var TOOL_DEFINITIONS = [
  {
    name: 'list_chats',
    description: '列出所有 AI 会话（相当于每个角色一个会话），返回会话 id、名称、消息数、最后活跃时间。用户询问"我和哪些角色聊过"或需要跨会话找信息时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：名称筛选关键字' },
        match: { type: 'string', description: '可选：contains/exact/regex（默认 contains）' },
        limit: { type: 'number', description: '可选：最多返回条数（默认 50）' },
        sort_by: { type: 'string', description: '可选：updatedAt/createdAt/messageCount/name（默认 updatedAt）' },
        sort_order: { type: 'string', description: '可选：asc/desc（默认 desc）' }
      },
      required: []
    }
  },
  {
    name: 'find_chat',
    description: '按名称查找一个 AI 会话并返回其 id。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '名称关键字或正则' },
        match: { type: 'string', description: '可选：contains/exact/regex（默认 contains）' },
        index: { type: 'number', description: '可选：匹配多个时选第 N 个（默认 0）' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_messages',
    description: '读取指定 AI 会话的聊天记录，可用于回忆用户在其他会话里说过的话、跨会话了解背景。' + CHAT_LOCATE_HINT,
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '目标会话 id（可选）' },
        chat_title: { type: 'string', description: '目标 AI 名称（可选）' },
        chat_query: { type: 'string', description: '名称关键字（可选）' },
        chat_index: { type: 'number', description: '可选：筛选结果多个时选第 N 个（默认 0）' },
        order: { type: 'string', description: '可选：desc（最近在前，默认）/asc（最早在前）' },
        limit: { type: 'number', description: '可选：返回条数（默认 20）' }
      },
      required: []
    }
  },
  {
    name: 'read_messages_range',
    description: '按消息序号区间读取会话记录，适合大范围读取（超出 read_messages 单次条数限制时）。' + CHAT_LOCATE_HINT,
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '目标会话 id（可选）' },
        chat_title: { type: 'string', description: '目标 AI 名称（可选）' },
        chat_query: { type: 'string', description: '名称关键字（可选）' },
        chat_index: { type: 'number', description: '可选：筛选结果多个时选第 N 个（默认 0）' },
        order: { type: 'string', description: '可选：asc（默认）/desc' },
        start: { type: 'number', description: '起始消息序号（从0开始，包含）' },
        end: { type: 'number', description: '结束消息序号（包含）' }
      },
      required: ['start', 'end']
    }
  },
  {
    name: 'rename_chat',
    description: '重命名一个 AI 会话（修改该角色在列表中的显示名称）。用户要求改名时使用。' + CHAT_LOCATE_HINT,
    parameters: {
      type: 'object',
      properties: {
        new_title: { type: 'string', description: '新的名称' },
        chat_id: { type: 'string', description: '目标会话 id（可选）' },
        chat_title: { type: 'string', description: '目标 AI 名称（可选）' },
        chat_query: { type: 'string', description: '名称关键字（可选）' },
        chat_index: { type: 'number', description: '可选（默认 0）' }
      },
      required: ['new_title']
    }
  },
  {
    name: 'delete_chat',
    description: '删除一个 AI 会话，会永久清除该角色的聊天记录和记忆。仅在用户明确要求删除角色时使用，删除前可先向用户确认。' + CHAT_LOCATE_HINT,
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '目标会话 id（可选）' },
        chat_title: { type: 'string', description: '目标 AI 名称（可选）' },
        chat_query: { type: 'string', description: '名称关键字（可选）' },
        chat_index: { type: 'number', description: '可选（默认 0）' }
      },
      required: []
    }
  },
  {
    name: 'chat_with_agent',
    description: '给另一个角色（AI）投递一条消息，用于转达用户的意思或请对方协助。消息会写入对方的会话，对方会在其会话中看到并回应。通常只在用户明确表达"告诉/转达/帮我问一下另一个角色"等意图时使用。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要发送给对方的完整内容' },
        character_card_name: { type: 'string', description: '目标角色名称' }
      },
      required: ['message', 'character_card_name']
    }
  },
  {
    name: 'agent_status',
    description: '查询一个 AI 会话的状态：消息数量、最后活跃时间、最后消息来自谁。',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '目标会话 id' }
      },
      required: ['chat_id']
    }
  },
  {
    name: 'list_character_cards',
    description: '列出所有角色（AI）的 id、名称、关系。用于了解当前有哪些角色、获取角色名称。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'ui_control',
    description: '控制应用内界面操作：切换玻璃模式、切换主题、设置聊天背景、滚动消息、切换表情面板、清空对话。当用户要求"打开玻璃模式""换个主题""清空聊天"等应用内操作时使用。可用 action: ' + UI_CONTROL_HINT,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '要执行的 UI 动作名，如 toggle_glass / set_theme / set_chat_bg / scroll_to_bottom / clear_chat 等' },
        params: { type: 'object', description: '动作参数对象。如 set_theme 传 {theme: "dark"}；set_chat_bg 传 {bg: "bg1"}' }
      },
      required: ['action']
    }
  }
]

export default {
  TOOL_DEFINITIONS: TOOL_DEFINITIONS,
  isChatTool: isChatTool,
  isUiControlTool: isUiControlTool,
  execute: execute,
  listChats: listChats,
  findChat: findChat,
  readMessages: readMessages,
  renameChat: renameChat,
  deleteChat: deleteChat,
  listCharacterCards: listCharacterCards
}
