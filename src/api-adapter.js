/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * api-adapter.js — 统一 AI API 调用层
 *
 * 屏蔽不同 AI 提供商（OpenAI 兼容、Anthropic Claude）的差异，
 * 提供统一的调用接口。所有页面的 AI 请求均通过此模块。
 *
 * 使用方式：
 *   var apiAdapter = require('./api-adapter.js')
 *   apiAdapter.callAI(config, messages, options).then(function(result) { ... })
 *
 * config 结构（与 api_config 存储一致）：
 *   {
 *     provider: 'deepseek' | 'anthropic' | 'siliconflow' | 'zhipu' | 'tongyi' | 'custom',
 *     apiKey: 'sk-...',
 *     apiUrl: 'https://api.deepseek.com',
 *     modelName: 'deepseek-chat',
 *     useVision: false,
 *     visionModelName: '',
 *     visionApiUrl: '',
 *     visionApiKey: ''
 *   }
 */

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
 * 构建 /chat/completions URL
 *
 * 规则：
 *  - URL 末尾加 # → 禁用自动补全，去掉 # 后原样返回
 *  - 已包含 /chat/completions → 原样返回（完整端点）
 *  - 空路径（如 https://api.example.com）→ 补 /v1/chat/completions
 *  - 以 /v1 /v2 /v3 /v4 结尾（如 https://my-proxy/custom/v1）→ 补 /chat/completions
 *  - 其他带路径的情况（用户填了完整端点或自定义路径）→ 原样返回，不再拼接
 */
function buildChatUrl(baseUrl) {
  var raw = String(baseUrl || '').trim()
  if (!raw) return raw
  // # 后缀 → 禁用自动补全
  if (raw.charAt(raw.length - 1) === '#') {
    return raw.slice(0, -1).replace(/\/+$/, '')
  }
  if (raw.indexOf('/chat/completions') !== -1) return raw
  var url = raw.replace(/\/+$/, '')
  // 非 URL（缺协议/主机）→ 原样返回
  var m = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i)
  if (!m) return raw
  var path = (m[1] || '').replace(/\/+$/, '')
  // 空路径 → 补标准路径
  if (!path) return url + '/v1/chat/completions'
  // 版本路径结尾（/v1|/v2|/v3|/v4...）→ 仅补后续部分
  if (/\/v\d+$/i.test(path)) return url + '/chat/completions'
  // 其他路径：视为用户填写的完整端点，原样返回
  return raw
}

/**
 * 从聊天端点派生 /models 地址
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
 * 判断端点是否为本地回环地址（localhost / 127.0.0.1 等）
 * 用于本地服务（如自定义 API 指向本机）时免填 API Key
 */
function isLoopbackEndpoint(endpoint) {
  var raw = String(endpoint || '').trim().toLowerCase()
  if (!raw) return false
  var hostMatch = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
  var host = hostMatch ? hostMatch[1] : ''
  if (host) {
    var h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '10.0.2.2') return true
  }
  return raw.indexOf('localhost:') === 0 || raw.indexOf('127.0.0.1:') === 0 ||
    raw.indexOf('[::1]:') === 0 || raw.indexOf('::1:') === 0 ||
    raw.indexOf('0.0.0.0:') === 0 || raw.indexOf('10.0.2.2:') === 0
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

/**
 * 音频格式映射（OpenAI input_audio 的 format 字段）
 */
function audioFormatFromMime(mimeType) {
  var m = (mimeType || '').toLowerCase()
  if (m.indexOf('wav') !== -1) return 'wav'
  if (m.indexOf('mpeg') !== -1 || m.indexOf('mp3') !== -1) return 'mp3'
  if (m.indexOf('ogg') !== -1) return 'ogg'
  if (m.indexOf('webm') !== -1) return 'webm'
  if (m.indexOf('mp4') !== -1 || m.indexOf('m4a') !== -1) return 'mp4'
  if (m.indexOf('aac') !== -1) return 'aac'
  if (m.indexOf('flac') !== -1) return 'flac'
  return 'wav'
}

/**
 * 构建多模态 content 数组
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

 // 按 顺序拼接：audio → video → image → text
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

/**
 * 向请求体注入已启用的模型参数与自定义参数
 * @param {Object} requestData 请求体
 * @param {Object} config 含 modelParams/modelCustomParams
 */
function injectModelParams(requestData, config) {
  if (!config) return
  if (config.modelParams && config.modelParams.length > 0) {
    for (var pi = 0; pi < config.modelParams.length; pi++) {
      var mp = config.modelParams[pi]
      if (mp && mp.enabled && mp.apiName) {
        var val = mp.value
        if (mp.valueType === 'int') val = Math.round(Number(val))
        else if (mp.valueType === 'float') val = Number(Number(val).toFixed(4))
        // 保护：max_tokens 非法值（空/0/负数）跳过，避免模型返回空回复
        if (mp.apiName === 'max_tokens' && (!val || val < 1)) continue
        requestData[mp.apiName] = val
      }
    }
  }
  if (config.modelCustomParams && config.modelCustomParams.length > 0) {
    for (var ci = 0; ci < config.modelCustomParams.length; ci++) {
      var cp = config.modelCustomParams[ci]
      if (cp && cp.enabled && cp.apiName) {
        requestData[cp.apiName] = cp.value
      }
    }
  }
}

/**
 * 合并自定义请求头
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

    // 注入已启用的模型参数
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

// ===== 配置校验（宿主实现） =====
//
//
// 开源版本通过接口桩放行全部请求，不做任何限制。
// 详见 stubs/api-control.js。

import apiControl from './stubs/api-control.js'

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
          // 尝试兼容路径：/v1/models 失败时退到 /models
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

  fetchModelList: fetchModelList,
  testConnection: testConnection,
  getProviderInfo: getProviderInfo,
  getProviderType: getProviderType,
  getBaseUrl: getBaseUrl,
  buildChatUrl: buildChatUrl,
  buildModelsUrl: buildModelsUrl,
  isLoopbackEndpoint: isLoopbackEndpoint
}
