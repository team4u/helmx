/**
 * 副作用模块：首次静态导入时即幂等注册 happy-dom 宿主。
 * 置于 DOM 测试文件首行导入，确保在 react-dom/client 与 Radix UI 加载前全局 DOM 已就绪，
 * 在 `--test-isolation=none` 任意文件执行顺序下都保持事件委托与浮层行为一致。
 */
import { ensureHappyDom } from './dom-harness.js'

ensureHappyDom()
