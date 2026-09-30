/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * message-center.js — 消息中心接口桩
 *
 * 宿主环境里这个模块负责把「AI 主动消息 / 推送消息 / 微信消息」落盘并在界面上展示；
 * 它属于宿主自有代码，不在本仓库的开源范围内。
 *
 * workflow-runner.js 只在「发送系统通知」这个动作成功后调用它的
 * addAiActiveMessage(...)，而且整段包在 try/catch 里 —— 所以这里给空实现即可，
 * 缺了也不影响工作流执行。
 *
 * 使用方可以按需实现下面这些成员；只要方法名保持，调用方不用改。
 */

function noop() {}

const messageCenter = {
  /** 新增一条推送消息；返回条数（开源版返回 0） */
  addPushMessage() { return 0 },
  /** 读取推送消息列表 */
  getPushMessages() { return [] },
  /** 记录 / 读取微信消息渠道状态 */
  setWechatStatus() {},
  getWechatStatus() { return {} },
  /** 新增 / 读取微信消息 */
  addWechatMessage() { return 0 },
  getWechatMessages() { return [] },
  /**
   * 新增一条 AI 主动消息（工作流里「发送通知」动作会调它）。
   * 参数：kind（分类，可空）、title、content、type
   */
  addAiActiveMessage() { return 0 },
  getAiActiveMessages() { return [] },
  // 保留一个显式空实现，便于使用方替换时对照
  _noop: noop
}

export default messageCenter
