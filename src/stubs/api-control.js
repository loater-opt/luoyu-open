/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * api-control.js — 配置校验接口桩
 *
 * 本模块在落雨客户端中由宿主实现，用于在发起 AI 请求前校验用户的
 * API 配置是否可用。
 *
 * 本文件仅声明接口，不含实现。
 * 开源版本默认全部放行，即不做任何校验。
 */

/**
 * 校验配置是否允许使用。
 *
 * @param {Object}  config     用户的 API 配置
 * @param {boolean} hasVision  本次请求是否包含图片
 * @returns {null|{blocked: boolean, msg: string}}
 *          返回 null 表示放行；返回对象表示拦截，msg 为提示文案
 */
function check(config, hasVision) {
  // 开源版本：不做任何校验
  return null
}

/**
 * 刷新校验配置。
 * 开源版本为空实现——使用方可在此接入自己的配置来源。
 */
function refresh() {
  // 开源版本：无外部配置来源
}

export default {
  check: check,
  refresh: refresh
}
