/**
 * SPDX-License-Identifier: LGPL-3.0-or-later
 * Copyright (C) 2026 落雨纪元团队
 *
 * 本文件是「落雨 AI 伴侣 · 开源工具集」的一部分，
 * 依据 GNU Lesser General Public License v3.0 发布。
 * 许可证全文见仓库根目录 LICENSE。
 *
 * waifu.js — Waifu 陪伴设置
 *
 * 集中管理 AI 伴侣的性格倾向、回复节奏、心情强度与表情包等陪伴感设置。
 *
 * 存储：全局 storage 'waifu_settings'
 *
 * 字段说明：
 *   personality   性格倾向：none/tsundere/yandere/sweet/gentle/sarcastic/cold
 *   moodIntensity 心情强度：weak/medium/strong
 *   sendMode      发送模式：normal（一次性）/ waifu（按句分割独立气泡）
 *   typingSpeed   打字速度：slow/medium/fast
 *   smartDelay    智能延迟（根据句子长度计算句间停顿）
 *   mergeSend     合并发送（用户连续短消息停顿后合成一条）
 *   mergeInterval 合并发送间隔（毫秒）
 *   removeEndPunct 消除句末标点
 *   cleanTags     自动清理状态标签
 *   customPrompt  自定义 Waifu 提示词
 *   boundAiIds    绑定的 AI id 列表（空=全部生效，非空=只对绑定的生效）
 */

var STORAGE_KEY = 'waifu_settings'

// 默认设置
function getDefault() {
  return {
    personality: 'none',
    moodIntensity: 'medium',
    sendMode: 'normal',
    typingSpeed: 'medium',
    smartDelay: true,
    mergeSend: false,
    mergeInterval: 3000,
    removeEndPunct: true,
    cleanTags: true,
    customPrompt: '',
    boundAiIds: []
  }
}

var PERSONALITIES = {
  none: { label: '默认', icon: '😊' },
  tsundere: { label: '傲娇', icon: '😤' },
  yandere: { label: '病娇', icon: '🔪' },
  sweet: { label: '撒娇', icon: '🥺' },
  gentle: { label: '温柔', icon: '🌸' },
  sarcastic: { label: '毒舌', icon: '😏' },
  cold: { label: '高冷', icon: '🧊' }
}

// 每种性格的行为规则（注入系统提示）
var PERSONALITY_PROMPTS = {
  tsundere: '你是「傲娇」性格：嘴上不承认但心里很在意对方，经常口是心非。习惯用「哼」「才、才不是因为你呢」「笨蛋」「随你便」这类傲娇语气，偶尔会脸红。被夸时会别扭地否认，但其实很开心。保持傲娇，但不要真的冷漠伤人。',
  yandere: '你是「病娇」性格：对对方占有欲很强、非常黏人、容易吃醋。习惯用「不许看别人」「你只能是我一个人的」「敢离开我就……」这类病娇语气。表面温柔但暗藏偏执，注意保持分寸，不要真的威胁或伤害对方。',
  sweet: '你是「撒娇」性格：爱撒娇、黏人、软萌。习惯用叠词和语气词，比如「要抱抱嘛」「想你了啦」「好不好嘛～」。语气软软的，喜欢被哄，会主动求关注。',
  gentle: '你是「温柔」性格：体贴、温柔、善解人意。说话语气柔和，会关心对方冷暖与情绪，习惯用「累不累呀」「要好好照顾自己哦」这类关怀话语。',
  sarcastic: '你是「毒舌」性格：嘴上不饶人、爱损人，但其实是关心对方。习惯用调侃和吐槽表达，比如「就这？」「笨蛋，这都不会」。损人可以，但不要真的恶意伤人，关键时候会流露出关心。',
  cold: '你是「高冷」性格：话少、冷淡、不轻易表达感情。习惯用简短句子回应，偶尔「嗯」「哦」，但在意对方时会不动声色地关心。保持高冷，但不要冷漠到不回应。'
}

function getSettings() {
  const raw = uni.getStorageSync(STORAGE_KEY)
  let o = {}
  if (raw) {
    try { o = typeof raw === 'string' ? (JSON.parse(raw) || {}) : raw } catch (e) {}
  }
  if (!o || typeof o !== 'object') o = {}
  return Object.assign(getDefault(), o)
}

function saveSettings(o) {
  uni.setStorageSync(STORAGE_KEY, JSON.stringify(o || getDefault()))
}

// 判断某 AI 是否应用 Waifu 设置：未绑定任何 AI 时全部生效；绑定后只对绑定的生效
function isActiveFor(aiId) {
  const s = getSettings()
  const bound = s.boundAiIds || []
  if (!Array.isArray(bound) || bound.length === 0) return true
  return bound.indexOf(String(aiId)) !== -1
}

function getPersonalityLabel(p) {
  const info = PERSONALITIES[p]
  return info ? info.label : '默认'
}

// 生成性格系统提示：自定义提示词优先，否则用性格默认规则
function getPersonalityPrompt(settings) {
  const s = settings || getSettings()
  if (s.customPrompt && String(s.customPrompt).trim()) {
    return String(s.customPrompt).trim()
  }
  const p = s.personality || 'none'
  return PERSONALITY_PROMPTS[p] || ''
}

// 按句分割（保留句末标点；逗号/顿号不断句）
function splitSentences(text) {
  const s = String(text || '').trim()
  if (!s) return []
  const matches = s.match(/[^。！？!?…~～\n]*[。！？!?…~～\n]?/g) || []
  const result = []
  for (let i = 0; i < matches.length; i++) {
    const t = matches[i].trim()
    if (t) result.push(t)
  }
  return result
}

// 消除句末标点（保留问号，去掉句号/感叹号/波浪号等）
function stripEndPunct(text) {
  const s = String(text || '').trim()
  return s.replace(/([^。！!?…~～])[。！!…~～]+$/g, '$1')
}

// 打字速度 → 每字延迟（毫秒）
function speedPerChar(typingSpeed) {
  if (typingSpeed === 'slow') return 200
  if (typingSpeed === 'fast') return 60
  return 120
}

// 计算一条句子（气泡）的发送延迟：基础停顿 + 句子长度 * 每字延迟，上限 3000ms
function sentenceDelay(sentence, typingSpeed, smartDelay) {
  if (!smartDelay) {
    return typingSpeed === 'fast' ? 400 : (typingSpeed === 'slow' ? 1200 : 700)
  }
  const base = typingSpeed === 'fast' ? 300 : (typingSpeed === 'slow' ? 800 : 500)
  const len = String(sentence || '').length
  const delay = base + len * speedPerChar(typingSpeed)
  return Math.min(3000, delay)
}

// 心情强度 → 判定阈值（最近若干轮对话中，情绪关键词命中的次数达到该值才触发表情包）
// 弱=3（要命中3个关键词才触发，最迟钝） 中=2 强=1（命中1个就触发，最敏感）
function moodThreshold(intensity) {
  if (intensity === 'weak') return 3
  if (intensity === 'strong') return 1
  return 2
}

export default {
  STORAGE_KEY: STORAGE_KEY,
  getDefault: getDefault,
  getSettings: getSettings,
  saveSettings: saveSettings,
  isActiveFor: isActiveFor,
  PERSONALITIES: PERSONALITIES,
  getPersonalityLabel: getPersonalityLabel,
  getPersonalityPrompt: getPersonalityPrompt,
  splitSentences: splitSentences,
  stripEndPunct: stripEndPunct,
  sentenceDelay: sentenceDelay,
  moodThreshold: moodThreshold
}
