/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * workflow-runner.js — 工作流步骤执行器
 * 原生 Agent 动作走 Agent 桥接；纯 JS 动作（delay/http_request/get_time）走引擎默认执行器
 */
import engine from './workflow-engine.js'
import apiAdapter from './api-adapter.js'
import jealousyPatrol from './stubs/jealousy-patrol.js'
// #ifdef APP-PLUS || APP
// 静态 import（uni-app x 蒸汽模式不支持 require，需用 ES import）
import agent from './stubs/agent.js'
// #endif

// Agent 桥接引用（App 端为 UTS 插件桥接；其他平台为不可用降级）
var _agentRef = null
function getAgent() {
  if (_agentRef) return _agentRef
  // #ifdef APP-PLUS || APP
  _agentRef = agent || null
  // #endif
  if (!_agentRef) _agentRef = { isAvailable: function() { return false } }
  return _agentRef
}

// 常见应用中文名/别名 → 包名（AI 可能直接传"抖音"而不是包名）
var APP_ALIASES = {
  '抖音': 'com.ss.android.ugc.aweme', '抖音短视频': 'com.ss.android.ugc.aweme',
  '微信': 'com.tencent.mm', 'wechat': 'com.tencent.mm',
  'qq': 'com.tencent.mobileqq', 'QQ': 'com.tencent.mobileqq',
  '支付宝': 'com.eg.android.AlipayGphone',
  '淘宝': 'com.taobao.taobao', '天猫': 'com.tmall.wireless',
  '京东': 'com.jingdong.app.mall',
  '拼多多': 'com.xunmeng.pinduoduo',
  '哔哩哔哩': 'tv.danmaku.bili', 'b站': 'tv.danmaku.bili', 'bilibili': 'tv.danmaku.bili',
  '微博': 'com.sina.weibo',
  '快手': 'com.smile.gifmaker', '快手极速版': 'com.kuaishou.nebula',
  '小红书': 'com.xingin.xhs',
  '美团': 'com.sankuai.meituan', '饿了么': 'me.ele', '大众点评': 'com.dianping.v1',
  '滴滴': 'com.sdu.didi.psnger', '滴滴出行': 'com.sdu.didi.psnger',
  '高德地图': 'com.autonavi.minimap', '百度地图': 'com.baidu.BaiduMap',
  '网易云音乐': 'com.netease.cloudmusic', 'qq音乐': 'com.tencent.qqmusic', 'QQ音乐': 'com.tencent.qqmusic',
  '酷狗音乐': 'com.kugou.android', '酷我音乐': 'cn.kuwo.player', '喜马拉雅': 'com.ximalaya.ting.android',
  '腾讯视频': 'com.tencent.qqlive', '爱奇艺': 'com.qiyi.video', '优酷': 'com.youku.phone', '芒果tv': 'com.hunantv.imgo.activity',
  '抖音极速版': 'com.ss.android.ugc.aweme.lite',
  'browser': 'com.android.browser',
  '相机': 'com.android.camera', '设置': 'com.android.settings', '计算器': 'com.android.calculator2',
  '电话': 'com.android.dialer', '联系人': 'com.android.contacts', '短信': 'com.android.mms',
  '应用商店': 'com.xiaomi.market', '华为应用市场': 'com.huawei.appmarket',
  '浏览器': '', '默认浏览器': ''
}
function resolvePackage(name) {
  if (!name) return ''
  var v = String(name).trim()
  if (!v) return ''
  // 已经是包名（含点号且无明显中文）直接返回
  if (/^[a-zA-Z0-9_.]+$/.test(v) && v.indexOf('.') > -1) return v
  if (APP_ALIASES[v]) return APP_ALIASES[v]
  // 模糊匹配：别名里包含用户输入，或用户输入包含别名
  for (var k in APP_ALIASES) {
    if (!APP_ALIASES[k]) continue
    if (v.indexOf(k) > -1 || k.indexOf(v) > -1) return APP_ALIASES[k]
  }
  return v
}

// 包名 → 中文名（无障碍桌面点击兜底时找图标用）
var PKG_DISPLAY_NAMES = {}
for (var _k in APP_ALIASES) {
  var _p = APP_ALIASES[_k]
  if (!_p) continue
  if (!PKG_DISPLAY_NAMES[_p]) PKG_DISPLAY_NAMES[_p] = _k
}

// 无障碍点击桌面图标打开应用（不受后台启动限制，模拟真实点击）
// 流程：回到桌面 → ① clickByText 匹配 text → ② 按包名文本 → ③ readScreen 按 desc 找坐标手势点击
//        （vivo 隐藏图标名时 text 为空、只剩 desc，text 匹配必失败，必须走第③级）
function openAppViaDesktop(A, pkgName, callback) {
  var display = PKG_DISPLAY_NAMES[pkgName] || pkgName
  var descHits = []   // 收集节点样本，便于诊断
  if (!A.pressHome || !A.readScreen || !A.clickByText) { callback(null, { success: false, error: '无障碍能力缺失' }); return }
  A.pressHome(function() {
    setTimeout(function() {
      // ① 原生 clickByText 用 findAccessibilityNodeInfosByText（只匹配 text），对正常图标有效
      var rr = null
      try { rr = A.clickByText(display) } catch(e) {}
      var parsedR = null
      try { parsedR = typeof rr === 'string' ? JSON.parse(rr) : rr } catch(e) {}
      if (parsedR && parsedR.code === 0) {
        callback(null, { success: true, result: '已通过桌面图标点击打开「' + display + '」' })
        return
      }
      // ②中文名没点到，退化尝试 package 包名文本
      if (pkgName) {
        var rr2 = null
        try { rr2 = A.clickByText(pkgName) } catch (e) {}
        var parsed2 = null
        try { parsed2 = typeof rr2 === 'string' ? JSON.parse(rr2) : rr2 } catch (e) {}
        if (parsed2 && parsed2.code === 0) {
          callback(null, { success: true, result: '已通过桌面图标点击打开 ' + display + '（包名匹配）' })
          return
        }
      }
      // ③ desc 坐标兜底：vivo 隐藏图标名称后 text 为空（clickByText 必然失败），从读屏节点里按 desc 匹配图标并坐标点击
      clickByDesc()
    }, 1200)
  })

  function clickByDesc() {
    var nodes = []
    try {
      var rs = A.readScreen()
      var so = typeof rs === 'string' ? JSON.parse(rs) : rs
      nodes = (so && so.elements) || []
    } catch(e) {}
    // 收集节点去重用：候选关键词按优先级（中文名 → 包名 → 去 com. 前缀的包名）
    var keys = [display, pkgName]
    var shortPkg = ''
    if (pkgName) {
      var s = String(pkgName).split('.')
      if (s.length > 1) { shortPkg = s.slice(1).join('.') ; if (shortPkg) keys.push(shortPkg) }
    }
    var hit = null
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] || {}
      var t = String(n.text || n.title || n.content || '')
      var d = String(n.desc || n.contentDesc || '')
      if (descHits.length < 12 && (t || d)) descHits.push(t || d)
      for (var k = 0; k < keys.length; k++) {
        var kw = keys[k]
        if (!kw) continue
        if (t.indexOf(kw) > -1 || d.indexOf(kw) > -1) {
          hit = n
          break
        }
      }
      if (hit) break
    }
    if (!hit) {
      callback(null, { success: false, error: '桌面未能点击「' + display + '」：text 与 desc 均未匹配到（共读 ' + nodes.length + ' 个节点。样本：' + descHits.slice(0, 8).join(' | ') + '）' })
      return
    }
    var b = hit.bounds
    var parts = typeof b === 'string' ? b.split(',') : (Array.isArray(b) ? b : null)
    if (!parts || parts.length < 4) {
      callback(null, { success: false, error: '命中节点但缺少坐标 bounds=' + JSON.stringify(b) })
      return
    }
    var x = Math.round((Number(parts[0]) + Number(parts[2])) / 2)
    var y = Math.round((Number(parts[1]) + Number(parts[3])) / 2)
    try {
      var cr = A.click(x, y)
      var cp = null
      try { cp = typeof cr === '' ? null : JSON.parse(cr) } catch (e) {}
      var ok = cp && (cp.code === 0 || cp.ok === true)
      callback(null, { success: true, result: '已通过桌面图标坐标点击打开「' + display + '」(' + x + ',' + y + ')' })
      return
    } catch (e) {
      callback(null, { success: false, error: '坐标点击失败：' + e.message })
    }
  }
}

// 启动应用并验证：原生 startApp（Shizuku→Intent）→ 延迟多级验证前台
// → 未切换时自动走「无障碍桌面点击」兜底（模拟真实用户点击，不受系统后台启动限制）
function startAppExec(A, pkgName, actName, callback, rawName) {
  A.ready(function(ok) {
    if (!ok) {
      callback({ success: false, error: '原生 Agent 不可用（' + A.getDiagnose() + '）' })
      return
    }
    var tryResolveThenStart = function() {
      var rc = null
      try { rc = A.execShell('cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ' + pkgName) } catch(e) {}
      var realAct = ''
      if (rc) {
        try {
          var ro = typeof rc === 'string' ? JSON.parse(rc) : rc
          var rout = (ro && ro.out) ? String(ro.out) : String(rc || '')
          var rlines = rout.split('\n').filter(function(l) { return l.trim() })
          for (var i = 0; i < rlines.length; i++) {
            var l = rlines[i].trim()
            if (l.indexOf(pkgName) > -1 && l.indexOf('/') > -1) {
              realAct = l.split('/').pop().trim()
              break
            }
          }
        } catch(e) {}
      }
      A.startApp(pkgName, realAct, function(err2, parsed2) {
        var failMsg = ''
        if (err2) { failMsg = err2.message || String(err2) }
        else if (parsed2 && parsed2.code !== 0) { failMsg = (parsed2.msg) ? parsed2.msg : ('启动失败 code:' + parsed2.code) }
        if (failMsg) {
          // 兜底1：用原始中文名重试（插件内部 label 匹配，适配不同版本包名）
          if (rawName && rawName !== pkgName) {
            A.startApp(rawName, '', function(err3b, parsed3b) {
              if (!err3b && parsed3b && parsed3b.code === 0) {
                finalVerify((parsed3b.msg) ? parsed3b.msg : ('已启动 ' + rawName))
                return
              }
              // 兜底2：无障碍桌面点击图标（不受后台启动限制）
              openAppViaDesktop(A, pkgName, function(err4, r4) {
                if (err4 || !r4 || !r4.success) {
                  var why2 = (r4 && r4.error) ? r4.error : (err4 && err4.message) || '未知原因'
                  callback({ success: false, error: '启动失败(' + failMsg + ')，桌面兜底也失败(' + why2 + ')' })
                  return
                }
                setTimeout(function() {
                  var fg3 = getForegroundPkg(A)
                  var fg3Pkg = fg3 && fg3.pkg ? String(fg3.pkg) : ''
                  callback({ success: true, result: r4.result + '（当前前台=' + (fg3Pkg || '未知') + '）' })
                }, 1500)
              })
            })
            return
          }
          // 中文名重试条件不满足：直接桌面兜底
          openAppViaDesktop(A, pkgName, function(err4, r4) {
            if (err4 || !r4 || !r4.success) {
              var why2 = (r4 && r4.error) ? r4.error : (err4 && err4.message) || '未知原因'
              callback({ success: false, error: '启动失败(' + failMsg + ')，桌面兜底也失败(' + why2 + ')' })
              return
            }
            setTimeout(function() {
              var fg3 = getForegroundPkg(A)
              var fg3Pkg = fg3 && fg3.pkg ? String(fg3.pkg) : ''
              callback({ success: true, result: r4.result + '（当前前台=' + (fg3Pkg || '未知') + '）' })
            }, 1500)
          })
          return
        }
        var msg = (parsed2 && parsed2.msg) ? parsed2.msg : ('已启动 ' + pkgName)
        finalVerify(msg)
      })
    }
    var finalVerify = function(msg) {
      setTimeout(function() {
        var fg = getForegroundPkg(A)
        var fgPkg = fg && fg.pkg ? String(fg.pkg) : ''
        var fgSrc = (fg && fg.source) ? String(fg.source) : ''
        // 1) 前台确实是目标包（且来源权威可信），确认成功
        if (fgPkg && fgPkg === pkgName && fgSrc !== 'lastEvent') {
          callback({ success: true, result: msg + '（已确认前台切换，验证来源=' + fgSrc + '）' })
          return
        }
        // 2) 前台明确是另一个应用 → 确认失败，尝试桌面兜底
        if (fgPkg && fgPkg !== pkgName) {
          openAppViaDesktop(A, pkgName, function(err3, r3) {
            if (err3 || !r3 || !r3.success) {
              var why = (r3 && r3.error) ? r3.error : (err3 && err3.message) || '未知原因'
              callback({ success: false, error: '已尝试多种方式启动 ' + pkgName + ' 均失败(' + why + ', 当前前台=' + fgPkg + '(' + fgSrc + ')' + ')' })
              return
            }
            setTimeout(function() {
              var fg2 = getForegroundPkg(A)
              var fg2Pkg = fg2 && fg2.pkg ? String(fg2.pkg) : ''
              callback({ success: true, result: r3.result + '（当前前台=' + (fg2Pkg || '未知') + '）' })
            }, 1500)
          })
          return
        }
        // 3) 前台信息缺失或仅 lastEvent 存疑 → 信任 Intent 启动结果，不再回桌面
        callback({ success: true, result: msg + '（Intent 启动成功；无法精确验证前台，信任启动结果）' })
      }, 1800)
    }
    tryResolveThenStart()
  })
}

// 多级前台检测，返回 { pkg, source }：Shizuku dumpsys（权威实时）→ 读屏 package → 无障碍 sLastPackage（历史事件，最不可靠，仅兜底）
function getForegroundPkg(A) {
  var fg = '', src = ''
  // 1) dumpsys 当前焦点（Shizuku，实时权威）
  try {
    var sh = A.execShell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
    var so2 = typeof sh === 'string' ? JSON.parse(sh) : sh
    var out2 = (so2 && so2.out) ? String(so2.out) : (so2 && so2.code === -1 ? '' : String(sh || ''))
    var pm = out2.match(/[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+\/(?:[a-zA-Z0-9_.$]+)?/)
    if (pm && pm[0]) {
      fg = pm[0].split('/')[0]
      src = 'dumpsys'
    }
  } catch(e) {}
  // 2) 读屏顶层 package（无障碍实时快照）
  if (!fg) {
    try {
      var rs = A.readScreen()
      var so = typeof rs === 'string' ? JSON.parse(rs) : rs
      fg = (so && so.package) ? String(so.package) : ''
      if (fg) src = 'readScreen'
    } catch(e) {}
  }
  // 3) 无障碍 sLastPackage（历史事件流，仅当前两种都拿不到时兜底）
  if (!fg) {
    try {
      var r = A.getForegroundApp()
      var o = typeof r === 'string' ? JSON.parse(r) : r
      fg = o && o.package ? String(o.package) : ''
      if (fg) src = 'lastEvent'
    } catch(e) {}
  }
  return { pkg: fg, source: src }
}

// 可执行动作目录（编辑器使用）
// 保留落雨原有实现 + 原版全部工具搬过来
var ACTION_CATALOG = [
  // ===== 落雨原生实现（保留） =====
  { key: 'delay', name: '等待延时(落雨)', js: true, params: [{ key: 'ms', name: '毫秒', type: 'number' }] },
  { key: 'get_time', name: '获取当前时间(落雨)', js: true, params: [] },
  { key: 'http_request', name: 'HTTP请求(落雨)', js: true, params: [
    { key: 'url', name: 'URL', type: 'text' },
    { key: 'method', name: '请求方式', type: 'select', options: ['GET', 'POST', 'PUT', 'DELETE'] },
    { key: 'body', name: '请求体(JSON)', type: 'text' }
  ] },
  { key: 'send_message', name: '发送消息(落雨)', js: true, params: [
    { key: 'text', name: '消息内容', type: 'text' },
    { key: 'prompt', name: 'AI生成提示(可选)', type: 'text' },
    { key: 'aiName', name: '接收AI识别码(该AI聊天设置页可复制,留空默认)', type: 'text' }
  ] },
  { key: 'exec_shell', name: '执行Shell命令(落雨)', params: [{ key: 'cmd', name: '命令', type: 'text' }] },
  { key: 'jealousy_patrol', name: '吃醋巡查(落雨)', native: true, params: [
    { key: 'whitelist', name: '白名单(逗号分隔)', type: 'text' },
    { key: 'freeze', name: '吃醋时冻结App(需Shizuku)', type: 'text' }
  ] },
  { key: 'readScreen', name: '读取屏幕(落雨)', native: true, params: [] },
  { key: 'click', name: '点击坐标(落雨)', native: true, params: [
    { key: 'x', name: 'X', type: 'number' }, { key: 'y', name: 'Y', type: 'number' }
  ] },
  { key: 'clickByText', name: '按文本点击(落雨)', native: true, params: [{ key: 'text', name: '文本', type: 'text' }] },
  { key: 'swipe', name: '滑动手势(落雨)', native: true, params: [
    { key: 'sx', name: '起点X', type: 'number' }, { key: 'sy', name: '起点Y', type: 'number' },
    { key: 'ex', name: '终点X', type: 'number' }, { key: 'ey', name: '终点Y', type: 'number' },
    { key: 'duration', name: '时长(ms)', type: 'number' }
  ] },
  { key: 'inputText', name: '输入文字(落雨)', native: true, params: [{ key: 'text', name: '文字', type: 'text' }] },
  { key: 'lockScreen', name: '锁屏(落雨)', native: true, params: [] },
  { key: 'getAppUsage', name: '应用使用统计(落雨)', native: true, params: [{ key: 'ms', name: '时间范围(ms)', type: 'number' }] },
  { key: 'getTodayAppUsage', name: '今日应用使用(落雨)', native: true, params: [] },
  { key: 'lockApp', name: '锁定应用(落雨)', native: true, params: [{ key: 'pkg', name: '包名', type: 'text' }] },
  { key: 'unlockApp', name: '解锁应用(落雨)', native: true, params: [{ key: 'pkg', name: '包名', type: 'text' }] },
  { key: 'pressBack', name: '返回键(落雨)', native: true, params: [] },
  { key: 'pressHome', name: '主页键(落雨)', native: true, params: [] },

 // ===== 基础工具 =====
  { key: 'sleep', name: '睡眠延时', native: true, params: [{ key: 'duration_ms', name: '时长(毫秒)', type: 'number' }] },
  { key: 'use_package', name: '使用扩展包', native: true, params: [{ key: 'package_name', name: '包名', type: 'text' }] },

 // ===== 文件系统工具 =====
  { key: 'list_files', name: '列出文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'read_file', name: '读取文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' },
    { key: 'intent', name: '意图', type: 'text' }, { key: 'direct_image', name: '直接图片', type: 'text' },
    { key: 'direct_audio', name: '直接音频', type: 'text' }, { key: 'direct_video', name: '直接视频', type: 'text' }
  ] },
  { key: 'read_file_part', name: '读取文件片段', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' },
    { key: 'start_line', name: '起始行', type: 'number' }, { key: 'end_line', name: '结束行', type: 'number' }
  ] },
  { key: 'create_file', name: '创建文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'new', name: '内容', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'edit_file', name: '编辑文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'old', name: '旧内容', type: 'text' },
    { key: 'new', name: '新内容', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'delete_file', name: '删除文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }, { key: 'recursive', name: '递归', type: 'text' }
  ] },
  { key: 'make_directory', name: '创建目录', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }, { key: 'create_parents', name: '创建父目录', type: 'text' }
  ] },
  { key: 'find_files', name: '查找文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' },
    { key: 'pattern', name: '匹配模式', type: 'text' }, { key: 'max_depth', name: '最大深度', type: 'number' },
    { key: 'use_path_pattern', name: '路径模式', type: 'text' }, { key: 'case_insensitive', name: '忽略大小写', type: 'text' }
  ] },
  { key: 'grep_code', name: 'Grep搜索代码', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' },
    { key: 'pattern', name: '正则模式', type: 'text' }, { key: 'file_pattern', name: '文件模式', type: 'text' },
    { key: 'case_insensitive', name: '忽略大小写', type: 'text' }, { key: 'context_lines', name: '上下文行数', type: 'number' },
    { key: 'max_results', name: '最大结果数', type: 'number' }
  ] },
  { key: 'grep_context', name: 'Grep上下文搜索', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' },
    { key: 'intent', name: '意图', type: 'text' }, { key: 'file_pattern', name: '文件模式', type: 'text' },
    { key: 'max_results', name: '最大结果数', type: 'number' }
  ] },
  { key: 'download_file', name: '下载文件', native: true, params: [
    { key: 'url', name: 'URL', type: 'text' }, { key: 'visit_key', name: '访问Key', type: 'text' },
    { key: 'link_number', name: '链接编号', type: 'number' }, { key: 'image_number', name: '图片编号', type: 'number' },
    { key: 'destination', name: '保存路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }, { key: 'headers', name: '请求头', type: 'text' }
  ] },

 // ===== 工具 =====
  { key: 'visit_web', name: '访问网页', native: true, params: [
    { key: 'url', name: 'URL', type: 'text' }, { key: 'visit_key', name: '访问Key', type: 'text' },
    { key: 'link_number', name: '链接编号', type: 'number' }, { key: 'include_image_links', name: '包含图片链接', type: 'text' },
    { key: 'headers', name: '请求头', type: 'text' }, { key: 'user_agent_preset', name: 'UA预设', type: 'text' }, { key: 'user_agent', name: 'User-Agent', type: 'text' }
  ] },

 // ===== 记忆工具 =====
  { key: 'query_memory', name: '查询记忆', native: true, params: [
    { key: 'query', name: '查询词', type: 'text' }, { key: 'folder_path', name: '文件夹路径', type: 'text' },
    { key: 'start_time', name: '起始时间', type: 'text' }, { key: 'end_time', name: '结束时间', type: 'text' },
    { key: 'snapshot_id', name: '快照ID', type: 'text' }, { key: 'threshold', name: '阈值', type: 'number' }, { key: 'limit', name: '数量限制', type: 'number' }
  ] },
  { key: 'get_memory_by_title', name: '按标题获取记忆', native: true, params: [
    { key: 'title', name: '标题', type: 'text' }, { key: 'chunk_index', name: '块索引', type: 'number' },
    { key: 'chunk_range', name: '块范围', type: 'text' }, { key: 'query', name: '查询词', type: 'text' }, { key: 'limit', name: '数量限制', type: 'number' }
  ] },

 // ===== /终端工具 =====
  { key: 'execute_shell', name: '执行Shell命令', native: true, params: [{ key: 'command', name: '命令', type: 'text' }] },
  { key: 'apply_file', name: '应用文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'create_terminal_session', name: '创建终端会话', native: true, params: [{ key: 'session_name', name: '会话名', type: 'text' }] },
  { key: 'execute_in_terminal_session', name: '终端会话执行命令', native: true, params: [
    { key: 'session_id', name: '会话ID', type: 'text' }, { key: 'command', name: '命令', type: 'text' }, { key: 'timeout_ms', name: '超时(ms)', type: 'number' }
  ] },
  { key: 'execute_hidden_terminal_command', name: '隐藏终端执行', native: true, params: [
    { key: 'command', name: '命令', type: 'text' }, { key: 'executor_key', name: '执行器Key', type: 'text' }, { key: 'timeout_ms', name: '超时(ms)', type: 'number' }
  ] },
  { key: 'input_in_terminal_session', name: '终端会话输入', native: true, params: [
    { key: 'session_id', name: '会话ID', type: 'text' }, { key: 'input', name: '输入', type: 'text' }, { key: 'control', name: '控制键', type: 'text' }
  ] },
  { key: 'close_terminal_session', name: '关闭终端会话', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },
  { key: 'get_terminal_session_screen', name: '获取终端屏幕', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },

 // ===== 音乐工具 =====
  { key: 'music_play', name: '播放音乐', native: true, params: [
    { key: 'source', name: '来源', type: 'text' }, { key: 'source_type', name: '来源类型', type: 'text' },
    { key: 'title', name: '标题', type: 'text' }, { key: 'artist', name: '艺术家', type: 'text' },
    { key: 'loop', name: '循环', type: 'text' }, { key: 'volume', name: '音量', type: 'text' }, { key: 'start_position_ms', name: '起始位置(ms)', type: 'text' }
  ] },
  { key: 'music_play_queue', name: '播放队列', native: true, params: [
    { key: 'items', name: '队列项', type: 'text' }, { key: 'loop', name: '循环', type: 'text' },
    { key: 'volume', name: '音量', type: 'text' }, { key: 'start_index', name: '起始索引', type: 'text' }, { key: 'start_position_ms', name: '起始位置(ms)', type: 'text' }
  ] },
  { key: 'music_pause', name: '暂停音乐', native: true, params: [] },
  { key: 'music_resume', name: '恢复音乐', native: true, params: [] },
  { key: 'music_stop', name: '停止音乐', native: true, params: [] },
  { key: 'music_seek', name: '跳转播放', native: true, params: [{ key: 'position_ms', name: '位置(ms)', type: 'text' }] },
  { key: 'music_set_volume', name: '设置音量', native: true, params: [{ key: 'volume', name: '音量', type: 'text' }] },
  { key: 'music_status', name: '音乐状态', native: true, params: [] },

 // ===== 浏览器工具 =====
  { key: 'browser_click', name: '浏览器点击', native: true, params: [
    { key: 'ref', name: '元素引用', type: 'text' }, { key: 'selector', name: '选择器', type: 'text' },
    { key: 'force', name: '强制', type: 'text' }, { key: 'no_wait_after', name: '不等待', type: 'text' }
  ] },
  { key: 'browser_close', name: '关闭浏览器', native: true, params: [] },
  { key: 'browser_close_all', name: '关闭全部浏览器', native: true, params: [] },
  { key: 'browser_console_messages', name: '浏览器控制台', native: true, params: [{ key: 'limit', name: '数量', type: 'text' }] },
  { key: 'browser_drag', name: '浏览器拖拽', native: true, params: [
    { key: 'start_ref', name: '起点元素', type: 'text' }, { key: 'start_x', name: '起点X', type: 'number' },
    { key: 'start_y', name: '起点Y', type: 'number' }, { key: 'end_ref', name: '终点元素', type: 'text' },
    { key: 'end_x', name: '终点X', type: 'number' }, { key: 'end_y', name: '终点Y', type: 'number' }, { key: 'modifiers', name: '修饰键', type: 'text' }
  ] },
  { key: 'browser_evaluate', name: '浏览器执行脚本', native: true, params: [{ key: 'script', name: '脚本', type: 'text' }] },
  { key: 'browser_file_upload', name: '浏览器上传文件', native: true, params: [{ key: 'paths', name: '文件路径', type: 'text' }] },
  { key: 'browser_fill_form', name: '浏览器填表', native: true, params: [{ key: 'fields', name: '字段', type: 'text' }] },
  { key: 'browser_handle_dialog', name: '浏览器对话框', native: true, params: [
    { key: 'accept', name: '接受', type: 'text' }, { key: 'prompt_text', name: '提示文本', type: 'text' }
  ] },
  { key: 'browser_hover', name: '浏览器悬停', native: true, params: [
    { key: 'ref', name: '元素引用', type: 'text' }, { key: 'selector', name: '选择器', type: 'text' }
  ] },
  { key: 'browser_navigate', name: '浏览器导航', native: true, params: [{ key: 'url', name: 'URL', type: 'text' }] },
  { key: 'browser_navigate_back', name: '浏览器后退', native: true, params: [] },
  { key: 'browser_network_requests', name: '浏览器网络请求', native: true, params: [
    { key: 'filter', name: '过滤器', type: 'text' }, { key: 'limit', name: '数量', type: 'text' }
  ] },
  { key: 'browser_press_key', name: '浏览器按键', native: true, params: [{ key: 'key', name: '按键', type: 'text' }] },
  { key: 'browser_resize', name: '浏览器调整大小', native: true, params: [
    { key: 'width', name: '宽度', type: 'number' }, { key: 'height', name: '高度', type: 'number' }
  ] },
  { key: 'browser_run_code', name: '浏览器运行代码', native: true, params: [{ key: 'code', name: '代码', type: 'text' }] },
  { key: 'browser_select_option', name: '浏览器选择选项', native: true, params: [
    { key: 'ref', name: '元素引用', type: 'text' }, { key: 'selector', name: '选择器', type: 'text' }, { key: 'values', name: '值', type: 'text' }
  ] },
  { key: 'browser_snapshot', name: '浏览器快照', native: true, params: [] },
  { key: 'browser_take_screenshot', name: '浏览器截图', native: true, params: [] },
  { key: 'browser_type', name: '浏览器输入文字', native: true, params: [
    { key: 'ref', name: '元素引用', type: 'text' }, { key: 'selector', name: '选择器', type: 'text' },
    { key: 'text', name: '文字', type: 'text' }, { key: 'clear', name: '清空', type: 'text' }, { key: 'delay', name: '延迟', type: 'text' }
  ] },
  { key: 'browser_wait_for', name: '浏览器等待', native: true, params: [
    { key: 'text', name: '文本', type: 'text' }, { key: 'timeout_ms', name: '超时(ms)', type: 'text' }
  ] },
  { key: 'browser_tabs', name: '浏览器标签页', native: true, params: [{ key: 'action', name: '操作', type: 'text' }] },
  { key: 'calculate', name: '计算表达式', native: true, params: [{ key: 'expression', name: '表达式', type: 'text' }] },

 // ===== 扩展记忆工具 =====
  { key: 'create_memory', name: '创建记忆', native: true, params: [
    { key: 'title', name: '标题', type: 'text' }, { key: 'content', name: '内容', type: 'text' },
    { key: 'folder_path', name: '文件夹', type: 'text' }, { key: 'tags', name: '标签', type: 'text' }, { key: 'metadata', name: '元数据', type: 'text' }
  ] },
  { key: 'update_memory', name: '更新记忆', native: true, params: [
    { key: 'old_title', name: '旧标题', type: 'text' }, { key: 'new_title', name: '新标题', type: 'text' },
    { key: 'content', name: '内容', type: 'text' }, { key: 'folder_path', name: '文件夹', type: 'text' },
    { key: 'tags', name: '标签', type: 'text' }, { key: 'metadata', name: '元数据', type: 'text' }
  ] },
  { key: 'delete_memory', name: '删除记忆', native: true, params: [
    { key: 'title', name: '标题', type: 'text' }, { key: 'folder_path', name: '文件夹', type: 'text' }
  ] },
  { key: 'link_memories', name: '关联记忆', native: true, params: [
    { key: 'source_title', name: '源标题', type: 'text' }, { key: 'target_title', name: '目标标题', type: 'text' }, { key: 'link_type', name: '关联类型', type: 'text' }
  ] },
  { key: 'query_memory_links', name: '查询记忆关联', native: true, params: [
    { key: 'link_id', name: '关联ID', type: 'text' }, { key: 'source_title', name: '源标题', type: 'text' },
    { key: 'target_title', name: '目标标题', type: 'text' }, { key: 'link_type', name: '关联类型', type: 'text' }
  ] },
  { key: 'update_user_profile', name: '更新用户档案', native: true, params: [
    { key: 'content', name: '内容', type: 'text' }, { key: 'merge_mode', name: '合并模式', type: 'text' }
  ] },
  { key: 'move_memory', name: '移动记忆', native: true, params: [
    { key: 'source_folder_path', name: '源文件夹', type: 'text' }, { key: 'target_folder_path', name: '目标文件夹', type: 'text' }, { key: 'titles', name: '标题', type: 'text' }
  ] },
  { key: 'update_memory_link', name: '更新记忆关联', native: true, params: [
    { key: 'link_id', name: '关联ID', type: 'text' }, { key: 'source_title', name: '源标题', type: 'text' },
    { key: 'target_title', name: '目标标题', type: 'text' }, { key: 'link_type', name: '关联类型', type: 'text' }
  ] },
  { key: 'delete_memory_link', name: '删除记忆关联', native: true, params: [
    { key: 'link_id', name: '关联ID', type: 'text' }, { key: 'source_title', name: '源标题', type: 'text' }, { key: 'target_title', name: '目标标题', type: 'text' }
  ] },

 // ===== 扩展HTTP工具 =====
  { key: 'multipart_request', name: 'Multipart请求', native: true, params: [
    { key: 'url', name: 'URL', type: 'text' }, { key: 'fields', name: '字段', type: 'text' },
    { key: 'files', name: '文件', type: 'text' }, { key: 'method', name: '方法', type: 'text' },
    { key: 'headers', name: '请求头', type: 'text' }, { key: 'timeout', name: '超时', type: 'text' }
  ] },
  { key: 'manage_cookies', name: '管理Cookie', native: true, params: [
    { key: 'action', name: '操作', type: 'text' }, { key: 'domain', name: '域名', type: 'text' },
    { key: 'name', name: '名称', type: 'text' }, { key: 'value', name: '值', type: 'text' }, { key: 'path', name: '路径', type: 'text' }
  ] },

 // ===== 扩展文件工具 =====
  { key: 'file_exists', name: '文件是否存在', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'move_file', name: '移动文件', native: true, params: [
    { key: 'source', name: '源路径', type: 'text' }, { key: 'destination', name: '目标路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'copy_file', name: '复制文件', native: true, params: [
    { key: 'source', name: '源路径', type: 'text' }, { key: 'destination', name: '目标路径', type: 'text' },
    { key: 'environment', name: '环境', type: 'text' }, { key: 'source_environment', name: '源环境', type: 'text' }, { key: 'dest_environment', name: '目标环境', type: 'text' }
  ] },
  { key: 'file_info', name: '文件信息', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'zip_files', name: '压缩文件', native: true, params: [
    { key: 'source', name: '源路径', type: 'text' }, { key: 'destination', name: '目标路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'unzip_files', name: '解压文件', native: true, params: [
    { key: 'source', name: '源路径', type: 'text' }, { key: 'destination', name: '目标路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'open_file', name: '打开文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'share_file', name: '分享文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },

 // ===== 工具 =====
  { key: 'trigger_tasker_event', name: '触发Tasker事件', native: true, params: [
    { key: 'task_type', name: '任务类型', type: 'text' }, { key: 'arg1', name: '参数1', type: 'text' },
    { key: 'arg2', name: '参数2', type: 'text' }, { key: 'arg3', name: '参数3', type: 'text' },
    { key: 'arg4', name: '参数4', type: 'text' }, { key: 'arg5', name: '参数5', type: 'text' }, { key: 'args_json', name: '参数JSON', type: 'text' }
  ] },

 // ===== 工作流管理工具 =====
  { key: 'get_all_workflows', name: '获取所有工作流', native: true, params: [] },
  { key: 'create_workflow', name: '创建工作流', native: true, params: [
    { key: 'name', name: '名称', type: 'text' }, { key: 'description', name: '描述', type: 'text' },
    { key: 'nodes', name: '节点JSON', type: 'text' }, { key: 'connections', name: '连线JSON', type: 'text' }, { key: 'enabled', name: '启用', type: 'text' }
  ] },
  { key: 'get_workflow', name: '获取工作流', native: true, params: [{ key: 'workflow_id', name: '工作流ID', type: 'text' }] },
  { key: 'update_workflow', name: '更新工作流', native: true, params: [
    { key: 'workflow_id', name: '工作流ID', type: 'text' }, { key: 'name', name: '名称', type: 'text' },
    { key: 'description', name: '描述', type: 'text' }, { key: 'nodes', name: '节点JSON', type: 'text' },
    { key: 'connections', name: '连线JSON', type: 'text' }, { key: 'enabled', name: '启用', type: 'text' }
  ] },
  { key: 'patch_workflow', name: '增量更新工作流', native: true, params: [
    { key: 'workflow_id', name: '工作流ID', type: 'text' }, { key: 'name', name: '名称', type: 'text' },
    { key: 'description', name: '描述', type: 'text' }, { key: 'enabled', name: '启用', type: 'text' },
    { key: 'node_patches', name: '节点补丁JSON', type: 'text' }, { key: 'connection_patches', name: '连线补丁JSON', type: 'text' }
  ] },
  { key: 'enable_workflow', name: '启用工作流', native: true, params: [{ key: 'workflow_id', name: '工作流ID', type: 'text' }] },
  { key: 'disable_workflow', name: '停用工作流', native: true, params: [{ key: 'workflow_id', name: '工作流ID', type: 'text' }] },
  { key: 'delete_workflow', name: '删除工作流', native: true, params: [{ key: 'workflow_id', name: '工作流ID', type: 'text' }] },
  { key: 'trigger_workflow', name: '触发工作流', native: true, params: [{ key: 'workflow_id', name: '工作流ID', type: 'text' }] },

 // ===== 对话工具 =====
  { key: 'start_chat_service', name: '启动对话服务', native: true, params: [
    { key: 'initial_mode', name: '初始模式', type: 'text' }, { key: 'auto_enter_voice_chat', name: '自动语音', type: 'text' },
    { key: 'wake_launched', name: '唤醒启动', type: 'text' }, { key: 'timeout_ms', name: '超时(ms)', type: 'text' }, { key: 'keep_if_exists', name: '保持已有', type: 'text' }
  ] },
  { key: 'stop_chat_service', name: '停止对话服务', native: true, params: [] },
  { key: 'create_new_chat', name: '创建新对话', native: true, params: [
    { key: 'group', name: '分组', type: 'text' }, { key: 'set_as_current_chat', name: '设为当前', type: 'text' }, { key: 'character_card_id', name: '角色卡ID', type: 'text' }
  ] },
  { key: 'list_chats', name: '列出对话', native: true, params: [
    { key: 'query', name: '查询', type: 'text' }, { key: 'match', name: '匹配', type: 'text' },
    { key: 'limit', name: '数量', type: 'text' }, { key: 'sort_by', name: '排序', type: 'text' }, { key: 'sort_order', name: '排序方向', type: 'text' }
  ] },
  { key: 'find_chat', name: '查找对话', native: true, params: [
    { key: 'query', name: '查询', type: 'text' }, { key: 'match', name: '匹配', type: 'text' }, { key: 'index', name: '索引', type: 'text' }
  ] },
  { key: 'agent_status', name: 'Agent状态', native: true, params: [{ key: 'chat_id', name: '对话ID', type: 'text' }] },
  { key: 'switch_chat', name: '切换对话', native: true, params: [{ key: 'chat_id', name: '对话ID', type: 'text' }] },
  { key: 'update_chat_title', name: '更新对话标题', native: true, params: [
    { key: 'chat_id', name: '对话ID', type: 'text' }, { key: 'title', name: '标题', type: 'text' }
  ] },
  { key: 'delete_chat', name: '删除对话', native: true, params: [{ key: 'chat_id', name: '对话ID', type: 'text' }] },
  { key: 'send_message_to_ai', name: '发送消息给AI', native: true, params: [
    { key: 'message', name: '消息', type: 'text' }, { key: 'chat_id', name: '对话ID', type: 'text' },
    { key: 'runtime', name: '运行时', type: 'text' }, { key: 'role_card_id', name: '角色卡ID', type: 'text' },
    { key: 'sender_name', name: '发送者名', type: 'text' }, { key: 'persist_turn', name: '持久化', type: 'text' },
    { key: 'notify_reply', name: '通知回复', type: 'text' }, { key: 'hide_user_message', name: '隐藏用户消息', type: 'text' },
    { key: 'disable_warning', name: '禁用警告', type: 'text' }, { key: 'timeout_ms', name: '超时(ms)', type: 'text' }
  ] },
  { key: 'list_character_cards', name: '列出角色卡', native: true, params: [] },
  { key: 'get_chat_messages', name: '获取对话消息', native: true, params: [
    { key: 'chat_id', name: '对话ID', type: 'text' }, { key: 'order', name: '排序', type: 'text' }, { key: 'limit', name: '数量', type: 'text' }
  ] },
  { key: 'get_chat_messages_range', name: '获取消息范围', native: true, params: [
    { key: 'chat_id', name: '对话ID', type: 'text' }, { key: 'order', name: '排序', type: 'text' },
    { key: 'start', name: '起始', type: 'text' }, { key: 'end', name: '结束', type: 'text' }
  ] },
  { key: 'send_message_to_ai_streaming', name: '流式发送消息给AI', native: true, params: [
    { key: 'message', name: '消息', type: 'text' }, { key: 'chat_id', name: '对话ID', type: 'text' },
    { key: 'runtime', name: '运行时', type: 'text' }, { key: 'role_card_id', name: '角色卡ID', type: 'text' },
    { key: 'sender_name', name: '发送者名', type: 'text' }, { key: 'persist_turn', name: '持久化', type: 'text' },
    { key: 'notify_reply', name: '通知回复', type: 'text' }, { key: 'hide_user_message', name: '隐藏用户消息', type: 'text' },
    { key: 'disable_warning', name: '禁用警告', type: 'text' }, { key: 'timeout_ms', name: '超时(ms)', type: 'text' }
  ] },

 // ===== 内部文件工具 =====
  { key: 'read_file_full', name: '完整读取文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }, { key: 'text_only', name: '仅文本', type: 'text' }
  ] },
  { key: 'read_file_binary', name: '读取二进制文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'write_file', name: '写入文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'content', name: '内容', type: 'text' },
    { key: 'append', name: '追加', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'write_file_binary', name: '写入二进制文件', native: true, params: [
    { key: 'path', name: '路径', type: 'text' }, { key: 'base64Content', name: 'Base64内容', type: 'text' }, { key: 'environment', name: '环境', type: 'text' }
  ] },
  { key: 'execute_intent', name: '执行Intent', native: true, params: [
    { key: 'action', name: 'Action', type: 'text' }, { key: 'uri', name: 'URI', type: 'text' },
    { key: 'package', name: '包名', type: 'text' }, { key: 'component', name: '组件', type: 'text' },
    { key: 'type', name: '类型', type: 'text' }, { key: 'flags', name: '标志', type: 'text' }, { key: 'extras', name: '附加数据', type: 'text' }
  ] },
  { key: 'send_broadcast', name: '发送广播', native: true, params: [
    { key: 'action', name: 'Action', type: 'text' }, { key: 'uri', name: 'URI', type: 'text' },
    { key: 'package', name: '包名', type: 'text' }, { key: 'component', name: '组件', type: 'text' },
    { key: 'extras', name: '附加数据', type: 'text' }, { key: 'extra_key', name: '附加Key1', type: 'text' },
    { key: 'extra_value', name: '附加值1', type: 'text' }, { key: 'extra_key2', name: '附加Key2', type: 'text' }, { key: 'extra_value2', name: '附加值2', type: 'text' }
  ] },
  { key: 'device_info', name: '设备信息', native: true, params: [] },

 // ===== 内部UI工具 =====
  { key: 'get_page_info', name: '获取页面信息', native: true, params: [
    { key: 'format', name: '格式', type: 'text' }, { key: 'detail', name: '详情', type: 'text' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'tap', name: '点击坐标', native: true, params: [
    { key: 'x', name: 'X', type: 'number' }, { key: 'y', name: 'Y', type: 'number' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'long_press', name: '长按坐标', native: true, params: [
    { key: 'x', name: 'X', type: 'number' }, { key: 'y', name: 'Y', type: 'number' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'click_element', name: '点击元素', native: true, params: [
    { key: 'resourceId', name: '资源ID', type: 'text' }, { key: 'className', name: '类名', type: 'text' },
    { key: 'contentDesc', name: '内容描述', type: 'text' }, { key: 'bounds', name: '边界', type: 'text' },
    { key: 'partialMatch', name: '部分匹配', type: 'text' }, { key: 'index', name: '索引', type: 'text' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'set_input_text', name: '设置输入文本', native: true, params: [
    { key: 'text', name: '文本', type: 'text' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'press_key', name: '按键', native: true, params: [
    { key: 'key_code', name: '键码', type: 'number' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'capture_screenshot', name: '截屏', native: true, params: [] },
  { key: 'run_ui_subagent', name: 'UI子Agent', native: true, params: [
    { key: 'intent', name: '意图', type: 'text' }, { key: 'max_steps', name: '最大步数', type: 'number' },
    { key: 'agent_id', name: 'AgentID', type: 'text' }, { key: 'target_app', name: '目标应用', type: 'text' }
  ] },

 // ===== 软件设置工具 =====
  { key: 'read_environment_variable', name: '读取环境变量', native: true, params: [{ key: 'key', name: '键', type: 'text' }] },
  { key: 'write_environment_variable', name: '写入环境变量', native: true, params: [
    { key: 'key', name: '键', type: 'text' }, { key: 'value', name: '值', type: 'text' }
  ] },
  { key: 'list_sandbox_packages', name: '列出沙箱包', native: true, params: [] },
  { key: 'set_sandbox_package_enabled', name: '设置沙箱包启用', native: true, params: [
    { key: 'package_name', name: '包名', type: 'text' }, { key: 'enabled', name: '启用', type: 'text' }
  ] },
  { key: 'restart_mcp_with_logs', name: '重启MCP', native: true, params: [{ key: 'timeout_ms', name: '超时(ms)', type: 'text' }] },
  { key: 'get_speech_services_config', name: '获取语音服务配置', native: true, params: [] },
  { key: 'set_speech_services_config', name: '设置语音服务配置', native: true, params: [
    { key: 'tts_service_type', name: 'TTS类型', type: 'text' }, { key: 'tts_url_template', name: 'TTS_URL', type: 'text' },
    { key: 'tts_api_key', name: 'TTS_Key', type: 'text' }, { key: 'tts_headers', name: 'TTS_Headers', type: 'text' },
    { key: 'tts_http_method', name: 'TTS_Method', type: 'text' }, { key: 'tts_request_body', name: 'TTS_Body', type: 'text' },
    { key: 'tts_content_type', name: 'TTS_ContentType', type: 'text' }, { key: 'tts_locale', name: 'TTS_区域', type: 'text' },
    { key: 'tts_voice_id', name: 'TTS_语音ID', type: 'text' }, { key: 'tts_model_name', name: 'TTS_模型', type: 'text' },
    { key: 'tts_response_pipeline', name: 'TTS_管道', type: 'text' }, { key: 'tts_vits_package_path', name: 'VITS路径', type: 'text' },
    { key: 'tts_vits_speaker_id', name: 'VITS说话人', type: 'text' }, { key: 'tts_vits_options', name: 'VITS选项', type: 'text' },
    { key: 'tts_cleaner_regexs', name: 'TTS清理正则', type: 'text' }, { key: 'tts_speech_rate', name: '语速', type: 'text' },
    { key: 'tts_pitch', name: '音调', type: 'text' }, { key: 'stt_service_type', name: 'STT类型', type: 'text' },
    { key: 'stt_endpoint_url', name: 'STT_URL', type: 'text' }, { key: 'stt_api_key', name: 'STT_Key', type: 'text' }, { key: 'stt_model_name', name: 'STT_模型', type: 'text' }
  ] },
  { key: 'test_tts_playback', name: '测试TTS播放', native: true, params: [
    { key: 'text', name: '文本', type: 'text' }, { key: 'interrupt', name: '中断', type: 'text' },
    { key: 'speech_rate', name: '语速', type: 'text' }, { key: 'pitch', name: '音调', type: 'text' }
  ] },
  { key: 'list_model_configs', name: '列出模型配置', native: true, params: [] },
  { key: 'create_model_config', name: '创建模型配置', native: true, params: [
    { key: 'name', name: '名称', type: 'text' }, { key: 'api_provider_type', name: 'API类型', type: 'text' },
    { key: 'api_endpoint', name: 'API地址', type: 'text' }, { key: 'api_key', name: 'API Key', type: 'text' },
    { key: 'model_name', name: '模型名', type: 'text' }, { key: 'max_tokens', name: '最大Token', type: 'text' },
    { key: 'temperature', name: '温度', type: 'text' }, { key: 'top_p', name: 'TopP', type: 'text' },
    { key: 'top_k', name: 'TopK', type: 'text' }, { key: 'presence_penalty', name: '存在惩罚', type: 'text' },
    { key: 'frequency_penalty', name: '频率惩罚', type: 'text' }, { key: 'repetition_penalty', name: '重复惩罚', type: 'text' },
    { key: 'context_length', name: '上下文长度', type: 'text' }, { key: 'max_context_length', name: '最大上下文', type: 'text' },
    { key: 'custom_parameters', name: '自定义参数', type: 'text' }, { key: 'custom_headers', name: '自定义头', type: 'text' }
  ] },
  { key: 'update_model_config', name: '更新模型配置', native: true, params: [
    { key: 'config_id', name: '配置ID', type: 'text' }, { key: 'name', name: '名称', type: 'text' },
    { key: 'api_provider_type', name: 'API类型', type: 'text' }, { key: 'api_endpoint', name: 'API地址', type: 'text' },
    { key: 'api_key', name: 'API Key', type: 'text' }, { key: 'model_name', name: '模型名', type: 'text' }
  ] },
  { key: 'delete_model_config', name: '删除模型配置', native: true, params: [{ key: 'config_id', name: '配置ID', type: 'text' }] },
  { key: 'list_function_model_configs', name: '列出功能模型配置', native: true, params: [] },
  { key: 'get_function_model_config', name: '获取功能模型配置', native: true, params: [{ key: 'function_type', name: '功能类型', type: 'text' }] },
  { key: 'set_function_model_config', name: '设置功能模型配置', native: true, params: [
    { key: 'function_type', name: '功能类型', type: 'text' }, { key: 'config_id', name: '配置ID', type: 'text' }, { key: 'model_index', name: '模型索引', type: 'text' }
  ] },
  { key: 'test_model_config_connection', name: '测试模型连接', native: true, params: [
    { key: 'config_id', name: '配置ID', type: 'text' }, { key: 'model_index', name: '模型索引', type: 'text' }
  ] },
  { key: 'execute_sandbox_script_direct', name: '执行沙箱脚本', native: true, params: [
    { key: 'source_path', name: '源路径', type: 'text' }, { key: 'source_code', name: '源代码', type: 'text' }, { key: 'script_label', name: '脚本标签', type: 'text' }
  ] },
  { key: 'close_all_virtual_displays', name: '关闭所有虚拟显示器', native: true, params: [] },

 // ===== 内部系统工具 =====
  { key: 'modify_system_setting', name: '修改系统设置', native: true, params: [
    { key: 'setting', name: '设置项', type: 'text' }, { key: 'value', name: '值', type: 'text' }, { key: 'namespace', name: '命名空间', type: 'text' }
  ] },
  { key: 'get_system_setting', name: '获取系统设置', native: true, params: [
    { key: 'setting', name: '设置项', type: 'text' }, { key: 'namespace', name: '命名空间', type: 'text' }
  ] },
  { key: 'install_app', name: '安装应用', native: true, params: [{ key: 'path', name: 'APK路径', type: 'text' }] },
  { key: 'uninstall_app', name: '卸载应用', native: true, params: [{ key: 'package_name', name: '包名', type: 'text' }] },
  { key: 'list_installed_apps', name: '列出已安装应用', native: true, params: [{ key: 'include_system_apps', name: '含系统应用', type: 'text' }] },
  { key: 'start_app', name: '启动应用', native: true, params: [
    { key: 'package_name', name: '包名', type: 'text' }, { key: 'activity', name: 'Activity', type: 'text' }
  ] },
  { key: 'stop_app', name: '停止应用', native: true, params: [{ key: 'package_name', name: '包名', type: 'text' }] },
  { key: 'get_notifications', name: '获取通知', native: true, params: [
    { key: 'limit', name: '数量', type: 'text' }, { key: 'include_ongoing', name: '含进行中', type: 'text' }
  ] },
  { key: 'get_app_usage_time', name: '应用使用时长', native: true, params: [
    { key: 'package_name', name: '包名', type: 'text' }, { key: 'since_hours', name: '小时数', type: 'text' },
    { key: 'limit', name: '数量', type: 'text' }, { key: 'include_system_apps', name: '含系统应用', type: 'text' }
  ] },
  { key: 'toast', name: 'Toast提示', native: true, params: [{ key: 'message', name: '消息', type: 'text' }] },
  { key: 'send_notification', name: '发送通知', native: true, params: [
    { key: 'title', name: '标题', type: 'text' }, { key: 'message', name: '消息', type: 'text' }
  ] },
  { key: 'get_device_location', name: '获取设备位置', native: true, params: [
    { key: 'timeout', name: '超时', type: 'text' }, { key: 'high_accuracy', name: '高精度', type: 'text' }, { key: 'include_address', name: '含地址', type: 'text' }
  ] },
  { key: 'request_bluetooth_permission', name: '请求蓝牙权限', native: true, params: [] },
  { key: 'get_bluetooth_state', name: '蓝牙状态', native: true, params: [] },
  { key: 'request_enable_bluetooth', name: '请求启用蓝牙', native: true, params: [] },
  { key: 'list_bluetooth_bonded_devices', name: '列出已配对蓝牙设备', native: true, params: [] },
  { key: 'scan_bluetooth_devices', name: '扫描蓝牙设备', native: true, params: [] },
  { key: 'bluetooth_connect', name: '蓝牙连接', native: true, params: [{ key: 'address', name: '地址', type: 'text' }] },
  { key: 'bluetooth_listen', name: '蓝牙监听', native: true, params: [] },
  { key: 'bluetooth_accept', name: '蓝牙接受', native: true, params: [{ key: 'listener_session_id', name: '监听会话ID', type: 'text' }] },
  { key: 'bluetooth_send', name: '蓝牙发送', native: true, params: [
    { key: 'session_id', name: '会话ID', type: 'text' }, { key: 'data', name: '数据', type: 'text' }
  ] },
  { key: 'bluetooth_read', name: '蓝牙读取', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },
  { key: 'bluetooth_send_and_read', name: '蓝牙发送并读取', native: true, params: [
    { key: 'session_id', name: '会话ID', type: 'text' }, { key: 'data', name: '数据', type: 'text' }
  ] },
  { key: 'bluetooth_close', name: '蓝牙关闭', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },
  { key: 'bluetooth_ble_connect', name: 'BLE连接', native: true, params: [{ key: 'address', name: '地址', type: 'text' }] },
  { key: 'bluetooth_ble_discover_services', name: 'BLE发现服务', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },
  { key: 'bluetooth_ble_read_characteristic', name: 'BLE读取特征', native: true, params: [{ key: 'characteristic_uuid', name: '特征UUID', type: 'text' }] },
  { key: 'bluetooth_ble_write_characteristic', name: 'BLE写入特征', native: true, params: [
    { key: 'characteristic_uuid', name: '特征UUID', type: 'text' }, { key: 'data', name: '数据', type: 'text' }
  ] },
  { key: 'bluetooth_ble_write_and_read_characteristic', name: 'BLE写入并读取', native: true, params: [
    { key: 'write_characteristic_uuid', name: '写UUID', type: 'text' }, { key: 'read_characteristic_uuid', name: '读UUID', type: 'text' }, { key: 'data', name: '数据', type: 'text' }
  ] },
  { key: 'bluetooth_ble_subscribe_characteristic', name: 'BLE订阅特征', native: true, params: [{ key: 'characteristic_uuid', name: '特征UUID', type: 'text' }] },
  { key: 'bluetooth_ble_read_notifications', name: 'BLE读取通知', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },

 // ===== 工具 =====
  { key: 'ffmpeg_execute', name: 'FFmpeg执行', native: true, params: [{ key: 'command', name: '命令', type: 'text' }] },
  { key: 'ffmpeg_info', name: 'FFmpeg信息', native: true, params: [] },
  { key: 'ffmpeg_convert', name: 'FFmpeg转换', native: true, params: [
    { key: 'input_path', name: '输入路径', type: 'text' }, { key: 'output_path', name: '输出路径', type: 'text' },
    { key: 'format', name: '格式', type: 'text' }, { key: 'resolution', name: '分辨率', type: 'text' },
    { key: 'bitrate', name: '比特率', type: 'text' }, { key: 'audio_codec', name: '音频编码', type: 'text' }, { key: 'video_codec', name: '视频编码', type: 'text' }
  ] },

 // ===== 工具 =====
  { key: 'cli_search', name: 'CLI搜索', native: true, params: [
    { key: 'query', name: '查询', type: 'text' }, { key: 'limit', name: '数量', type: 'text' }
  ] },
  { key: 'cli_proxy', name: 'CLI代理', native: true, params: [
    { key: 'tool_name', name: '工具名', type: 'text' }, { key: 'params', name: '参数JSON', type: 'text' }
  ] },
  { key: 'package_proxy', name: '包代理', native: true, params: [
    { key: 'tool_name', name: '工具名(包:工具)', type: 'text' }, { key: 'params', name: '参数JSON', type: 'text' }
  ] }
]

// 原生动作 -> Agent 方法与参数顺序
// 覆盖 高频动作 + 落雨原生动作
var NATIVE_METHODS = {
  // ===== 落雨原生 =====
  readScreen: { m: 'readScreen' },
  click: { m: 'click', args: ['x', 'y'] },
  clickByText: { m: 'clickByText', args: ['text'] },
  swipe: { m: 'swipe', args: ['sx', 'sy', 'ex', 'ey', 'duration'] },
  inputText: { m: 'inputText', args: ['text'] },
  lockScreen: { m: 'lockScreen' },
  getAppUsage: { m: 'getAppUsage', args: ['ms'] },
  getTodayAppUsage: { m: 'getTodayAppUsage' },
  lockApp: { m: 'lockApp', args: ['pkg', 'reason', 'until'] },
  unlockApp: { m: 'unlockApp', args: ['pkg'] },
  lockApps: { m: 'lockApps', args: ['packages', 'reason', 'until'] },
  unlockAll: { m: 'unlockAll' },
  getLockSession: { m: 'getLockSession' },
  checkInInfo: { m: 'checkInInfo' },
  pressBack: { m: 'pressBack' },
  pressHome: { m: 'pressHome' },

 // ===== 高频动作 =====
  start_app: { m: 'startApp', args: ['package_name', 'activity'] },
  open_app: { m: 'startApp', args: ['package_name', 'activity'] },
  launch_app: { m: 'startApp', args: ['package_name', 'activity'] },
  stop_app: { m: 'stopApp', args: ['package_name'] },
  is_app_installed: { m: 'isAppInstalled', args: ['package_name'] },
  tap: { m: 'click', args: ['x', 'y'] },
  long_press: { m: 'longPress', args: ['x', 'y'] },
  press_key: { m: 'pressKey', args: ['key_code'] },
  set_input_text: { m: 'inputText', args: ['text'] },
  input_text: { m: 'inputText', args: ['text'] },
  get_page_info: { m: 'readScreen' },
  read_screen: { m: 'readScreen' },
  get_foreground_app: { m: 'getForegroundApp' },
  toast: { m: 'toast', args: ['message'] },
  send_notification: { m: 'sendNotification', args: ['title', 'message'] },
  click_by_text: { m: 'clickByText', args: ['text'] },
  press_back: { m: 'pressBack' },
  press_home: { m: 'pressHome' },
  lock_app: { m: 'lockApp', args: ['package_name', 'reason', 'until'] },
  unlock_app: { m: 'unlockApp', args: ['package_name'] },
  lock_apps: { m: 'lockApps', args: ['packages', 'reason', 'until'] },
  unlock_all: { m: 'unlockAll' },
  get_lock_session: { m: 'getLockSession' },
  check_in: { m: 'checkInInfo' },
  get_app_usage: { m: 'getAppUsage', args: ['ms'] },
  get_today_app_usage: { m: 'getTodayAppUsage' },
 // swipe_operit -> swipe（参数名 start_x 等，需特判转换）
  swipe_operit: { m: 'swipe', args: ['start_x', 'start_y', 'end_x', 'end_y', 'duration'] },
  // 终端/Shell 类
  execute_shell: { m: 'execShell', args: ['command'] },
  execute_hidden_terminal_command: { m: 'execShell', args: ['command'] },
 // 终端会话
  create_terminal_session: { m: 'createTerminalSession', args: ['session_name'] },
  execute_in_terminal_session: { m: 'executeInTerminalSession', args: ['session_id', 'command', 'timeout_ms'] },
  input_in_terminal_session: { m: 'inputInTerminalSession', args: ['session_id', 'input', 'control'] },
  close_terminal_session: { m: 'closeTerminalSession', args: ['session_id'] },
  get_terminal_session_screen: { m: 'getTerminalSessionScreen', args: ['session_id'] },
  // Shizuku 权限
  check_shizuku: { m: 'checkShizuku' },
  request_shizuku: { m: 'requestShizuku' },
  device_info: { m: 'deviceInfo' },
  // 感知与系统控制（新增）
  screenshot: { m: 'screenshot' },
  get_clipboard: { m: 'getClipboard' },
  set_clipboard: { m: 'setClipboard', args: ['text'] },
  get_notifications: { m: 'getNotifications' },
  open_notification_settings: { m: 'openNotificationSettings' },
  toggle_torch: { m: 'toggleTorch', args: ['on'] },
  set_brightness: { m: 'setBrightness', args: ['level'] },
  set_volume: { m: 'setVolume', args: ['level'] },
  set_airplane: { m: 'setAirplane', args: ['on'] }
}

function getAction(key) {
  for (var i = 0; i < ACTION_CATALOG.length; i++) {
    if (ACTION_CATALOG[i].key === key) return ACTION_CATALOG[i]
  }
  return null
}

// 判断动作是否真的能被执行：能落在代码路径上的才算可用，
// 否则（ACTION_CATALOG 大量标 native 但 NATIVE_METHODS 里不存在的摆设）视为不可用
function isActionAvailable(key) {
  if (engine.JS_ACTIONS.indexOf(key) > -1) return true
  if (OPERIT_JS_TOOLS.indexOf(key) > -1) return true
  if (key === 'send_message' || key === 'exec_shell') return true
  if (key === 'jealousy_patrol') return true
  if (key === 'start_app' || key === 'open_app' || key === 'launch_app') return true
  return !!NATIVE_METHODS[key]
}

/**
 * 读取今日应用使用情况（尽力而为，失败/超时返回空串）
 */
function fetchTodayUsage(cb) {
  var done = false
  var timer = setTimeout(function() { if (!done) { done = true; cb('') } }, 1500)
  try {
    if (getAgent().isAvailable()) {
      getAgent().getTodayAppUsage(function(err, parsed) {
        if (done) return
        done = true
        clearTimeout(timer)
        if (!err && parsed) {
          var data = parsed.data !== undefined ? parsed.data : parsed
          cb(typeof data === 'string' ? data : JSON.stringify(data))
          return
        }
        cb('')
      })
      return
    }
    cb('')
  } catch (e) {
    if (!done) { done = true; clearTimeout(timer); cb('') }
  }
}

/**
 * 发送消息动作：
 * - 静态模式：直接发送 text
 * - AI 生成模式：提供 prompt 时，调用 AI 按提示词生成内容（自动附带今日应用使用情况）再发送
 */
function sendMessageAction(params) {
  params = params || {}
  return new Promise(function(resolve) {
    var text = String(params.text != null ? params.text : '').trim()
    var prompt = String(params.prompt != null ? params.prompt : '').trim()
    var target = String(params.aiName != null ? params.aiName : (params.roleCode != null ? params.roleCode : '')).trim()
    if (!text && !prompt) {
      resolve({ success: false, error: '缺少消息内容：请填写 消息内容 或 AI生成提示' })
      return
    }
    var aiList = []
    var rawList = uni.getStorageSync('ai_list')
    if (rawList) { try { aiList = typeof rawList === 'string' ? JSON.parse(rawList) : rawList } catch(e) {} }
    if (!Array.isArray(aiList) || aiList.length === 0) {
      resolve({ success: false, error: '未配置任何 AI，无法发送消息' })
      return
    }
    // 过滤黑名单的 AI（拉黑后不参与主动消息）
    var availList = []
    for (var bi = 0; bi < aiList.length; bi++) {
      var bai = aiList[bi]
      var bblocked = false
      try {
        var braw = uni.getStorageSync('chat_settings_' + bai.id)
        if (braw) {
          var bo = typeof braw === 'string' ? JSON.parse(braw) : braw
          if (bo && bo.blocked === true) bblocked = true
        }
      } catch(e) {}
      if (!bblocked) availList.push(bai)
    }
    if (availList.length === 0) {
      resolve({ success: false, error: '所有 AI 都已被拉黑，无法发送消息' })
      return
    }
    var ai = null
    if (target) {
      for (var i = 0; i < availList.length; i++) {
        // 匹配顺序：AI识别码(aiId) → 角色编码(roleCode) → 名称(name) → 内部ID(id)
        if (String(availList[i].aiId) === target || String(availList[i].roleCode) === target || String(availList[i].name) === target || String(availList[i].id) === target) { ai = availList[i]; break }
      }
      if (!ai) { resolve({ success: false, error: '未找到识别码/编码/名为「' + target + '」的 AI（识别码可在该AI的聊天设置页查看）' }); return }
    }
    if (!ai) ai = availList[0]
    var aiId = ai.id || ('ai_' + (ai.name || 'default'))
    var aiDisplay = ai.name || 'AI'

    // 投递消息：写入会话 + 未读标记 + 系统通知
    function deliver(content) {
      var key = 'chat_msgs_' + aiId
      var msgs = []
      var rawMsgs = uni.getStorageSync(key)
      if (rawMsgs) { try { msgs = typeof rawMsgs === 'string' ? JSON.parse(rawMsgs) : rawMsgs } catch(e) {} }
      if (!Array.isArray(msgs)) msgs = []
      msgs.push({
        id: 'm_auto_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        role: 'ai',
        content: content,
        type: 'text',
        time: Date.now()
      })
      uni.setStorageSync(key, JSON.stringify(msgs))

      var unread = uni.getStorageSync('unread_auto_msgs')
      var unreadList = {}
      if (unread) { try { unreadList = typeof unread === 'string' ? JSON.parse(unread) : unread } catch(e) {} }
      unreadList[aiId] = { name: aiDisplay, time: Date.now() }
      uni.setStorageSync('unread_auto_msgs', JSON.stringify(unreadList))

      // 系统通知：优先原生 Agent 通知（带声音+可见横幅，和后台 AI 主动消息一致）；
      // Agent 不可用或调用失败时回退 plus.push（通知栏+系统提示音）
      function pushFallback() {
        try {
          plus.push.createMessage(content, JSON.stringify({ type: 'chat', aiId: aiId, aiName: aiDisplay }), { title: aiDisplay + ' 发来一条消息', cover: true, sound: 'system', when: new Date() })
        } catch(e2) { console.log('[workflow] plus.push 通知失败:', e2.message) }
        resolve({ success: true, result: '已发送给「' + aiDisplay + '」：' + content })
      }
      // #ifdef APP-PLUS || APP
      try {
        if (getAgent().isAvailable()) {
          var r = getAgent().sendNotification(aiDisplay + ' 发来一条消息', content)
          if (r && r.indexOf && r.indexOf('"code":-1') > -1) {
            console.log('[workflow] Agent 通知返回错误，回退 plus.push:', r)
            pushFallback()
            return
          }
          resolve({ success: true, result: '已发送给「' + aiDisplay + '」：' + content })
          return
        }
      } catch(e) {
        console.log('[workflow] Agent 通知异常，回退 plus.push:', e.message)
      }
      pushFallback()
      return
      // #endif
      resolve({ success: true, result: '已发送给「' + aiDisplay + '」：' + content })
    }

    // AI 生成模式
    if (prompt) {
      var config = null
      var own = uni.getStorageSync('ai_api_' + aiId)
      if (own) {
        try {
          var oo = typeof own === 'string' ? JSON.parse(own) : own
          if (oo && oo.useOwnApi && oo.apiKey) config = oo
        } catch(e) {}
      }
      if (!config) config = uni.getStorageSync('api_config')
      if (config) { try { config = typeof config === 'string' ? JSON.parse(config) : config } catch(e) { config = null } }
      if (!config || !config.apiKey) {
        if (text) { deliver(text); return }
        resolve({ success: false, error: '未配置 AI API，无法生成消息' })
        return
      }
      // 自动附带今日应用使用情况，让 AI 能"看到"真实数据
      fetchTodayUsage(function(usage) {
        var sysContent = prompt
        if (usage) sysContent += '\n\n【当前手机应用使用情况】\n' + usage
        var msgs = [
          { role: 'system', content: sysContent },
          { role: 'user', content: text || '请根据上面的要求生成一条消息，直接输出内容即可' }
        ]
        apiAdapter.callAI(config, msgs, { max_tokens: 300, temperature: 0.95, timeout: 20000 })
          .then(function(data) {
            var content = ''
            if (data && data.choices && data.choices[0] && data.choices[0].message) {
              content = String(data.choices[0].message.content || '').trim()
            }
            if (!content) {
              if (text) { deliver(text); return }
              resolve({ success: false, error: 'AI 未返回内容' })
              return
            }
            deliver(content)
          })
          .catch(function(err) {
            if (text) { deliver(text); return }
            resolve({ success: false, error: (err && err.message) || 'AI 生成失败' })
          })
      })
      return
    }

    deliver(text)
  })
}

/**
 * 工具执行器 — 纯前端实现，不依赖原生 Agent
 * 文件系统走 plus.io 沙盒；记忆走本地 storage；网页走 uni.request
 */
var OPERIT_JS_TOOLS = ['sleep', 'list_files', 'read_file', 'read_file_part', 'create_file', 'edit_file',
  'delete_file', 'make_directory', 'query_memory', 'get_memory_by_title', 'visit_web']

function _jsFsBase() {
  // 沙盒文档目录，保证有权限写
  try {
    if (plus && plus.io && plus.io.DocumentURL) return plus.io.DocumentURL
  } catch (e) {}
  return '/'
}

function _jsReadTextFile(filePath) {
  return new Promise(function(resolve) {
    plus.io.resolveLocalFileSystemURL(filePath, function(entry) {
      entry.file(function(file) {
        var reader = new plus.io.FileReader()
        reader.onloadend = function(evt) { resolve({ success: true, result: evt.target.result }) }
        reader.onerror = function(e) { resolve({ success: false, error: '读取失败: ' + (e.message || '') }) }
        reader.readAsText(file, 'utf-8')
      }, function(e) { resolve({ success: false, error: '打开文件失败: ' + (e.message || '') }) })
    }, function(e) { resolve({ success: false, error: '文件不存在: ' + (e.message || '') }) })
  })
}

function _jsWriteTextFile(filePath, content) {
  return new Promise(function(resolve) {
    plus.io.resolveLocalFileSystemURL(filePath, function(entry) {
      entry.createWriter(function(writer) {
        writer.onwrite = function() { resolve({ success: true, result: '已写入' }) }
        writer.onerror = function(e) { resolve({ success: false, error: '写入失败: ' + (e.message || '') }) }
        writer.write(content)
      }, function(e) { resolve({ success: false, error: '创建写入器失败: ' + (e.message || '') }) })
    }, function(e) { resolve({ success: false, error: '目标文件不可用: ' + (e.message || '') }) })
  })
}

function exec(actionType, params) {
  params = params || {}
  return new Promise(function(resolve) {
    // #ifndef APP-PLUS || APP
    resolve({ success: false, error: '仅支持 Android App 端' })
    return
    // #endif
    // #ifdef APP-PLUS || APP
    if (actionType === 'sleep') {
      var ms = Number(params.duration_ms != null ? params.duration_ms : params.ms != null ? params.ms : 1000)
      setTimeout(function() { resolve({ success: true, result: '已等待 ' + ms + 'ms' }) }, Math.max(0, Math.min(ms, 600000)))
      return
    }
    if (actionType === 'list_files') {
      var base = _jsFsBase()
      var dirPath = String(params.path != null ? params.path : base)
      plus.io.resolveLocalFileSystemURL(dirPath, function(entry) {
        var reader = entry.createReader()
        reader.readEntries(function(entries) {
          var list = []
          for (var i = 0; i < entries.length; i++) {
            var isDir = entries[i].isDirectory
            list.push({ name: entries[i].name, type: isDir ? 'dir' : 'file', path: entries[i].fullPath })
          }
          list.sort(function(a, b) { return (a.type === b.type) ? (a.name < b.name ? -1 : 1) : (a.type === 'dir' ? -1 : 1) })
          resolve({ success: true, result: list })
        }, function(e) { resolve({ success: false, error: '读取目录失败: ' + (e.message || '') }) })
      }, function(e) { resolve({ success: false, error: '目录不存在: ' + (e.message || '') }) })
      return
    }
    if (actionType === 'read_file' || actionType === 'read_file_part') {
      var fp = String(params.path || '')
      if (!fp) { resolve({ success: false, error: '缺少要读取的文件路径 path' }); return }
      _jsReadTextFile(fp).then(function(r) {
        if (!r.success) { resolve(r); return }
        var text = String(r.result || '')
        if (actionType === 'read_file_part') {
          var startLine = Number(params.start_line > 0 ? params.start_line : 1)
          var endLine = Number(params.end_line > 0 ? params.end_line : 50)
          var lines = text.split('\n')
          var out = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
          resolve({ success: true, result: out.join('\n'), result_meta: { total_lines: lines.length } })
          return
        }
        resolve({ success: true, result: text })
      })
      return
    }
    if (actionType === 'create_file' || actionType === 'edit_file') {
      var cfp = String(params.path || '')
      var content = String(params.new != null ? params.new : params.content != null ? params.content : '')
      if (!cfp) { resolve({ success: false, error: '缺少文件路径 path' }); return }
      if (actionType === 'edit_file') {
        var oldStr = String(params.old != null ? params.old : '')
        _jsReadTextFile(cfp).then(function(r) {
          if (!r.success) { resolve(r); return }
          var cur = String(r.result || '')
          if (oldStr && cur.indexOf(oldStr) > -1) {
            cur = cur.split(oldStr).join(String(params.new != null ? params.new : ''))
          } else {
            cur = cur + '\n' + content
          }
          _jsWriteTextFile(cfp, cur).then(resolve)
        })
        return
      }
      _jsWriteTextFile(cfp, content).then(resolve)
      return
    }
    if (actionType === 'delete_file') {
      var dfp = String(params.path || '')
      if (!dfp) { resolve({ success: false, error: '缺少要删除的文件路径 path' }); return }
      plus.io.resolveLocalFileSystemURL(dfp, function(entry) {
        entry.remove(function() { resolve({ success: true, result: '已删除' }) },
          function(e) { resolve({ success: false, error: '删除失败: ' + (e.message || '') }) })
      }, function(e) { resolve({ success: false, error: '文件不存在: ' + (e.message || '') }) })
      return
    }
    if (actionType === 'make_directory') {
      var mkPath = String(params.path || '')
      if (!mkPath) { resolve({ success: false, error: '缺少要创建的目录路径 path' }); return }
      var parent = mkPath.substring(0, mkPath.lastIndexOf('/'))
      var name = mkPath.substring(mkPath.lastIndexOf('/') + 1)
      plus.io.resolveLocalFileSystemURL(parent || _jsFsBase(), function(entry) {
        entry.getDirectory(name, { create: true }, function() { resolve({ success: true, result: '已创建目录' }) },
          function(e) { resolve({ success: false, error: '创建目录失败: ' + (e.message || '') }) })
      }, function(e) { resolve({ success: false, error: '上级目录不存在: ' + (e.message || '') }) })
      return
    }
    if (actionType === 'query_memory' || actionType === 'get_memory_by_title') {
      var keyword = String(params.query != null ? params.query : params.title != null ? params.title : '').toLowerCase()
      var limit = Number(params.limit > 0 ? params.limit : 10)
      var all = []
      try {
        var keys = uni.getStorageInfoSync().keys || []
        for (var k = 0; k < keys.length; k++) {
          if (keys[k].indexOf('chat_memories_') !== 0) continue
          var raw = uni.getStorageSync(keys[k])
          var mems = raw
          try { if (typeof raw === 'string') mems = JSON.parse(raw) } catch (e2) {}
          var arr = mems && mems.memories ? mems.memories : (Array.isArray(mems) ? mems : [])
          for (var m = 0; m < arr.length; m++) {
            var item = arr[m]
            var text = typeof item === 'string' ? item : (item && (item.content || item.raw || '')) || ''
            var label = typeof item === 'string' ? '' : (item && item.label) || ''
            if (keyword && text.toLowerCase().indexOf(keyword) === -1 && String(label).toLowerCase().indexOf(keyword) === -1) continue
            all.push({ title: label || text.split('\n')[0].substring(0, 40), content: text, ai: keys[k].replace('chat_memories_', '') })
          }
        }
      } catch (e3) { resolve({ success: false, error: '读取记忆库失败: ' + (e3.message || String(e3)) }); return }
      all = all.slice(0, limit)
      if (actionType === 'get_memory_by_title') {
        var title = String(params.title || '').toLowerCase()
        var hit = null
        for (var t = 0; t < all.length; t++) {
          if (String(all[t].title).toLowerCase().indexOf(title) > -1) { hit = all[t]; break }
        }
        resolve({ success: true, result: hit ? hit.content : '未找到标题包含「' + params.title + '」的记忆' })
        return
      }
      resolve({ success: true, result: all })
      return
    }
    if (actionType === 'visit_web') {
      var url = String(params.url || '')
      if (!url) { resolve({ success: false, error: '缺少要访问的网页 URL' }); return }
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      var timeout = Number(params.timeout_ms > 0 ? params.timeout_ms : 10000)
      uni.request({
        url: url,
        method: 'GET',
        timeout: timeout,
        success: function(res) {
          var body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
          var text = String(body || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          resolve({ success: true, result: text.substring(0, 2000), result_meta: { status_code: res.statusCode } })
        },
        fail: function(err) { resolve({ success: false, error: '访问网页失败: ' + (err.errMsg || '') }) }
      })
      return
    }
    resolve({ success: false, error: '未知 JS 工具: ' + actionType })
    // #endif
  })
}

/**
 * 构建步骤执行器
 * @param agent 可选，默认使用 common/agent.js
 * @returns function(actionType, params) => Promise<{success, result, error}>
 */
function buildStepRunner(agent) {
  var A = agent || getAgent()
  return function(actionType, params) {
    return new Promise(function(resolve) {
      // 吃醋巡查：定时采集 App 使用记录 → AI 判断情绪 → 正常关心/吃醋质问+冻结
      if (actionType === 'jealousy_patrol') {
        const whitelistStr = String(params.whitelist != null ? params.whitelist : '').trim()
        const whitelist = []
        if (whitelistStr) {
          const parts = whitelistStr.split(/[,，]/)
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i].trim()
            if (p) whitelist.push(p)
          }
        }
        const freeze = params.freeze === true || params.freeze === 'true' || params.freeze === '1'
        jealousyPatrol.patrol({ whitelist: whitelist, freezeApp: freeze }).then(function(res) {
          if (res && res.code === 0) {
            resolve({ success: true, result: (res.message || '吃醋巡查完成'), data: res })
          } else {
            resolve({ success: false, error: (res && res.msg) || '吃醋巡查失败' })
          }
        })
        return
      }
      // 发送消息：工作流主动给用户发 AI 消息（不依赖原生 Agent）
      if (actionType === 'send_message') {
        sendMessageAction(params).then(function(r) { resolve(r) })
        return
      }
      // 执行 shell 命令：优先 Shizuku，不可用时回退 root（execute_shell/execute_hidden_terminal_command 同源）
      if (actionType === 'exec_shell' || actionType === 'execute_shell' || actionType === 'execute_hidden_terminal_command') {
        var cmd = String(params.cmd != null ? params.cmd : params.command != null ? params.command : '').trim()
        if (!cmd) { resolve({ success: false, error: '缺少要执行的命令 cmd' }); return }
        // 智能转换：AI 若用 am start 打开应用，改走免权限的 start_app（Intent 兜底），避免无谓的 Shizuku 依赖
var amPkg = null
        var amAct = ''
        var amM = cmd.match(/^am\s+start.*?-p\s+([\w.]+)/)
        var amN = cmd.match(/^am\s+start.*?-n\s+([\w./]+)/)
        if (amM && amM[1]) {
          amPkg = amM[1]
        } else if (amN && amN[1]) {
          var npA = amN[1].split('/')
          amPkg = npA[0]
          if (npA[1]) amAct = npA[1]
        }
        if (amPkg) {
          var nPkg = resolvePackage(amPkg)
          if (nPkg) {
            // AI 用 am start 打开应用 → 走与 start_app 相同的「启动+验证+桌面点击兜底」流程
            // 复用闭包内逻辑：直接调用下面的启动执行器
            startAppExec(A, nPkg, amAct, function(r0) {
              resolve(r0)
            })
            return
          }
        }
        // #ifdef APP-PLUS || APP
        // 先等待原生模块初始化（exec_shell 依赖 Shizuku/root，未经 ready 直接调用会报未初始化）
        A.ready(function(ok) {
          if (!ok) {
            resolve({ success: false, error: '原生 Agent 不可用（' + A.getDiagnose() + '）' })
            return
          }
          A.execShell(cmd, function(err, res) {
            if (err) { resolve({ success: false, error: err.message }); return }
            var o = null
            try { o = typeof res === 'string' ? JSON.parse(res) : res } catch(e) {}
            if (!o) { resolve({ success: true, result: String(res) }); return }
            if (o.code === -1) { resolve({ success: false, error: o.msg || '执行失败' }); return }
            var text = ((o.out || '') + (o.err || '')).trim()
            resolve({ success: true, result: text || ('执行成功，退出码 ' + o.code) })
          })
        })
        // #endif
        // #ifndef APP-PLUS || APP
        resolve({ success: false, error: '仅支持 Android App 端' })
        // #endif
        return
      }
      // 纯 JS 动作
      if (engine.JS_ACTIONS.indexOf(actionType) > -1) {
        engine.defaultStepRunner(actionType, params).then(function(r) { resolve(r) })
        return
      }
 // 工具（文件/记忆/网页/sleep）— 纯前端实现，不依赖原生 Agent
      if (OPERIT_JS_TOOLS.indexOf(actionType) > -1) {
 exec(actionType, params).then(function(r) { resolve(r) })
        return
      }
 // 启动应用：优先 Shizuku am start（高权限层做法，前后台都能拉起）
      // 失败再回退 Intent 方式，绝不只靠 startActivity 一次碰运气
      if (actionType === 'start_app' || actionType === 'open_app' || actionType === 'launch_app') {
        var rawName = String(params.package_name != null ? params.package_name : '').trim()
        var pkgName = resolvePackage(rawName)
        if (!pkgName) { resolve({ success: false, error: '缺少要打开的应用 package_name' }); return }
        var actName = String(params.activity != null ? params.activity : '').trim()
        // #ifdef APP-PLUS || APP
        startAppExec(A, pkgName, actName, function(r0) { resolve(r0) }, rawName)
        // #endif
        // #ifndef APP-PLUS || APP
        resolve({ success: false, error: '仅支持 Android App 端' })
        // #endif
        return
      }
      var def = NATIVE_METHODS[actionType]
      if (!def) {
        resolve({ success: false, error: '未知动作: ' + actionType })
        return
      }
      // 等待原生模块就绪（处理启动初期/隐私弹窗后 init 尚未完成的时序问题），再执行
      A.ready(function(ok) {
        if (!ok) {
          resolve({ success: false, error: '原生 Agent 不可用（' + A.getDiagnose() + '），无法执行「' + actionType + '」' })
          return
        }
        var args = []
        ;(def.args || []).forEach(function(k) {
          var v = params[k] != null ? params[k] : ''
          // 打开/停止/检查应用时，把中文应用名（抖音/微信…）解析成包名
          if (k === 'package_name') v = resolvePackage(v)
          args.push(v)
        })
        args.push(function(err, parsed) {
          if (err) { resolve({ success: false, error: err.message }); return }
          // 结果格式化：优先展示人性化 msg；绝不让用户看到字面量 "null"/"undefined"
          var result = '完成'
          if (parsed != null) {
            if (typeof parsed === 'object') {
            if (parsed.out != null && parsed.out !== '') result = String(parsed.out)
            else if (parsed.data != null && parsed.data !== undefined) result = JSON.stringify(parsed.data)
            else if (parsed.msg != null) result = String(parsed.msg)
            else result = JSON.stringify(parsed)
              if (result === 'null' || result === 'undefined') result = '完成'
            } else {
              result = String(parsed)
            }
          }
          resolve({ success: true, result: result })
          // 通知类动作记录到 AI 主动消息中心（首页「AI主动消息」分类展示）
          recordNotifyToCenter(actionType, params)
        })
        try {
          A[def.m].apply(A, args)
        } catch (e) {
          resolve({ success: false, error: e.message })
        }
      })
    })
  }
}

// 编辑器只展示可用工具：过滤掉未实现的摆设（桌面端专属/未实现原生），避免列表里一堆"（不可用）"
var AVAILABLE_CATALOG = ACTION_CATALOG.filter(function(a) {
  return isActionAvailable(a.key)
})

// 原生动作执行成功后，把通知类动作记录到 AI 主动消息中心
function recordNotifyToCenter(actionType, params) {
  try {
    if (actionType === 'send_notification') {
      var mc = require('./stubs/message-center.js')
      var title = String(params && params.title != null ? params.title : '')
      var msg = String(params && params.message != null ? params.message : '')
      mc.default.addAiActiveMessage('', title || '工作流通知', msg, 'notify')
    }
  } catch (e) {}
}

export default {
  ACTION_CATALOG: AVAILABLE_CATALOG,
  getAction: getAction,
  isActionAvailable: isActionAvailable,
  buildStepRunner: buildStepRunner
}
