// 落雨 MCP 客户端
//
// 作用：让落雨作为 MCP 客户端，连接远程 HTTP/SSE 型 MCP 服务器（Model Context Protocol）。
// 协议：MCP streamable HTTP（2025-06-18），JSON-RPC 2.0 over POST。
// 说明：手机端没有 Linux/Node 环境，无法运行 stdio 型（npx/uvx）MCP 服务器，
//       因此本客户端只面向远程 HTTP/SSE 型服务器。
//
// 用法：
//   import mcp from './mcp.js'
//   mcp.test(url, headers)          -> Promise<{code, tools, msg}>  测试连接并列出工具
//   mcp.callTool(url, headers, name, args) -> Promise<{code, result, msg}>  调用工具

// 解析 HTTP 响应为 JSON：优先 JSON 单次响应；若为 SSE（text/event-stream）则解析首条 data 事件
function parseMcpResponse(body) {
  if (!body) return null
  var text = String(body)
  // 尝试直接 JSON
  try { return JSON.parse(text) } catch (e) { /* 不是纯 JSON */ }
  // SSE 流：取 data: 行（可多行，合并解析）
  var dataLines = []
  var lines = text.split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf('data:') === 0) {
      var v = line.substring(5).trim()
      if (v) dataLines.push(v)
    }
  }
  if (dataLines.length) {
    try {
      // 合并连续的 data 块（同一事件的多个 data 行用换行连接）
      var merged = dataLines.join('')
      return JSON.parse(merged)
    } catch (e2) {
      // 逐个尝试解析（事件边界），取第一个成功且带 id 的
      for (var j = 0; j < dataLines.length; j++) {
        try {
          var obj = JSON.parse(dataLines[j])
          if (obj && obj.id !== undefined) return obj
        } catch (e3) { /* ignore */ }
      }
      try { return JSON.parse(dataLines[0]) } catch (e4) { /* ignore */ }
    }
  }
  return null
}

// 发送一次 JSON-RPC 请求（单次 POST，不建立长连接）
function postRpc(url, headers, rpc) {
  return new Promise(function(resolve) {
    uni.request({
      url: url,
      method: 'POST',
      timeout: 15000,
      header: Object.assign({
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      }, headers || {}),
      data: rpc,
      dataType: 'text',
      success: function(res) {
        var parsed = parseMcpResponse(res.data)
        if (!parsed) {
          resolve({ code: -1, msg: '服务器响应无法解析（HTTP ' + (res.statusCode || '?') + '）', raw: String(res.data || '').substring(0, 200) })
          return
        }
        if (parsed.error) {
          resolve({ code: -1, msg: (parsed.error.message || 'MCP 错误') + (parsed.error.code !== undefined ? ' (code ' + parsed.error.code + ')' : '') })
          return
        }
        resolve({ code: 0, result: parsed.result || {} })
      },
      fail: function(err) {
        resolve({ code: -1, msg: (err.errMsg || '连接失败') })
      }
    })
  })
}

// 测试连接 + 拉取工具列表
function test(url, headers) {
  if (!url || !String(url).trim()) return Promise.resolve({ code: -1, msg: '缺少服务器 URL', tools: [] })
  var base = String(url).trim()
  var seq = 1
  // 1. initialize 握手
  return postRpc(base, headers, {
    jsonrpc: '2.0',
    id: seq,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'luoyu', version: '1.0' }
    }
  }).then(function(r0) {
    if (r0.code !== 0) return Promise.resolve({ code: r0.code, msg: '初始化失败：' + (r0.msg || ''), tools: [] })
    // 2. 通知服务器客户端已就绪（fire-and-forget，失败不阻塞）
    postRpc(base, headers, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    })
    // 3. 拉取工具列表
    seq++
    return postRpc(base, headers, {
      jsonrpc: '2.0',
      id: seq,
      method: 'tools/list',
      params: {}
    }).then(function(r1) {
      if (r1.code !== 0) return Promise.resolve({ code: r1.code, msg: '获取工具列表失败：' + (r1.msg || ''), tools: [] })
      var list = (r1.result && r1.result.tools) || []
      return Promise.resolve({ code: 0, msg: '连接成功，发现 ' + list.length + ' 个工具', tools: list, serverInfo: r0.result && r0.result.serverInfo })
    })
  })
}

function callTool(url, headers, name, args) {
  if (!url || !String(url).trim()) return Promise.resolve({ code: -1, msg: '缺少服务器 URL' })
  if (!name) return Promise.resolve({ code: -1, msg: '缺少工具名' })
  return postRpc(String(url).trim(), headers, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: name,
      arguments: args || {}
    }
  }).then(function(r) {
    if (r.code !== 0) return Promise.resolve({ code: r.code, msg: r.msg || '调用失败' })
    // MCP tools/call 结果：{ content: [{type:'text',text:...}], isError? }
    var content = (r.result && r.result.content) || []
    var textParts = []
    for (var i = 0; i < content.length; i++) {
      var item = content[i]
      if (item && item.type === 'text') {
        textParts.push(String(item.text != null ? item.text : ''))
      } else if (item) {
        // 其他类型（image/resource 等）兜底展示
        textParts.push(String(item.text != null ? item.text : JSON.stringify(item)))
      }
    }
    var text = textParts.join('\n')
    return Promise.resolve({ code: 0, result: text, structured: r.result, isError: !!(r.result && r.result.isError) })
  })
}

export default {
  test: test,
  callTool: callTool,
  parseMcpResponse: parseMcpResponse
}
