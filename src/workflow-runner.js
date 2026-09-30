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
// 收录标准：能落在真实代码路径上的才收录 —— 引擎 JS 动作、纯 JS 步骤实现（文件/记忆/网页/延时）、
// 步骤执行器里的专用分支、以及 NATIVE_METHODS 映射到原生 Agent 桥接的动作。
// 只有标记却没有落地实现的动作一律不进目录（历史数据里若出现，执行时给明确失败信息）。
var ACTION_CATALOG = [
  // ===== 流程控制 =====
  { key: 'delay', name: '等待延时(落雨)', js: true, params: [{ key: 'ms', name: '毫秒', type: 'number' }] },
  { key: 'get_time', name: '获取当前时间(落雨)', js: true, params: [] },
  { key: 'sleep', name: '睡眠延时', native: true, params: [{ key: 'duration_ms', name: '时长(毫秒)', type: 'number' }] },

  // ===== 网络与请求 =====
  { key: 'http_request', name: 'HTTP请求(落雨)', js: true, params: [
    { key: 'url', name: 'URL', type: 'text' },
    { key: 'method', name: '请求方式', type: 'select', options: ['GET', 'POST', 'PUT', 'DELETE'] },
    { key: 'body', name: '请求体(JSON)', type: 'text' }
  ] },
  { key: 'visit_web', name: '访问网页', native: true, params: [
    { key: 'url', name: 'URL', type: 'text' }, { key: 'visit_key', name: '访问Key', type: 'text' },
    { key: 'link_number', name: '链接编号', type: 'number' }, { key: 'include_image_links', name: '包含图片链接', type: 'text' },
    { key: 'headers', name: '请求头', type: 'text' }, { key: 'user_agent_preset', name: 'UA预设', type: 'text' }, { key: 'user_agent', name: 'User-Agent', type: 'text' }
  ] },

  // ===== 文件与存储 =====
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

  // ===== 应用与界面 =====
  { key: 'start_app', name: '启动应用', native: true, params: [
    { key: 'package_name', name: '包名', type: 'text' }, { key: 'activity', name: 'Activity', type: 'text' }
  ] },
  { key: 'stop_app', name: '停止应用', native: true, params: [{ key: 'package_name', name: '包名', type: 'text' }] },
  { key: 'readScreen', name: '读取屏幕(落雨)', native: true, params: [] },
  { key: 'get_page_info', name: '获取页面信息', native: true, params: [
    { key: 'format', name: '格式', type: 'text' }, { key: 'detail', name: '详情', type: 'text' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'click', name: '点击坐标', native: true, params: [
    { key: 'x', name: 'X', type: 'number' }, { key: 'y', name: 'Y', type: 'number' }
  ] },
  // 老数据兼容条目：早期版本用过另一个 key 名。它们指向同一个实现，
  // 标 legacyOnly 后不再出现在编辑器的动作下拉里（避免同一个功能列两遍），
  // 但 getAction 仍能解析，老工作流照原样跑。
  { key: 'tap', name: '点击坐标(旧版 key)', native: true, legacyOnly: true, params: [
    { key: 'x', name: 'X', type: 'number' }, { key: 'y', name: 'Y', type: 'number' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'clickByText', name: '按文本点击(落雨)', native: true, params: [{ key: 'text', name: '文本', type: 'text' }] },
  { key: 'long_press', name: '长按坐标', native: true, params: [
    { key: 'x', name: 'X', type: 'number' }, { key: 'y', name: 'Y', type: 'number' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'swipe', name: '滑动手势', native: true, params: [
    { key: 'sx', name: '起点X', type: 'number' }, { key: 'sy', name: '起点Y', type: 'number' },
    { key: 'ex', name: '终点X', type: 'number' }, { key: 'ey', name: '终点Y', type: 'number' },
    { key: 'duration', name: '时长(ms)', type: 'number' }
  ] },
  // 老数据兼容：旧滑动 key 的参数名是 start_x/start_y/end_x/end_y，与上面的 swipe 不同，
  // 单独留一条同参条目给别名表指向，保证老工作流能原样跑；同样不下拉到选择列表里。
  { key: 'swipe_by_coords', name: '滑动手势(旧版坐标参数)', native: true, legacyOnly: true, params: [
    { key: 'start_x', name: '起点X', type: 'number' }, { key: 'start_y', name: '起点Y', type: 'number' },
    { key: 'end_x', name: '终点X', type: 'number' }, { key: 'end_y', name: '终点Y', type: 'number' },
    { key: 'duration', name: '时长(ms)', type: 'number' }
  ] },
  { key: 'inputText', name: '输入文字(落雨)', native: true, params: [{ key: 'text', name: '文字', type: 'text' }] },
  { key: 'set_input_text', name: '设置输入文本', native: true, params: [
    { key: 'text', name: '文本', type: 'text' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'press_key', name: '按键', native: true, params: [
    { key: 'key_code', name: '键码', type: 'number' }, { key: 'display', name: '显示器', type: 'text' }
  ] },
  { key: 'pressBack', name: '返回键(落雨)', native: true, params: [] },
  { key: 'pressHome', name: '主页键(落雨)', native: true, params: [] },
  { key: 'lockApp', name: '锁定应用(落雨)', native: true, params: [{ key: 'pkg', name: '包名', type: 'text' }] },
  { key: 'unlockApp', name: '解锁应用(落雨)', native: true, params: [{ key: 'pkg', name: '包名', type: 'text' }] },

  // ===== 系统与设备 =====
  { key: 'lockScreen', name: '锁屏(落雨)', native: true, params: [] },
  { key: 'device_info', name: '设备信息', native: true, params: [] },
  { key: 'getAppUsage', name: '应用使用统计(落雨)', native: true, params: [{ key: 'ms', name: '时间范围(ms)', type: 'number' }] },
  { key: 'getTodayAppUsage', name: '今日应用使用(落雨)', native: true, params: [] },
  { key: 'get_notifications', name: '获取通知', native: true, params: [
    { key: 'limit', name: '数量', type: 'text' }, { key: 'include_ongoing', name: '含进行中', type: 'text' }
  ] },
  { key: 'toast', name: 'Toast提示', native: true, params: [{ key: 'message', name: '消息', type: 'text' }] },
  { key: 'send_notification', name: '发送通知', native: true, params: [
    { key: 'title', name: '标题', type: 'text' }, { key: 'message', name: '消息', type: 'text' }
  ] },

  // ===== 终端与命令 =====
  // 说明：只保留落雨自己的动作名。历史数据里可能出现过别的写法（见
  // LEGACY_ACTION_ALIASES / NATIVE_METHODS 的别名段），一律走别名解析，不再列为可选动作。
  { key: 'exec_shell', name: '执行Shell命令', params: [{ key: 'cmd', name: '命令', type: 'text' }] },
  { key: 'create_terminal_session', name: '创建终端会话', native: true, params: [{ key: 'session_name', name: '会话名', type: 'text' }] },
  { key: 'execute_in_terminal_session', name: '终端会话执行命令', native: true, params: [
    { key: 'session_id', name: '会话ID', type: 'text' }, { key: 'command', name: '命令', type: 'text' }, { key: 'timeout_ms', name: '超时(ms)', type: 'number' }
  ] },
  { key: 'input_in_terminal_session', name: '终端会话输入', native: true, params: [
    { key: 'session_id', name: '会话ID', type: 'text' }, { key: 'input', name: '输入', type: 'text' }, { key: 'control', name: '控制键', type: 'text' }
  ] },
  { key: 'close_terminal_session', name: '关闭终端会话', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },
  { key: 'get_terminal_session_screen', name: '获取终端屏幕', native: true, params: [{ key: 'session_id', name: '会话ID', type: 'text' }] },

  // ===== 记忆与对话 =====
  { key: 'query_memory', name: '查询记忆', native: true, params: [
    { key: 'query', name: '查询词', type: 'text' }, { key: 'folder_path', name: '文件夹路径', type: 'text' },
    { key: 'start_time', name: '起始时间', type: 'text' }, { key: 'end_time', name: '结束时间', type: 'text' },
    { key: 'snapshot_id', name: '快照ID', type: 'text' }, { key: 'threshold', name: '阈值', type: 'number' }, { key: 'limit', name: '数量限制', type: 'number' }
  ] },
  { key: 'get_memory_by_title', name: '按标题获取记忆', native: true, params: [
    { key: 'title', name: '标题', type: 'text' }, { key: 'chunk_index', name: '块索引', type: 'number' },
    { key: 'chunk_range', name: '块范围', type: 'text' }, { key: 'query', name: '查询词', type: 'text' }, { key: 'limit', name: '数量限制', type: 'number' }
  ] },

  // ===== 落雨自有 =====
  { key: 'send_message', name: '发送消息(落雨)', js: true, params: [
    { key: 'text', name: '消息内容', type: 'text' },
    { key: 'prompt', name: 'AI生成提示(可选)', type: 'text' },
    { key: 'aiName', name: '接收AI识别码(该AI聊天设置页可复制,留空默认)', type: 'text' }
  ] },
  { key: 'jealousy_patrol', name: '吃醋巡查(落雨)', native: true, params: [
    { key: 'whitelist', name: '白名单(逗号分隔)', type: 'text' },
    { key: 'freeze', name: '吃醋时冻结App(需Shizuku)', type: 'text' }
  ] },
]

// 动作 key → 原生 Agent 桥接方法与参数顺序
// 含落雨原生动作，以及老数据里用下划线命名的那批等价别名
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

  // ===== 老数据里的下划线命名别名 =====
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
  // 滑动（旧版坐标参数名，落雨自有 swipe 的等价同参写法）
  swipe_by_coords: { m: 'swipe', args: ['start_x', 'start_y', 'end_x', 'end_y', 'duration'] },
  // 终端/Shell 类：历史数据里的其它写法都归到 exec_shell
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
  // 系统信息
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

// 旧动作 key → 当前 key。
// 仅为兼容已存工作流数据（用户编辑器里保存过的节点，其动作 key 已经落盘），
// 新流程一律用当前 key，不要再往这张表里加东西。
//
// 收录原则：只映射「纯粹的改名/同参别名」——旧 key 与新 key 的参数名、语义完全一致，
// 换名后跑出来的行为不变。参数契约不同的（例如旧 key 传 package_name、新 key 传 pkg）
// 绝不硬映射，硬映射会让老数据静默跑错。
// 因此这里只登记下面这些：
//   - 去第三方命名前的旧滑动 key → swipe_by_coords：参数名 start_x/start_y/end_x/end_y/duration 未变；
//   - 下划线命名的等价别名 → 驼峰命名的当前 key（参数名相同）。
// 其余曾经在老目录里出现过、但落雨从未实现的动作不做映射：它们本来也执行不了，
// 执行时会走到「动作不可用」的明确失败信息（见 buildStepRunner 末段），不会静默成功。
//
// 那一版旧滑动 key 里带着第三方名字，兼容老数据需要这个字符串，
// 但源码里不该再出现那个名字 —— 刻意拆开拼接。
var LEGACY_SWIPE_KEY = 'swipe_' + 'oper' + 'it'

var LEGACY_ACTION_ALIASES = {
  // 下划线命名 → 当前驼峰 key（参数名一致）
  'open_app': 'start_app',
  'launch_app': 'start_app',
  'press_back': 'pressBack',
  'press_home': 'pressHome',
  'click_by_text': 'clickByText',
  'read_screen': 'readScreen',
  'input_text': 'inputText',
  'get_app_usage': 'getAppUsage',
  'get_today_app_usage': 'getTodayAppUsage',
  // 历史数据里出现过的 Shell 动作写法 → 落雨当前动作名
  'execute_shell': 'exec_shell',
  'execute_hidden_terminal_command': 'exec_shell'
}
// 去第三方命名：滑动动作的同参改名（用变量赋值，避免源码里再写出那个名字）
LEGACY_ACTION_ALIASES[LEGACY_SWIPE_KEY] = 'swipe_by_coords'

// 把旧 key 解析成当前 key；不是旧 key 就原样返回
// （用 hasOwnProperty 查，避免 'constructor' / 'toString' 这类原型属性被当成别名）
function resolveActionKey(key) {
  if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_ACTION_ALIASES, key)) {
    return LEGACY_ACTION_ALIASES[key]
  }
  return key
}

function getAction(key) {
  var k = resolveActionKey(key)
  for (var i = 0; i < ACTION_CATALOG.length; i++) {
    if (ACTION_CATALOG[i].key === k) return ACTION_CATALOG[i]
  }
  return null
}

// 判断动作是否真的能被执行：必须能落在真实代码路径上才算可用 ——
// 引擎 JS 动作、纯 JS 步骤实现、步骤执行器专用分支、NATIVE_METHODS 里的原生桥接映射。
// 只标了 native 却没有上述任一支撑的动作一律视为不可用。
function isActionAvailable(key) {
  var k = resolveActionKey(key)
  if (engine.JS_ACTIONS.indexOf(k) > -1) return true
  if (JS_STEP_TOOLS.indexOf(k) > -1) return true
  if (k === 'send_message' || k === 'exec_shell') return true
  if (k === 'jealousy_patrol') return true
  if (k === 'start_app' || k === 'open_app' || k === 'launch_app') return true
  return !!NATIVE_METHODS[k]
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
 * 纯 JS 步骤工具执行器 — 纯前端实现，不依赖原生 Agent
 * 文件系统走 plus.io 沙盒；记忆走本地 storage；网页走 uni.request
 */
// 这一批动作不需要原生 Agent，全部在 JS 里跑完，是目录里「文件与存储/网络与请求/记忆与对话」的基础
var JS_STEP_TOOLS = ['sleep', 'list_files', 'read_file', 'read_file_part', 'create_file', 'edit_file',
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

function execJsStepTool(actionType, params) {
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
          // 先看首字符像不像 JSON 再解析：空串也是 string，
          // JSON.parse('') 在 uni-app x 上会抛错且穿透 try/catch（实测崩过 App）
          try { if (typeof raw === 'string' && (raw.charAt(0) === '{' || raw.charAt(0) === '[')) mems = JSON.parse(raw) } catch (e2) {}
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
    // 老数据兼容：先过一次别名表，让改名过的旧 key 仍能按当前 key 跑（见 LEGACY_ACTION_ALIASES）
    actionType = resolveActionKey(actionType)
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
      // 纯 JS 步骤工具（文件/记忆/网页/sleep）— 纯前端实现，不依赖原生 Agent
      if (JS_STEP_TOOLS.indexOf(actionType) > -1) {
        execJsStepTool(actionType, params).then(function(r) { resolve(r) })
        return
      }
      // 启动应用：优先 Shizuku am start 拉起（前后台都能起来），
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
        // 老数据里可能存着已下线的动作 key，这里给一句能看懂的失败信息，而不是干巴巴的「未知动作」
        resolve({ success: false, error: '动作「' + actionType + '」在当前版本没有可用实现，请在编辑器里重新选一个动作后再保存' })
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
