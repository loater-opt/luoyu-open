/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * server-config.js — 服务端地址与功能开关接口桩
 *
 * 宿主环境（落雨 ActApp）里这个模块保存服务器地址、静态资源地址与各功能的开关状态；
 * 它属于宿主自有代码，不在本仓库的开源范围内，所以这里只提供一个最小实现：
 * **所有地址返回空串** —— 表示"不启用服务端接口"。
 *
 * 这样依赖它的模块（例如 api-adapter.js 里读取服务端下发的 AI 配置控制）会自动走
 * "拿不到配置就不拦截"的降级分支，不需要改任何业务代码。
 *
 * 使用方若需要真正的服务端接口，把下面几个方法改成返回自己的地址即可。
 */

const EMPTY_FEATURES = {
  register: false,
  member: false,
  donate: false,
  developerApply: false,
  bindThirdParty: false,
  webSearch: false,
  forum: false
}

export default {
  SERVER_BASE: '',
  OFFICIAL_SITE: '',
  DOCS_SITE: '',
  FORUM_SITE: '',
  STORAGE_KEY: 'server_config',
  FEATURES: EMPTY_FEATURES,

  /** 服务端根地址；空串表示不启用服务端接口 */
  getServerBase() { return '' },
  /** 接口地址前缀 */
  getApiBase() { return '' },
  /**
   * 拼接接口地址。返回空串时，调用方（api-adapter）会走"取不到配置就不拦截"的降级分支。
   * @param {string} path 例如 '/api-control'
   */
  apiUrl(path) { return '' },
  /** 拼接静态资源地址 */
  staticUrl(path) { return '' },
  /** 旧配置迁移（宿主行为，这里空实现） */
  migrateServerConfig() {},
  /** 功能开关：开源版本一律关闭，由使用方自行接管 */
  isEnabled(name) { return false },
  officialUrl(path) { return '' },
  forumUrl() { return '' },
  docsUrl(path) { return '' }
}
