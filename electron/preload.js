/* ════════════════════════════════════════════════════════════
   Save4 — preload.js（上下文桥）
   页面通过 window.Save4Desktop 调用桌面能力：
   - hide()            隐藏窗口到托盘
   - reminderHit(text) 提醒通知（窗口隐藏时弹系统通知+唤醒）
   - setInteractive(v) 覆盖层鼠标穿透开关
   - onRestore / onVisibility  主进程 → 页面事件
   ════════════════════════════════════════════════════════════ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const overlay = process.argv.includes('--save4-overlay=1');

contextBridge.exposeInMainWorld('Save4Desktop', {
  isDesktop: true,
  overlay: overlay,
  hide: () => ipcRenderer.send('app:hide'),
  reminderHit: (text) => ipcRenderer.send('app:reminder', text),
  setInteractive: (v) => ipcRenderer.send('app:interactive', !!v),
  onRestore: (cb) => ipcRenderer.on('app:restore', () => cb()),
  onVisibility: (cb) => ipcRenderer.on('app:visibility', (e, v) => cb(v)),
  // 数据导出/导入（系统文件对话框）
  exportData: (payload) => ipcRenderer.invoke('data:export', payload),
  importData: () => ipcRenderer.invoke('data:import'),
  // AI 聊天代理（主进程发请求，规避 CORS）
  aiChat: (opts) => ipcRenderer.invoke('ai:chat', opts)
});
