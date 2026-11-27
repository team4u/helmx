/**
 * composer-shell-props（Composer 与 StandbyComposer 共用的 ComposerInputShell 属性组构建器）契约测试：
 * - draft：文本变化先写草稿、再按光标重检补全弹层；readOnly 缺省时不写入键（与 shell 的 `?? false` 语义一致）；
 *   keyup / click / paste 原样透传补全 hook 与附件 hook 的处理器身份，onKeyDown 来自调用方；
 * - dnd：五个拖放属性与附件 hook 同一引用；
 * - plusMenu：fileInputRef / 打开选择器 / change 绑定来自附件 hook，标签与其余菜单项来自调用方；
 * - completions：补全 hook 的状态与 pick / close 动作按 shell 的属性名一一映射（同一引用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildComposerCompletionGroup,
  buildComposerDndGroup,
  buildComposerDraftGroup,
  buildComposerPlusMenuGroup,
} from '../src/conversation/composer-shell-props.js'
import type { UseComposerAttachmentsResult } from '../src/conversation/use-composer-attachments.js'
import type { UseComposerCompletionsResult } from '../src/conversation/use-composer-completions.js'

const noop = (): void => {}
const openFilePicker = (): void => {}
const onPaste = (): void => {}
const onDragEnter = (): void => {}
const onDragOver = (): void => {}
const onDragLeave = (): void => {}
const onDrop = (): void => {}
const onFileInputChange = (): void => {}

const fileHandlers: UseComposerAttachmentsResult = {
  fileInputRef: { current: null },
  dragging: true,
  openFilePicker,
  onPaste,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileInputChange,
}

const handleTextareaKeyUp = (): void => {}
const handleTextareaClick = (): void => {}
const applySlashPick = (): void => {}
const closeSlashPopover = (): void => {}
const applyCompletionPick = (): void => {}
const closeCompletionPopover = (): void => {}

const completions: UseComposerCompletionsResult = {
  slashOpen: true,
  popoverQuery: 'sk',
  slashMenuItems: [{ id: 'skill:a', label: 'A' }],
  completionOpen: false,
  completionTrigger: '@',
  completionSnapshot: { hasSources: false, items: [], total: 0, truncated: false, loading: false, errors: [] },
  detectPopover: noop,
  handleTextareaKeyUp,
  handleTextareaClick,
  shouldDeferKeyToPopover: () => false,
  applySlashPick,
  closeSlashPopover,
  applyCompletionPick,
  closeCompletionPopover,
  resetPopovers: noop,
}

const textareaRef = { current: null }
const onKeyDown = (): void => {}

test('draft group: a text change writes the draft first and then re-detects popovers with the caret; handlers pass through by identity', { timeout: 60_000 }, () => {
  const calls: string[] = []
  const draft = buildComposerDraftGroup({
    textareaRef,
    ariaLabel: 'aria',
    value: 'hello',
    placeholder: 'ph',
    onDraftTextChange: (next) => {
      calls.push(`draft:${next}`)
    },
    onKeyDown,
    completions: {
      ...completions,
      detectPopover: (value, caret) => {
        calls.push(`detect:${value}@${caret}`)
      },
    },
    fileHandlers,
  })
  assert.ok(draft.textareaRef === textareaRef)
  assert.equal(draft.ariaLabel, 'aria')
  assert.equal(draft.value, 'hello')
  assert.equal(draft.placeholder, 'ph')
  assert.equal('readOnly' in draft, false, 'readOnly stays absent when unset (shell applies `?? false`)')
  assert.ok(draft.onKeyDown === onKeyDown)
  assert.ok(draft.onKeyUp === handleTextareaKeyUp)
  assert.ok(draft.onClick === handleTextareaClick)
  assert.ok(draft.onPaste === onPaste)
  draft.onTextChange('hello @al', 9)
  assert.deepEqual(calls, ['draft:hello @al', 'detect:hello @al@9'], 'the draft is persisted before popover detection')
  const readOnlyDraft = buildComposerDraftGroup({
    textareaRef,
    ariaLabel: 'aria',
    value: '',
    placeholder: 'ph',
    readOnly: true,
    onDraftTextChange: noop,
    onKeyDown,
    completions,
    fileHandlers,
  })
  assert.equal(readOnlyDraft.readOnly, true)
})

test('dnd group: the five drag attributes are the attachment hook handlers themselves', { timeout: 60_000 }, () => {
  const dnd = buildComposerDndGroup(fileHandlers)
  assert.equal(dnd.dragging, true)
  assert.ok(dnd.onDragEnter === onDragEnter)
  assert.ok(dnd.onDragOver === onDragOver)
  assert.ok(dnd.onDragLeave === onDragLeave)
  assert.ok(dnd.onDrop === onDrop)
})

test('plus menu: the file binding comes from the attachment hook while label, flags and menu content come from the caller', { timeout: 60_000 }, () => {
  const renderSlot = (): null => null
  const commands: [] = []
  const onRunCommand = (): void => {}
  const menu = buildComposerPlusMenuGroup(fileHandlers, {
    uploadButtonLabel: 'upload',
    uploadDisabled: true,
    renderSlot,
    commands,
    commandsDisabled: false,
    onRunCommand,
  })
  assert.ok(menu.fileInputRef === fileHandlers.fileInputRef)
  assert.ok(menu.onOpenFilePicker === openFilePicker)
  assert.ok(menu.onFileInputChange === onFileInputChange)
  assert.equal(menu.uploadButtonLabel, 'upload')
  assert.equal(menu.uploadDisabled, true)
  assert.ok(menu.renderSlot === renderSlot)
  assert.ok(menu.commands === commands)
  assert.equal(menu.commandsDisabled, false)
  assert.ok(menu.onRunCommand === onRunCommand)
  const standbyMenu = buildComposerPlusMenuGroup(fileHandlers, { uploadButtonLabel: 'choose', disabled: true })
  assert.equal(standbyMenu.disabled, true)
  assert.equal('commands' in standbyMenu, false, 'keys the caller did not set stay absent')
  assert.equal('uploadDisabled' in standbyMenu, false)
})

test('completion group: hook state and pick / close actions map one-to-one onto the shell prop names', { timeout: 60_000 }, () => {
  const group = buildComposerCompletionGroup(completions)
  assert.equal(group.slashOpen, true)
  assert.equal(group.popoverQuery, 'sk')
  assert.ok(group.slashMenuItems === completions.slashMenuItems)
  assert.ok(group.onPickSlash === applySlashPick)
  assert.ok(group.onCloseSlash === closeSlashPopover)
  assert.equal(group.completionOpen, false)
  assert.equal(group.completionTrigger, '@')
  assert.ok(group.completionSnapshot === completions.completionSnapshot)
  assert.ok(group.onPickCompletion === applyCompletionPick)
  assert.ok(group.onCloseCompletion === closeCompletionPopover)
})
