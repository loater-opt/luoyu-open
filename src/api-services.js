/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 */

// 落雨 API 服务：用户配置的开放平台 API 凭证，供 AI 对话中直接调用
//
// 用法：
//   import apiServices from './api-services.js'
//   apiServices.list()                        // 读取已配置服务
//   apiServices.call(服务名, 路径, 方法, body)  // 调用服务接口

var KEY = 'api_services'

function list() {
  try {
    var raw = uni.getStorageSync(KEY)
    var arr = (raw && raw.list) || []
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    return []
  }
}

function saveAll(arr) {
  uni.setStorageSync(KEY, { list: arr || [], updateTime: Date.now() })
  return arr
}

// 解析多行 KEY=VALUE 请求头文本
function parseHeaders(text) {
  var headers = {}
  var lines = String(text || '').split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line) continue
    var idx = line.indexOf('=')
    if (idx <= 0) continue
    headers[line.substring(0, idx).trim()] = line.substring(idx + 1).trim()
  }
  return headers
}

// 调用服务接口：service 名（或 id）+ path + method + body(JSON 字符串)
function call(serviceName, path, method, body) {
  var services = list()
  var svc = null
  for (var i = 0; i < services.length; i++) {
    if (services[i].name === serviceName || services[i].id === serviceName) {
      svc = services[i]
      break
    }
  }
  if (!svc || !svc.baseUrl) {
    return Promise.resolve({ code: -1, msg: '未找到 API 服务：' + serviceName + '（请先在 MCP 页「API 服务」里配置）' })
  }
  var url = String(svc.baseUrl).trim().replace(/\/+$/, '') + (path ? String(path) : '')
  var m = String(method || 'GET').toUpperCase()
  if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].indexOf(m) === -1) m = 'GET'
  var postData
  if (m !== 'GET' && body) {
    try { postData = JSON.parse(body) } catch (e) { postData = body }
  }
  return new Promise(function(resolve) {
    uni.request({
      url: url,
      method: m,
      timeout: 20000,
      header: Object.assign({ 'Content-Type': 'application/json' }, svc.headers || {}),
      data: postData,
      success: function(res) {
        var text = res.data
        if (typeof text !== 'string') {
          try { text = JSON.stringify(text) } catch (e) { text = String(text) }
        }
        resolve({ code: 0, content: String(text || '').substring(0, 4000) })
      },
      fail: function(err) {
        resolve({ code: -1, msg: (err.errMsg || '请求失败') })
      }
    })
  })
}

export default {
  KEY: KEY,
  list: list,
  saveAll: saveAll,
  parseHeaders: parseHeaders,
  call: call
}
