/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * chat-mcp.js — 聊天里的 MCP / API 服务调用桥接
 *
 * 让用户在 MCP 页配置的「远程 MCP 服务器」和「API 服务」真正被 AI 在聊天中调用：
 *   1. getToolHint() 生成工具说明，注入聊天系统提示，让 AI 知道有哪些工具可用。
 *   2. AI 用标签调用：
 *      - MCP 工具：<mcp:工具名:{"参数":"值"}>
 *      - API 服务：<api:服务名:{"path":"/xx","method":"GET","body":{}}>
 *   3. callMcpTool / callApiService 执行对应调用，结果展示给用户。
 */
import mcp from './mcp.js'
import apiServices from './api-services.js'

// 已启用的 MCP 服务器
function loadServers() {
  const raw = uni.getStorageSync('mcp_list')
  let arr = []
  if (raw) {
    try { arr = typeof raw === 'string' ? (JSON.parse(raw) || []) : raw } catch (e) {}
  }
  if (!Array.isArray(arr)) arr = []
  return arr.filter(function(s) { return s && s.enabled !== false && s.url })
}

// 已启用的 API 服务
function loadApis() {
  const arr = apiServices.list()
  return arr.filter(function(a) { return a && a.enabled !== false })
}

// 生成工具说明（注入聊天系统提示）
function getToolHint() {
  const servers = loadServers()
  const apis = loadApis()
  const lines = []

  for (let i = 0; i < servers.length; i++) {
    const s = servers[i]
    const tools = s.lastTools || []
    for (let j = 0; j < tools.length; j++) {
      const t = tools[j] || {}
      const name = String(t.name || '')
      if (!name) continue
      const desc = String(t.description || '')
      let schema = '{}'
      if (t.inputSchema && t.inputSchema.properties) {
        try { schema = JSON.stringify(t.inputSchema.properties) } catch (e) {}
      }
      lines.push('- MCP 工具「' + name + '」（' + s.name + '）：' + desc + '，调用 <mcp:' + name + ':' + schema + '>')
    }
  }

  for (let k = 0; k < apis.length; k++) {
    const a = apis[k]
    lines.push('- API 服务「' + a.name + '」：' + (a.desc || '开放平台接口') + '，调用 <api:' + a.name + ':{"path":"/xx","method":"GET","body":{}}>')
  }

  if (lines.length === 0) return ''
  return '# 外部工具（可调用）\n' +
    '你可以在回复末尾输出标签来调用外部工具，工具结果会展示给用户：\n' +
    lines.join('\n')
}

// 调用 MCP 工具（用第一个已启用的服务器）
function callMcpTool(toolName, args) {
  const servers = loadServers()
  if (servers.length === 0) {
    return Promise.resolve({ code: -1, msg: '没有启用的 MCP 服务器' })
  }
  const s = servers[0]
  const headers = {}
  const env = s.env || {}
  const keys = Object.keys(env)
  for (let i = 0; i < keys.length; i++) headers[keys[i]] = env[keys[i]]
  return mcp.callTool(String(s.url || ''), headers, toolName, args)
}

// 调用 API 服务
function callApiService(name, params) {
  const path = params && params.path !== undefined ? String(params.path) : ''
  const method = params && params.method ? String(params.method) : 'GET'
  let body = ''
  if (params && params.body !== undefined && params.body !== null) {
    try { body = JSON.stringify(params.body) } catch (e) { body = String(params.body) }
  }
  return apiServices.call(name, path, method, body)
}

export default {
  loadServers: loadServers,
  loadApis: loadApis,
  getToolHint: getToolHint,
  callMcpTool: callMcpTool,
  callApiService: callApiService
}
