/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * jealousy-patrol.js — 功能模块接口桩
 *
 * 「吃醋巡查」：定时采集今日 App 使用记录，交由模型按人设判断情绪，
 * 正常则发关心消息、异常则发质问消息（可选冻结娱乐类应用）。
 *
 * ────────────────────────────────────────────────────────────
 * 本功能不在本仓库的开源范围内。
 * 本文件仅声明接口，不含实现。
 * ────────────────────────────────────────────────────────────
 *
 * 工作流的 `jealousy_patrol` 动作会调用本模块。
 * 使用方可自行实现，或直接删除该动作节点。
 */

function notImplemented(name) {
  return function () {
    throw new Error('[jealousy-patrol] 接口 ' + name + ' 需由宿主环境实现，开源版本不提供实现')
  }
}

/**
 * 执行一次巡查。
 *
 * @param {Object}   options
 * @param {string[]} options.whitelist  白名单应用（跳过检测）
 * @param {boolean}  options.freezeApp  是否在判定为"吃醋"时冻结娱乐类应用
 * @returns {Promise<{code: number, msg?: string, message?: string}>}
 *          code === 0 表示执行成功
 */
function patrol(options) {
  return Promise.resolve({
    code: -1,
    msg: '吃醋巡查功能不在本仓库的开源范围内'
  })
}

var jealousyPatrol = {
  patrol: patrol
}

export default jealousyPatrol
