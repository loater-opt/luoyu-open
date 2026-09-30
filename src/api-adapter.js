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
import serverConfig from './stubs/server-config.js'

// ======== 提供商注册表 ========

var PROVIDERS = {
  deepseek:    { type: 'openai', baseUrl: 'https://api.deepseek.com/v1/chat/completions',                       defaultModel: 'deepseek-chat' },
  kimi:        { type: 'openai', baseUrl: 'https://api.moonshot.cn/v1/chat/completions',                       defaultModel: 'moonshot-v1-8k' },
  doubao:      { type: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',          defaultModel: 'doubao-seed-1-6-250615' },
  siliconflow: { type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',                    defaultModel: 'deepseek-ai/DeepSeek-V3' },
  zhipu:       { type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',              defaultModel: 'glm-4' },
  tongyi:      { type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', defaultModel: 'qwen-plus' },
  custom:      { type: 'openai', baseUrl: '',                                                                   defaultModel: '' }
}

// ======== 工具函数 ========

/**
 * 把端点拆成 { origin, segments }；不是 http(s) 端点时返回 null
 * 例：https://api.deepseek.com/v1 → { origin:'https://api.deepseek.com', segments:['v1'] }
 */
function splitEndpoint(u) {
  var m = String(u || '').match(/^(https?:\/\/[^/?#]+)((?:\/[^?#]*)?)$/i)
  if (!m) return null
  var segs = (m[2] || '').split('/').filter(function (x) { return x.length > 0 })
  return { origin: m[1].replace(/\/+$/, ''), segments: segs }
}

// 路径段是不是「版本段」：v1 / v4 / v1beta / api-v2 ...
function isVersionSegment(s) {
  return /^(?:api[-_]?)?v\d+(?:[a-z]*\d*)?$/i.test(String(s || ''))
}

/**
 * 补全聊天端点 URL
 *
 * 用户填的可能是「基地址」（https://api.deepseek.com），也可能是「完整端点」
 * （https://api.deepseek.com/v1/chat/completions），还可能是自建反代的任意路径。
 * 补全只依据 URL 自身形态推导，不针对具体厂商：
 *   - 末尾带 # → 用户要求原样使用（去掉 # 和末尾斜杠）
 *   - 路径末两段是 chat/completions → 已经是完整端点，原样用
 *   - 路径为空 → 按 OpenAI 兼容端点的通行约定补 /v1/chat/completions
 *   - 路径只有一段且是版本段（/v1、/v4、/api/v3）→ 在其后补 chat/completions
 *   - 其余自定义路径 → 原样用，不替用户猜
 */
function buildChatUrl(baseUrl) {
  var raw = String(baseUrl || '').trim()
  if (!raw) return raw
  var forceRaw = raw.charAt(raw.length - 1) === '#'
  var trimmed = raw.replace(/#+$/, '').replace(/\/+$/, '')
  var ep = splitEndpoint(trimmed)
  if (!ep) return forceRaw ? trimmed : raw
  if (forceRaw) return trimmed
  var seg = ep.segments
  var n = seg.length
  if (n >= 2 && seg[n - 1] === 'completions' && seg[n - 2] === 'chat') return trimmed
  if (n === 0) return ep.origin + '/v1/chat/completions'
  if (isVersionSegment(seg[n - 1])) return trimmed + '/chat/completions'
  return trimmed
}

/**
 * 从聊天端点派生 /models 地址（各家 OpenAI 兼容端点都遵循这个约定）
 * 如 https://api.example.com/v1/chat/completions → https://api.example.com/v1/models
 */
function buildModelsUrl(chatEndpoint) {
  var raw = String(chatEndpoint || '').trim()
  if (!raw) return ''
  var url = raw.replace(/\/+$/, '')
  // 剥掉 /chat/completions
  if (url.indexOf('/chat/completions') !== -1) {
    url = url.replace(/\/chat\/completions$/i, '')
  }
  // 版本路径结尾（/v1|/v2|/v3|/v4...）→ /vN/models（智谱 v4、豆包 v3 等各自正确）
  if (/\/v\d+$/i.test(url)) return url + '/models'
  var m = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i)
  if (!m) return raw
  var path = (m[1] || '').replace(/\/+$/, '')
  // 空路径 → /v1/models
  if (!path) return url + '/v1/models'
  // 其他路径：若包含 /vN 则截到版本路径之前再拼 /v1/models
  var vm = url.match(/^(.*\/)v\d+(\/.*)?$/i)
  if (vm) return vm[1].replace(/\/+$/, '') + '/v1/models'
  return url + '/v1/models'
}

/**
 * 从端点里取出主机名；取不到返回空串
 * 支持 https://host:port/path、host:port、[::1]:port 三种写法
 */
function extractHost(endpoint) {
  var s = String(endpoint || '').trim()
  if (!s) return ''
  var m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
  var authority = m ? m[1] : (s.indexOf('/') === -1 ? s : '')
  if (!authority) return ''
  authority = authority.split('@').pop()          // 去掉 user:pass@
  if (authority.charAt(0) === '[') {              // [::1]:8080
    var end = authority.indexOf(']')
    return end > 0 ? authority.slice(1, end).toLowerCase() : ''
  }
  return authority.split(':')[0].toLowerCase()
}

// 主机名是不是「本机」的叫法
function isLocalHostName(h) {
  return h === 'localhost' || /\.localhost$/.test(h)
}

// 主机地址是不是本机地址
function isLocalAddress(h) {
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  if (h === '0.0.0.0') return true                 // 监听全网的写法，实际指向本机
  if (h === '10.0.2.2') return true                // Android 模拟器访问宿主机的固定别名（真机不存在）
  var v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!v4) return false
  for (var i = 1; i <= 4; i++) if (Number(v4[i]) > 255) return false
  return Number(v4[1]) === 127                     // 127.0.0.0/8 整段都是本机回环
}

/**
 * 端点是否指向本机上的本地服务
 *
 * 用途：用户把自己电脑上跑的本地模型（Ollama、LM Studio 之类）接到落雨时，
 * 这类地址通常不需要 API Key，界面要给出对应提示。
 * 判定方式：取出主机名后按「本机叫法 / 本机地址」两类判断，不做字符串白名单枚举。
 */
function isLoopbackEndpoint(endpoint) {
  var host = extractHost(endpoint)
  if (!host) return false
  return isLocalHostName(host) || isLocalAddress(host)
}

/**
 * 获取提供商的类型
 */
function getProviderType(config) {
  var provider = config.provider || 'deepseek'
  var info = PROVIDERS[provider]
  return info ? info.type : 'openai'
}

/**
 * 获取 API 基地址（去除末尾斜杠）
 */
function getBaseUrl(config) {
  var provider = config.provider || 'deepseek'
  var url = config.apiUrl
  if (!url) {
    var info = PROVIDERS[provider]
    url = info ? info.baseUrl : ''
  }
  return (url || '').replace(/\/+$/, '')
}

/**
 * 构建 provider 信息对象用于 api-setting 等页面
 */
function getProviderInfo(providerId) {
  return PROVIDERS[providerId] || null
}

// ======== 多模态与工具调用 ========

// 媒体链接正则：http(s) URL 以图片/音频/视频扩展名结尾
var IMAGE_URL_RE = /https?:\/\/[^\s"'<>\]\)]+\.(jpg|jpeg|png|gif|webp|bmp)(\?[^\s]*)?/gi
var AUDIO_URL_RE = /https?:\/\/[^\s"'<>\]\)]+\.(mp3|wav|ogg|webm|m4a|aac|flac)(\?[^\s]*)?/gi
var VIDEO_URL_RE = /https?:\/\/[^\s"'<>\]\)]+\.(mp4|avi|mov|wmv|flv|mkv|webm)(\?[^\s]*)?/gi
// data URL：data:image/jpeg;base64,xxxx
var DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi
var DATA_AUDIO_RE = /data:audio\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi
var DATA_VIDEO_RE = /data:video\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi

// 扩展名 → MIME 映射
var EXT_MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', avi: 'video/x-msvideo', mov: 'video/quicktime',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mkv: 'video/x-matroska'
}

/**
 * 从 URL 推断 MIME 类型
 */
function inferMimeType(url) {
  var lower = (url || '').toLowerCase()
  if (lower.indexOf('data:') === 0) {
    var m = lower.match(/data:([^;,]+)/)
    return m ? m[1] : ''
  }
  var extMatch = lower.match(/\.([a-z0-9]+)(\?|$|#)/)
  if (!extMatch) return ''
  return EXT_MIME_MAP[extMatch[1]] || ''
}

// OpenAI input_audio.format 我们实际支持并会送出去的取值
var AUDIO_FORMATS = ['wav', 'mp3', 'ogg', 'webm', 'mp4', 'aac', 'flac']
// 认不出音频类型时用哪种格式（wav 是各家的最小公约数）
var DEFAULT_AUDIO_FORMAT = 'wav'
// MIME 子类型 → input_audio.format
var AUDIO_MIME_TO_FORMAT = {
  'wav': 'wav', 'x-wav': 'wav', 'wave': 'wav', 'vnd.wave': 'wav',
  'mpeg': 'mp3', 'mp3': 'mp3', 'x-mp3': 'mp3',
  'ogg': 'ogg', 'opus': 'ogg', 'x-ogg': 'ogg',
  'webm': 'webm', 'x-webm': 'webm',
  'mp4': 'mp4', 'm4a': 'mp4', 'x-m4a': 'mp4',
  'aac': 'aac', 'x-aac': 'aac',
  'flac': 'flac', 'x-flac': 'flac'
}

/**
 * 音频格式映射（OpenAI input_audio 的 format 字段）
 * 按 MIME 的子类型查表；带参数（audio/webm;codecs=opus）时只取主类型部分。
 */
function audioFormatFromMime(mimeType) {
  var m = String(mimeType || '').toLowerCase().split(';')[0].trim()
  var sub = m.indexOf('/') !== -1 ? m.slice(m.indexOf('/') + 1) : m
  return AUDIO_MIME_TO_FORMAT[sub] || DEFAULT_AUDIO_FORMAT
}

/**
 * 构建多模态 content 数组
 * 依据消息文本里出现的媒体链接拼装内容数组
 *
 * @param {String} text 消息文本（可能包含媒体 URL 或 data URL）
 * @param {Object} config 含 capVision/capAudio/capVideo 开关
 * @returns {Array|String} 若检测到媒体则返回 content 数组，否则返回原文本
 */
function buildMultimodalContent(text, config) {
  if (!text || typeof text !== 'string') return text

  var capVision = config.capVision !== false
  var capAudio = !!config.capAudio
  var capVideo = !!config.capVideo

  var imageLinks = []
  var audioLinks = []
  var videoLinks = []

  // 收集所有匹配的媒体链接（注意：正则有 g 标志，需重置 lastIndex）
  function collectAll(re) {
    re.lastIndex = 0
    var out = []
    var m
    while ((m = re.exec(text)) !== null) {
      out.push(m[0])
    }
    return out
  }

  if (capVision) {
    imageLinks = imageLinks.concat(collectAll(IMAGE_URL_RE)).concat(collectAll(DATA_IMAGE_RE))
  }
  if (capAudio) {
    audioLinks = audioLinks.concat(collectAll(AUDIO_URL_RE)).concat(collectAll(DATA_AUDIO_RE))
  }
  if (capVideo) {
    videoLinks = videoLinks.concat(collectAll(VIDEO_URL_RE)).concat(collectAll(DATA_VIDEO_RE))
  }

  var hasMedia = imageLinks.length > 0 || audioLinks.length > 0 || videoLinks.length > 0
  if (!hasMedia) return text

  // 从文本中移除已识别的媒体链接，保留剩余文本
  var textWithoutLinks = text
  var allLinks = imageLinks.concat(audioLinks).concat(videoLinks)
  for (var i = 0; i < allLinks.length; i++) {
    // 转义正则特殊字符
    var safe = allLinks[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    textWithoutLinks = textWithoutLinks.replace(new RegExp(safe, 'g'), '')
  }
  textWithoutLinks = textWithoutLinks.replace(/\s{2,}/g, ' ').trim()

  // 内容数组的排布：媒体片段集中在前（音频 → 视频 → 图片），文本放在最后收尾。
  // 这样模型先拿到素材再读文字说明，出错的概率更低；顺序固定也便于排查请求。
  var contentArray = []

  // 音频：OpenAI input_audio 格式
  for (var a = 0; a < audioLinks.length; a++) {
    var aUrl = audioLinks[a]
    var aMime = inferMimeType(aUrl)
    if (aUrl.indexOf('data:') === 0) {
      // data:audio/xxx;base64,xxxx
      var aParts = aUrl.split(',', 2)
      var aBase64 = aParts[1] || ''
      contentArray.push({
        type: 'input_audio',
        input_audio: { data: aBase64, format: audioFormatFromMime(aMime) }
      })
    } else {
      // http 链接：OpenAI 多模态音频仅支持 base64，跳过（需先下载）
      // 这里保留为文本提示，避免请求失败
      contentArray.push({ type: 'text', text: '[音频链接] ' + aUrl })
    }
  }

  // 视频：OpenAI video_url 格式（与 image_url 对称）
  for (var v = 0; v < videoLinks.length; v++) {
    var vUrl = videoLinks[v]
    var vMime = inferMimeType(vUrl)
    if (vUrl.indexOf('data:') === 0) {
      var vParts = vUrl.split(',', 2)
      var vBase64 = vParts[1] || ''
      contentArray.push({
        type: 'video_url',
        video_url: { url: 'data:' + vMime + ';base64,' + vBase64 }
      })
    } else {
      // http 链接：直接用 URL（部分 API 支持）
      contentArray.push({
        type: 'video_url',
        video_url: { url: vUrl }
      })
    }
  }

  // 图片：OpenAI image_url 格式
  for (var im = 0; im < imageLinks.length; im++) {
    var imgUrl = imageLinks[im]
    contentArray.push({
      type: 'image_url',
      image_url: { url: imgUrl }
    })
  }

  // 剩余文本
  if (textWithoutLinks.length > 0) {
    contentArray.push({ type: 'text', text: textWithoutLinks })
  }

  return contentArray
}

/**
 * 处理消息列表：将包含媒体链接的文本消息转为多模态 content
 * 已是数组的 content 根据 cap 开关过滤
 *
 * @param {Array} messages 消息列表
 * @param {Object} config 含 capVision/capAudio/capVideo
 * @returns {Array} 处理后的消息列表
 */
function processMultimodalMessages(messages, config) {
  if (!messages || !messages.length) return messages
  var result = []
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i]
    if (!msg) { result.push(msg); continue }

    // 重建消息时保留扩展字段（tool_calls / tool_call_id / name / id 等），否则工具调用回传会丢字段导致 API 400
    var keepExtra = function(nm) {
      for (var k in msg) {
        if (k !== 'role' && k !== 'content' && !(k in nm)) nm[k] = msg[k]
      }
      return nm
    }

    if (typeof msg.content === 'string') {
      // 文本消息：检测媒体链接
      var processed = buildMultimodalContent(msg.content, config)
      result.push(keepExtra({ role: msg.role, content: processed }))
    } else if (Array.isArray(msg.content)) {
      // 已是多模态：根据开关过滤媒体类型
      var filtered = []
      for (var j = 0; j < msg.content.length; j++) {
        var part = msg.content[j]
        if (part && part.type === 'image_url' && config.capVision === false) {
          // 关闭识图时，跳过图片
          continue
        }
        if (part && part.type === 'input_audio' && !config.capAudio) {
          continue
        }
        if (part && part.type === 'video_url' && !config.capVideo) {
          continue
        }
        filtered.push(part)
      }
      // 如果过滤后只剩文本或为空，转回字符串
      if (filtered.length === 0) {
        result.push(keepExtra({ role: msg.role, content: '' }))
      } else if (filtered.length === 1 && filtered[0].type === 'text') {
        result.push(keepExtra({ role: msg.role, content: filtered[0].text }))
      } else {
        result.push(keepExtra({ role: msg.role, content: filtered }))
      }
    } else {
      result.push(msg)
    }
  }
  return result
}

// ======== ToolCall 支持 ========

/**
 * 构建 tools 字段
 * @param {Array} tools 工具定义数组 [{name, description, parameters}]
 * @returns {Array} OpenAI tools 格式
 */
function buildToolDefinitions(tools) {
  if (!tools || !tools.length) return []
  var result = []
  for (var i = 0; i < tools.length; i++) {
    var t = tools[i]
    if (!t || !t.name) continue
    result.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {}, required: [] }
      }
    })
  }
  return result
}

/**
 * 从 AI 响应中提取 tool_calls 并转为可处理格式
 * 这里只取结构化对象（{ id, name, arguments }），不做 XML 往返转换
 *
 * @param {Object} response API 响应数据
 * @returns {Object} { hasToolCalls: bool, toolCalls: [...], content: '...' }
 */
function extractToolCalls(response) {
  if (!response || !response.choices || !response.choices[0]) {
    return { hasToolCalls: false, toolCalls: [], content: '' }
  }
  var msg = response.choices[0].message || {}
  var toolCalls = msg.tool_calls || []
  if (!toolCalls.length) {
    return { hasToolCalls: false, toolCalls: [], content: msg.content || '' }
  }

  var parsed = []
  for (var i = 0; i < toolCalls.length; i++) {
    var tc = toolCalls[i]
    var fn = tc.function || {}
    var args = {}
    if (fn.arguments) {
      try { args = JSON.parse(fn.arguments) } catch (e) { args = { _raw: fn.arguments } }
    }
    parsed.push({
      id: tc.id || ('call_' + i),
      name: fn.name || '',
      arguments: args
    })
  }
  return {
    hasToolCalls: true,
    toolCalls: parsed,
    content: msg.content || ''
  }
}

// ======== API 调用 ========

// 参数类型 → 写入请求体前的归一化处理
// （请求体是 JSON，整数/浮点要按各自规矩取整，字符串原样，布尔原样）
var PARAM_COERCERS = {
  int: function (v) { var n = Math.round(Number(v)); return isFinite(n) ? n : null },
  float: function (v) { var n = Number(Number(v).toFixed(4)); return isFinite(n) ? n : null },
  string: function (v) { return v === undefined || v === null ? null : String(v) },
  bool: function (v) { return v === true || v === 'true' || v === 1 || v === '1' },
  // 未声明类型的参数按原值透传
  raw: function (v) { return v }
}

// 参数取值下限：低于下限的值一律不发送（max_tokens 给 0/负数会让模型返回空回复）
// 只对确实会出问题的参数设下限，其余参数交给服务端判断，避免误伤用户的有效配置
var PARAM_MIN = { max_tokens: 1 }

/**
 * 把用户配置的模型参数写进请求体
 *
 * 参数来自两处：内置参数（带类型与开关键）与用户自定义参数（原样透传）。
 * 处理顺序：先内置后自定义 —— 自定义同名参数会覆盖内置值，方便用户兜底。
 *
 * @param {Object} requestData 请求体（会被就地修改）
 * @param {Object} config 含 modelParams / modelCustomParams
 */
function injectModelParams(requestData, config) {
  if (!config || !requestData) return
  var groups = [config.modelParams, config.modelCustomParams]
  for (var g = 0; g < groups.length; g++) {
    var list = groups[g]
    if (!list || !list.length) continue
    for (var i = 0; i < list.length; i++) {
      var p = list[i]
      if (!p || p.enabled === false || !p.apiName) continue
      var coerce = PARAM_COERCERS[p.valueType] || PARAM_COERCERS.raw
      var val = coerce(p.value)
      if (val === null || val === undefined) continue
      if (typeof val === 'number') {
        var floor = PARAM_MIN[p.apiName]
        if (floor !== undefined && val < floor) continue
      }
      requestData[p.apiName] = val
    }
  }
}

/**
 * 合并用户自定义请求头
 * 支持两种格式：
 *   - 数组：[{ name: 'X-API-Key', value: 'xxx', enabled: true }, ...]
 *   - 对象：{ 'X-API-Key': 'xxx' }
 * @param {Object} headers 基础请求头
 * @param {Object} config 含 customHeaders
 * @returns {Object} 合并后的请求头
 */
function mergeCustomHeaders(headers, config) {
  if (!config || !headers) return headers
  var ch = config.customHeaders
  if (!ch) return headers
  if (Array.isArray(ch)) {
    for (var i = 0; i < ch.length; i++) {
      var h = ch[i]
      if (h && h.enabled !== false && h.name) {
        headers[String(h.name).trim()] = String(h.value != null ? h.value : '')
      }
    }
  } else if (typeof ch === 'object') {
    for (var k in ch) {
      headers[k] = ch[k]
    }
  }
  return headers
}

/**
 * 直接调用 OpenAI 兼容 API
 * 支持 capVision/capAudio/capVideo 多模态开关
 * 支持 capToolCall 工具调用开关
 * @returns {Promise<Object>} 响应数据（已解析 JSON）
 */
function callOpenAICompatible(config, messages, options) {
  return new Promise(function(resolve, reject) {
    var apiUrl = buildChatUrl(getBaseUrl(config))

    // 处理多模态消息（识图/音频/视频）
    var processedMessages = processMultimodalMessages(messages, config)

    var requestData = {
      model: config.modelName || 'deepseek-chat',
      messages: processedMessages,
      max_tokens: options.max_tokens || 1500
    }

    if (options.temperature !== undefined) {
      requestData.temperature = options.temperature
    } else {
      requestData.temperature = 0.8
    }

    if (options.top_p !== undefined) requestData.top_p = options.top_p
    if (options.stream) requestData.stream = true

    // 注入用户启用的模型参数
    injectModelParams(requestData, config)

    // ToolCall：若开启且有工具定义，添加 tools 和 tool_choice
    if (config.capToolCall && options.tools && options.tools.length > 0) {
      var tools = buildToolDefinitions(options.tools)
      if (tools.length > 0) {
        requestData.tools = tools
        requestData.tool_choice = options.tool_choice || 'auto'
      }
    }

    var headers = {
      'Authorization': 'Bearer ' + (config.apiKey || ''),
      'Content-Type': 'application/json'
    }
    mergeCustomHeaders(headers, config)

    uni.request({
      url: apiUrl,
      method: 'POST',
      timeout: options.timeout || 60000,
      header: headers,
      data: JSON.stringify(requestData),
      success: function(res) {
        if (res.statusCode === 200 && res.data) {
          // 若启用 ToolCall，解析 tool_calls
          if (config.capToolCall && res.data.choices && res.data.choices[0]) {
            var tcInfo = extractToolCalls(res.data)
            if (tcInfo.hasToolCalls) {
              res.data._toolCalls = tcInfo.toolCalls
            }
          }
          resolve(res.data)
        } else {
          var errMsg = 'API error ' + (res.statusCode || '?')
          if (res.data && res.data.error) {
            errMsg = res.data.error.message || res.data.error.type || errMsg
          }
          reject(new Error(errMsg))
        }
      },
      fail: function(err) {
        reject(new Error(err.errMsg || 'Network request failed'))
      }
    })
  })
}

// ======== 主入口 ========

// ===== API 提供商控制（后台可随时关闭提供商/自定义 API，封禁中转站用） =====

var API_CONTROL_URL = serverConfig.apiUrl('/api-control')
var API_CONTROL_TTL = 5 * 60 * 1000 // 控制配置缓存 5 分钟

// 自接 API 闸门延迟（毫秒）：服务器限速生效时，自接 API 发送会延迟这么久再真正发出
var SELF_GATE_DELAY = 20000

// 读取缓存的控制配置；过期或缺失返回 null
function getApiControlCache() {
  try {
    var raw = uni.getStorageSync('api_control_cache')
    if (!raw) return null
    var o = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!o || !o.data) return null
    if (!o.time || Date.now() - Number(o.time) > API_CONTROL_TTL) return null
    return o.data
  } catch (e) { return null }
}

// 后台静默刷新控制配置（不阻塞主流程）
function refreshApiControl() {
  try {
    // 自接 API 使用上报：用户未开启会员一键使用、且配置了自己的 API Key（自接 API）时带 self=1，
    // 服务器记录统计（后台可见）并返回闸门状态 gate（限速时 App 端延迟发送）。
    // 限速配置本身不会返回给 App 端，用户解包也看不到。
    var selfFlag = ''
    try {
      var cfg0 = uni.getStorageSync('api_config')
      var memberOn = !!uni.getStorageSync('member_mode_on')
      if (cfg0 && !memberOn) {
        var o0 = typeof cfg0 === 'string' ? (JSON.parse(cfg0) || {}) : cfg0
        var hasKey = o0 && (o0.apiKey || (o0.provider === 'custom' && o0.apiUrl))
        if (hasKey) selfFlag = '&self=1'
      }
    } catch (e) {}
    var url = API_CONTROL_URL + '?_t=' + Date.now() + selfFlag
    // 附带 uid（登录用户）与设备标识，供服务器去重统计
    try {
      var tok = uni.getStorageSync('member_token')
      if (tok) url += '&uid=' + encodeURIComponent(String(tok).substring(0, 24))
    } catch (e) {}
    try {
      var devId = uni.getStorageSync('member_device_id')
      if (devId) url += '&dev=' + encodeURIComponent(String(devId))
    } catch (e) {}
    uni.request({
      url: url,
      method: 'GET',
      timeout: 8000,
      success: function(res) {
        if (res.data && res.data.code === 0 && res.data.data) {
          uni.setStorageSync('api_control_cache', JSON.stringify({ data: res.data.data, time: Date.now() }))
        }
      },
      fail: function() {}
    })
  } catch (e) {}
}

// 校验是否允许使用当前配置；被拦截返回 { blocked: true, msg }，否则 null
function checkApiControl(config, hasVision) {
  try {
    var c = getApiControlCache()
    if (!c) return null // 未获取到控制配置，不拦截
    if (c.enabled === false) {
      return { blocked: true, msg: (c.notice || 'AI 服务已由官方暂时关闭，请稍后再试') }
    }
    if (hasVision) {
      var vp = config.visionProvider || ''
      if (vp === 'custom' && c.customVision === false) {
        return { blocked: true, msg: (c.notice || '自定义 API 已被官方关闭，请更换视觉提供商') }
      }
      if (vp && (c.disabledVisionProviders || []).indexOf(vp) !== -1) {
        return { blocked: true, msg: (c.notice || '该视觉提供商已被官方关闭，请更换') }
      }
      return null
    }
    var p = config.provider || 'deepseek'
    if (p === 'custom' && c.customChat === false) {
      return { blocked: true, msg: (c.notice || '自定义 API 已被官方关闭，请更换提供商') }
    }
    if ((c.disabledChatProviders || []).indexOf(p) !== -1) {
      return { blocked: true, msg: (c.notice || '该提供商已被官方关闭，请更换') }
    }
  } catch (e) {}
  return null
}

// 判断消息里是否含图片（视觉调用）
function messagesHaveImage(messages) {
  try {
    if (!messages || !messages.length) return false
    for (var i = 0; i < messages.length; i++) {
      var c = messages[i] && messages[i].content
      if (!c) continue
      if (Array.isArray(c)) {
        for (var j = 0; j < c.length; j++) {
          if (c[j] && (c[j].type === 'image' || (c[j].type === 'image_url') || /data:image/.test(String(c[j].image_url || c[j].url || '')))) return true
        }
      } else if (/data:image\//.test(String(c))) {
        return true
      }
    }
  } catch (e) {}
  return false
}

/**
 * 统一 AI 调用入口
 */
function callAI(config, messages, options) {
  options = options || {}
  var ctl = checkApiControl(config, messagesHaveImage(messages))
  if (ctl) {
    refreshApiControl() // 缓存过期导致误拦时尝试刷新
    return Promise.reject(new Error(ctl.msg))
  }
  if (!getApiControlCache()) refreshApiControl() // 无缓存时后台拉取
  // 自接 API 闸门：后台开启自接 API 限速时，发送前先等服务端状态（发送会变慢，促使用户使用官方模型）
  var g = getSelfGate()
  if (g) {
    refreshApiControl()
    return new Promise(function(resolve, reject) {
      setTimeout(function() {
        callOpenAICompatible(config, messages, options).then(resolve, reject)
      }, SELF_GATE_DELAY)
    })
  }
  return callOpenAICompatible(config, messages, options)
}

// 读取闸门状态：0/undefined = 放行；1 = 自接 API 限速生效（延迟发送）
function getSelfGate() {
  try {
    var c = getApiControlCache()
    if (c && c.gate === 1) return true
  } catch (e) {}
  return false
}

// ======== 模型列表获取 ========

/**
 * 获取模型列表（适配不同 provider 的认证头和端点）
 * @returns {Promise<Array>} [{id: 'model-name'}, ...]
 */
function fetchModelList(config) {
  return new Promise(function(resolve, reject) {
    var baseUrl = getBaseUrl(config)

    if (!baseUrl) {
      reject(new Error('请先填写 API 地址'))
      return
    }

    var modelsUrl = buildModelsUrl(baseUrl)

    var headers = { 'Content-Type': 'application/json' }
    if (config.apiKey) {
      headers['Authorization'] = 'Bearer ' + config.apiKey
    }
    mergeCustomHeaders(headers, config)

    uni.request({
      url: modelsUrl,
      method: 'GET',
      header: headers,
      timeout: 10000,
      success: function(res) {
        var models = parseModelList(res.data)
        if (models.length > 0) {
          resolve(models)
        } else {
          // 兼容路径：/v1/models 不可用时改用 /models 再试一次
          var altUrl = modelsUrl.replace(/\/v\d+\/models$/i, '/models')
          if (altUrl === modelsUrl) {
            resolve([])
            return
          }
          uni.request({
            url: altUrl,
            method: 'GET',
            header: headers,
            timeout: 10000,
            success: function(r2) {
              resolve(parseModelList(r2.data))
            },
            fail: function() {
              resolve([])
            }
          })
        }
      },
      fail: function(err) {
        reject(new Error(err.errMsg || '获取模型列表失败'))
      }
    })
  })
}

/**
 * 解析模型列表响应（兼容多种响应格式）
 */
function parseModelList(data) {
  var models = []
  if (!data) return models

  if (data.data && Array.isArray(data.data)) {
    for (var i = 0; i < data.data.length; i++) {
      var m = data.data[i]
      if (typeof m === 'string') {
        models.push({ id: m })
      } else if (m && m.id) {
        models.push({ id: m.id })
      } else if (m && m.name) {
        models.push({ id: m.name })
      } else if (m && m.model) {
        models.push({ id: m.model })
      }
    }
  } else if (Array.isArray(data)) {
    for (var j = 0; j < data.length; j++) {
      var item = data[j]
      if (typeof item === 'string') {
        models.push({ id: item })
      } else if (item && item.id) {
        models.push({ id: item.id })
      }
    }
  }
  return models
}

// ======== 连接测试 ========

/**
 * 测试 API 连接
 * @returns {Promise<Object>} {success: true/false, message: '...'}
 */
function testConnection(config) {
  return new Promise(function(resolve, reject) {
    if (!config.apiKey) {
      resolve({ success: false, message: '请填写 API Key' })
      return
    }
    if (!config.modelName) {
      resolve({ success: false, message: '请选择模型' })
      return
    }

    var chatUrl = buildChatUrl(getBaseUrl(config))

    var headers = {
      'Authorization': 'Bearer ' + config.apiKey,
      'Content-Type': 'application/json'
    }
    mergeCustomHeaders(headers, config)

    uni.request({
      url: chatUrl,
      method: 'POST',
      timeout: 15000,
      header: headers,
      data: {
        model: config.modelName,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5
      },
      success: function(res) {
        if (res.statusCode === 200 && res.data && res.data.choices) {
          resolve({ success: true, message: '连接成功' })
        } else {
          var msg = '连接失败 (' + (res.statusCode || '?') + ')'
          if (res.data && res.data.error) {
            msg = res.data.error.message || msg
          }
          resolve({ success: false, message: msg })
        }
      },
      fail: function(err) {
        resolve({ success: false, message: err.errMsg || '网络请求失败' })
      }
    })
  })
}

// ======== 导出 ========

// uni-app ES 模块导出
export default {
  PROVIDERS: PROVIDERS,

  // 核心 API
  callAI: callAI,
  callOpenAICompatible: callOpenAICompatible,

  // 多模态与工具调用
  buildMultimodalContent: buildMultimodalContent,
  processMultimodalMessages: processMultimodalMessages,
  buildToolDefinitions: buildToolDefinitions,
  extractToolCalls: extractToolCalls,
  injectModelParams: injectModelParams,
  mergeCustomHeaders: mergeCustomHeaders,
  inferMimeType: inferMimeType,
  audioFormatFromMime: audioFormatFromMime,

  // 辅助功能
  fetchModelList: fetchModelList,
  testConnection: testConnection,
  getProviderInfo: getProviderInfo,
  getProviderType: getProviderType,
  getBaseUrl: getBaseUrl,
  buildChatUrl: buildChatUrl,
  buildModelsUrl: buildModelsUrl,
  isLoopbackEndpoint: isLoopbackEndpoint
}
