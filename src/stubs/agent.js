/**
 * agent.js — 宿主原生能力接口桩
 *
 * 本模块由宿主环境的 Android 原生层（Kotlin / UTS 插件）实现，
 * 负责应用启动、屏幕读取与操作、Shell 执行、系统通知等需要系统权限的能力。
 *
 * ────────────────────────────────────────────────────────────
 * 本文件仅声明接口，不含任何实现，也不在本仓库的开源范围内。
 * 使用方需根据自身宿主环境提供等价实现，或按需删除用不到的成员。
 * ────────────────────────────────────────────────────────────
 *
 * workflow-runner.js 中的原生动作会在执行时通过 getAgent() 取得本对象。
 * 若宿主未实现某个成员，调用时会抛出提示错误。
 */

function notImplemented(name) {
  return function () {
    throw new Error('[agent] 接口 ' + name + ' 需由宿主环境实现，开源版本不提供实现')
  }
}

/**
 * 判断原生能力是否可用（例如 Shizuku 是否已授权）。
 * 调用方通常先判断本方法，再决定走原生路径还是降级路径。
 *
 * @returns {boolean}
 */
function isAvailable() {
  // 开源版本默认视为不可用，宿主实现后应返回真实状态
  return false
}

var agent = {
  // ===== 能力探测 =====
  isAvailable: isAvailable,
  ready: notImplemented('ready'),

  // ===== 应用控制 =====
  startApp: notImplemented('startApp'),
  getForegroundApp: notImplemented('getForegroundApp'),

  // ===== 屏幕读取与操作 =====
  readScreen: notImplemented('readScreen'),
  click: notImplemented('click'),
  clickByText: notImplemented('clickByText'),
  pressHome: notImplemented('pressHome'),

  // ===== 命令与脚本 =====
  execShell: notImplemented('execShell'),
  js: notImplemented('js'),

  // ===== 系统能力 =====
  sendNotification: notImplemented('sendNotification'),
  getTodayAppUsage: notImplemented('getTodayAppUsage'),

  // ===== 诊断 =====
  getDiagnose: notImplemented('getDiagnose')
}

export default agent
